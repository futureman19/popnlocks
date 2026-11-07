import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { bsv } from 'scrypt-ts'
import { priceYes, prices } from './pricing'
import {
    buildDeployTx,
    compileMarketLockingScriptHex,
    estimateDeployFee,
    DUST_LIMIT,
    MATCH_SIGHASH,
} from '../src/offers/matchTx'
import { Quote, validateQuote } from '../src/offers/quoteSchema'
import { UtxoRef } from '../src/offers/matchTx'
import { Ledger } from './ledger'
export interface Block {
    height: number
    hash: string
    bits: number
    target: string
}
export interface Chain {
    height(): Promise<number>
    block(height: number): Promise<Block>
    coins(pkh: string): Promise<UtxoRef[]>
    resolve(txid: string, vout: number, pkh: string): Promise<UtxoRef>
}
export interface Config {
    live: boolean
    makerPKH: string
    pot: number
    bounty: number
    maxMarketStake: number
    maxDailyExposure: number
    maxCoinSats: number
    killfile: string
}
export interface Take {
    quoteId: string
    takerPKH: string
    takerInput: { txid: string; vout: number }
}
const key = (u: UtxoRef) => `${u.txId}:${u.outputIndex}`
export const FEE_RATE = 100
export class Maker {
    quotes: Quote[] = []
    refreshedAt = 0
    currentHeight = 0
    inventory = { sizedCoins: 0, availableCoins: 0, needsSplit: true }
    private busy = false
    constructor(
        readonly config: Config,
        readonly chain: Chain,
        readonly ledger: Ledger,
        readonly sign: (hex: string) => Promise<string>,
        readonly now = Date.now
    ) {
        if (
            !/^[0-9a-f]{40}$/.test(config.makerPKH) ||
            ![
                config.pot,
                config.bounty,
                config.maxMarketStake,
                config.maxDailyExposure,
                config.maxCoinSats,
            ].every(
                (n) => Number.isSafeInteger(n) && n > 0 && n <= 2100000000000000
            ) ||
            config.pot <= config.bounty * 3 + 1
        )
            throw new Error('INVALID_CONFIG')
    }
    stopped() {
        return existsSync(this.config.killfile)
    }
    private gate() {
        if (!this.config.live) throw new Error('DRY_RUN')
        if (this.stopped()) throw new Error('STOPPED')
    }
    async refresh() {
        this.quotes = []
        const height = await this.chain.height()
        const anchorHeight = Math.floor((height - 6) / 144) * 144
        this.currentHeight = height
        if (height >= anchorHeight + 144 || this.stopped()) return
        const anchor = await this.chain.block(anchorHeight)
        const spot = await this.chain.block(height)
        const history: number[] = []
        for (let i = 14; i >= 0; i--)
            history.push(
                Number((await this.chain.block(anchorHeight - i * 144)).target)
            )
        const modelP = priceYes(
            history,
            Number(spot.target),
            Number(anchor.target),
            (anchorHeight + 144 - height) / 144
        )
        // Fourteen observations do not establish certainty. Two symmetric
        // pseudo-observations shrink the estimate toward 1/2 before quoting.
        const observations = history.length - 1
        const p = (modelP * observations + 1) / (observations + 2)
        const asks = prices(p)
        const payout = this.config.pot - this.config.bounty * 3
        const quotes: Quote[] = (['no', 'yes'] as const).flatMap(
            (makerSide) => {
                // Recover all crank bounties in the price; spread applies to net payout.
                const takerStake =
                    this.config.bounty * 3 +
                    Math.ceil(
                        payout * (makerSide === 'no' ? asks.yesAsk : asks.noAsk)
                    )
                // No positive maker stake exists at saturated ask=1; do not misprice it.
                if (takerStake >= this.config.pot) return []
                const q: Quote = {
                    quoteId: '',
                    market: {
                        anchorHeight,
                        anchorTipHex: anchor.hash,
                        anchorBits: anchor.bits,
                        window: 144,
                        strikeTarget: anchor.target,
                        bounty: this.config.bounty,
                    },
                    makerSide,
                    makerStake: this.config.pot - takerStake,
                    takerStake,
                    makerPKH: this.config.makerPKH,
                    expiryHeight: Math.min(height + 3, anchorHeight + 144),
                }
                q.quoteId = createHash('sha256')
                    .update(JSON.stringify(q))
                    .digest('hex')
                return validateQuote(q, height)
            }
        )
        if (this.config.live) {
            const held = new Set(this.ledger.all().map((h) => h.coin))
            const coins = (await this.chain.coins(this.config.makerPKH)).filter(
                (u) => !held.has(key(u))
            )
            const dummy =
                this.config.makerPKH === '01'.repeat(20)
                    ? '02'.repeat(20)
                    : '01'.repeat(20)
            const sized = coins.filter(
                (u) =>
                    u.satoshis <= this.config.maxCoinSats &&
                    quotes.some(
                        (q) =>
                            u.satoshis >=
                            q.makerStake +
                                Math.ceil(
                                    estimateDeployFee(
                                        compileMarketLockingScriptHex(q, dummy)
                                            .length / 2,
                                        FEE_RATE
                                    ) / 2
                                ) +
                                DUST_LIMIT
                    )
            )
            this.inventory = {
                availableCoins: coins.length,
                sizedCoins: sized.length,
                needsSplit: sized.length === 0,
            }
        }
        this.quotes = quotes
        this.refreshedAt = this.now()
    }
    view() {
        const stopped = this.stopped()
        const stale = this.now() - this.refreshedAt > 90000
        return {
            quotes: stopped || stale ? [] : this.quotes,
            status: {
                mode: this.config.live ? 'live' : 'dry-run',
                stopped,
                stale,
                currentHeight: this.currentHeight,
                refreshedAt: this.refreshedAt,
                inventory: this.config.live ? this.inventory : null,
                feeRate: FEE_RATE,
            },
        }
    }
    async take(request: Take): Promise<{ halfSignedTxHex: string }> {
        this.gate()
        if (this.busy) throw new Error('BUSY')
        this.busy = true
        try {
            if (
                !request ||
                typeof request.quoteId !== 'string' ||
                !/^[0-9a-f]{40}$/.test(request.takerPKH) ||
                !request.takerInput ||
                !/^[0-9a-f]{64}$/.test(request.takerInput.txid) ||
                !Number.isSafeInteger(request.takerInput.vout) ||
                request.takerInput.vout < 0 ||
                request.takerInput.vout > 0xffffffff
            )
                throw new Error('INVALID_REQUEST')
            const holds = this.ledger.all()
            if (holds.some((h) => h.quoteId === request.quoteId))
                throw new Error('RESERVED')
            const q = this.quotes.find((q) => q.quoteId === request.quoteId)
            const fresh = (height: number) => {
                if (
                    !q ||
                    this.now() - this.refreshedAt > 90000 ||
                    height >= q.expiryHeight ||
                    height < q.market.anchorHeight + 6
                )
                    throw new Error('STALE_QUOTE')
            }
            fresh(await this.chain.height())
            const anchor = await this.chain.block(q.market.anchorHeight)
            if (
                anchor.hash !== q.market.anchorTipHex ||
                anchor.bits !== q.market.anchorBits ||
                anchor.target !== q.market.strikeTarget
            )
                throw new Error('ANCHOR_CHANGED')
            const taker = await this.chain.resolve(
                request.takerInput.txid,
                request.takerInput.vout,
                request.takerPKH
            )
            const script = compileMarketLockingScriptHex(q, request.takerPKH)
            const minCoin =
                q.makerStake +
                Math.ceil(estimateDeployFee(script.length / 2, FEE_RATE) / 2) +
                DUST_LIMIT
            const candidates = (await this.chain.coins(q.makerPKH))
                .filter(
                    (u) =>
                        u.satoshis >= minCoin &&
                        u.satoshis <= this.config.maxCoinSats &&
                        !holds.some((h) => h.coin === key(u))
                )
                .sort(
                    (a, b) =>
                        a.satoshis - b.satoshis || key(a).localeCompare(key(b))
                )
            if (!candidates.length) throw new Error('NO_SIZED_COIN')
            const chosen = candidates[0]
            const maker = await this.chain.resolve(
                chosen.txId,
                chosen.outputIndex,
                q.makerPKH
            )
            if (
                maker.satoshis !== chosen.satoshis ||
                maker.satoshis > this.config.maxCoinSats
            )
                throw new Error('COIN_CHANGED')
            const height = await this.chain.height()
            fresh(height)
            const tx = buildDeployTx(
                q,
                maker,
                taker,
                request.takerPKH,
                FEE_RATE,
                height
            )
            if (
                tx.outputs[0].script.toHex() !== script ||
                tx.outputs[0].satoshis !== q.makerStake + q.takerStake
            )
                throw new Error('COVENANT_MISMATCH')
            this.gate()
            this.ledger.reserve(
                {
                    quoteId: q.quoteId,
                    market: q.market.anchorTipHex,
                    coin: key(maker),
                    stake: q.makerStake,
                    at: this.now(),
                },
                this.config.maxMarketStake,
                this.config.maxDailyExposure
            )
            this.gate()
            const halfSignedTxHex = await this.sign(tx.toString())
            verifyHalfSigned(halfSignedTxHex, tx, maker, q.makerPKH)
            return { halfSignedTxHex }
        } finally {
            this.busy = false
        }
    }
}
/** Vault may add only a valid ALL|FORKID maker signature to the exact body. */
export function verifyHalfSigned(
    hex: string,
    unsigned: bsv.Transaction,
    maker: UtxoRef,
    pkh: string
) {
    if (!/^(?:[0-9a-f]{2})+$/.test(hex))
        throw new Error('INVALID_VAULT_RESPONSE')
    const signed = new bsv.Transaction(hex)
    if (signed.toString() !== hex || signed.inputs.length !== 2)
        throw new Error('INVALID_VAULT_RESPONSE')
    const chunks = signed.inputs[0].script.chunks
    if (
        chunks.length !== 2 ||
        !chunks[0].buf ||
        !chunks[1].buf ||
        chunks[0].buf[chunks[0].buf.length - 1] !== MATCH_SIGHASH ||
        bsv.crypto.Hash.sha256ripemd160(chunks[1].buf).toString('hex') !== pkh
    )
        throw new Error('INVALID_VAULT_RESPONSE')
    const valid = bsv.Transaction.Sighash.verify(
        signed,
        bsv.crypto.Signature.fromTxFormat(
            chunks[0].buf
        ) as unknown as bsv.Transaction.Signature,
        bsv.PublicKey.fromBuffer(chunks[1].buf),
        0,
        bsv.Script.fromHex(maker.script),
        new bsv.crypto.BN(maker.satoshis)
    )
    signed.inputs[0].setScript(new bsv.Script(''))
    if (!valid || signed.toString() !== unsigned.toString())
        throw new Error('INVALID_VAULT_RESPONSE')
}
