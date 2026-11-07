import { expect } from 'chai'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Maker, Config, Chain, Take } from '../maker/service'
import { Ledger } from '../maker/ledger'
import { p2pkhScriptHex, makerSign, takerComplete } from '../src/offers/matchTx'
import { bsv } from 'scrypt-ts'

// Disposable offline test keys only. No vault, network or broadcast.
const makerKey = bsv.PrivateKey.fromRandom('testnet')
const takerKey = bsv.PrivateKey.fromRandom('testnet')
const pkh = (k: bsv.PrivateKey) =>
    bsv.crypto.Hash.sha256ripemd160(k.publicKey.toBuffer()).toString('hex')
const makerPKH = pkh(makerKey),
    takerPKH = pkh(takerKey)
const coin = (id: string, owner: string, value = 30000) => ({
    txId: id.repeat(64),
    outputIndex: 0,
    satoshis: value,
    script: p2pkhScriptHex(owner),
})
async function declined(p: Promise<unknown>, code: string) {
    try {
        await p
        expect.fail('expected rejection ' + code)
    } catch (e) {
        expect((e as Error).message).eq(code)
    }
}
describe('maker service safety and daily scheduler', () => {
    let dir: string,
        config: Config,
        chain: Chain,
        m: Maker,
        calls: number,
        height: number,
        clock: number
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'pop-maker-'))
        height = 10086
        clock = 100000
        config = {
            live: false,
            makerPKH,
            pot: 20000,
            bounty: 1500,
            maxMarketStake: 20000,
            maxDailyExposure: 40000,
            maxCoinSats: 40000,
            killfile: join(dir, 'STOP_MAKER'),
        }
        chain = {
            height: async () => height,
            block: async (h) => ({
                height: h,
                hash: 'ab'.repeat(32),
                bits: 0x1d00ffff,
                target:
                    h % 288 === 144
                        ? '29655488820112440442472123979196390469611988612431580494751550406656'
                        : '26959535291011309493156476344723991336010898738574164086137773096960',
            }),
            coins: async () => [
                coin('2', makerPKH, 35000),
                coin('1', makerPKH),
            ],
            resolve: async (txid, vout, owner) => ({
                ...coin(txid[0], owner),
                outputIndex: vout,
            }),
        }
        calls = 0
        m = new Maker(
            config,
            chain,
            new Ledger(join(dir, 'holds.jsonl')),
            async (hex) => {
                calls++
                const tx = new bsv.Transaction(hex)
                tx.inputs[0].output = new bsv.Transaction.Output({
                    script: bsv.Script.fromHex(p2pkhScriptHex(makerPKH)),
                    satoshis: 30000,
                })
                return makerSign(tx, makerKey, 0)
            },
            () => clock
        )
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))
    const request = (m: Maker): Take => ({
        quoteId: m.quotes[0]?.quoteId || 'missing',
        takerPKH,
        takerInput: { txid: '3'.repeat(64), vout: 0 },
    })
    it('publishes both sides of Daily only, mature anchor, expiry before endpoint, bounty-aware odds', async () => {
        await m.refresh()
        expect(m.quotes).length(2)
        expect(m.quotes.map((q) => q.makerSide)).deep.eq(['no', 'yes'])
        for (const q of m.quotes) {
            expect(q.market.window).eq(144)
            expect(q.market.anchorHeight).eq(10080)
            expect(q.expiryHeight).eq(height + 3)
            expect(q.makerStake + q.takerStake).eq(config.pot)
            expect(q.takerStake).greaterThan(4500)
        }
        // Bounties must be recovered in each price, not erase the house spread.
        expect(
            m.quotes.reduce(
                (sum, q) => sum + (q.takerStake - 4500) / (config.pot - 4500),
                0
            )
        ).at.least(1.08)
    })
    it('regularizes finite-sample certainty so both sides remain quotable', async () => {
        chain.block = async (h) => ({
            height: h,
            hash: 'ab'.repeat(32),
            bits: 0x1d00ffff,
            target: '26959535291011309493156476344723991336010898738574164086137773096960',
        })
        await m.refresh()
        expect(m.quotes).length(2)
        expect(m.quotes.every((q) => q.makerStake > 0)).eq(true)
    })
    it('dry-run refuses before even chain resolution or signer invocation', async () => {
        await m.refresh()
        chain.height = async () => {
            throw new Error('must not resolve')
        }
        await declined(m.take(request(m)), 'DRY_RUN')
        expect(calls).eq(0)
    })
    it('killfile refuses signing even when enabled', async () => {
        config.live = true
        await m.refresh()
        writeFileSync(config.killfile, '')
        await declined(m.take(request(m)), 'STOPPED')
        expect(calls).eq(0)
    })
    it('rejects expired and wall-clock-stale quotes', async () => {
        config.live = true
        await m.refresh()
        const r = request(m)
        height += 3
        await declined(m.take(r), 'STALE_QUOTE')
        height -= 3
        clock += 90001
        await declined(m.take(r), 'STALE_QUOTE')
        expect(calls).eq(0)
    })
    it('rejects reorganized anchor before signing', async () => {
        config.live = true
        await m.refresh()
        chain.block = async (h) => ({
            height: h,
            hash: 'cd'.repeat(32),
            bits: 0x1d00ffff,
            target: '1',
        })
        await declined(m.take(request(m)), 'ANCHOR_CHANGED')
        expect(calls).eq(0)
    })
    it('declines exposure before signing', async () => {
        config.live = true
        config.maxMarketStake = 1
        await m.refresh()
        await declined(m.take(request(m)), 'MARKET_LIMIT')
        expect(calls).eq(0)
    })
    it('selects smallest suitable coin, verifies real offline half-signature, prevents replay', async () => {
        config.live = true
        await m.refresh()
        const r = request(m),
            q = m.quotes[0]
        const result = await m.take(r)
        expect(calls).eq(1)
        expect(() =>
            takerComplete(result.halfSignedTxHex, takerKey, {
                acceptedQuote: q,
                makerPrevouts: [coin('1', makerPKH)],
                takerPrevouts: [coin('3', takerPKH)],
                feeRate: 100,
                currentHeight: height,
            })
        ).not.throws()
        await declined(m.take(r), 'RESERVED')
    })
    it('keeps reservation on ambiguous vault failure', async () => {
        config.live = true
        m = new Maker(
            config,
            chain,
            m.ledger,
            async () => {
                throw new Error('VAULT_FAILED')
            },
            () => clock
        )
        await m.refresh()
        const r = request(m)
        await declined(m.take(r), 'VAULT_FAILED')
        expect(m.ledger.all()).length(1)
        await declined(m.take(r), 'RESERVED')
    })
    it('does not quote a completed window while next anchor matures', async () => {
        height = 10225
        await m.refresh()
        expect(m.quotes).length(0)
        height = 10230
        await m.refresh()
        expect(m.quotes[0].market.anchorHeight).eq(10224)
    })
})
