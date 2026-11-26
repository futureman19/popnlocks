/**
 * QA-only adversarial safety probes (card t_de0eca7e).
 *
 * Additive negative tests over the POP-1 quote schema, match-transaction
 * library, maker service, and maker HTTP boundary. Every fixture is synthetic
 * and offline: disposable keys, fake chain, file-backed ledger in a temp dir,
 * loopback HTTP. No vault, network, broadcast, or product source changes.
 * Mirrors the construction patterns of the existing passing suites.
 */
import { expect } from 'chai'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { bsv } from 'scrypt-ts'
import {
    DUST_LIMIT,
    MatchContext,
    MatchTxError,
    UtxoRef,
    buildDeployTx,
    compileMarketLockingScriptHex,
    makerSign,
    p2pkhScriptHex,
    takerComplete,
} from '../src/offers/matchTx'
import {
    MAX_SATS,
    Quote,
    QuoteValidationError,
    derivePKHs,
    isQuote,
    parseQuote,
    quotePot,
    validateQuote,
} from '../src/offers/quoteSchema'
import { Maker, Config, Chain, Take } from '../maker/service'
import { Ledger } from '../maker/ledger'
import { server } from '../maker/http'

const pkhOf = (k: bsv.PrivateKey) =>
    bsv.crypto.Hash.sha256ripemd160(k.publicKey.toBuffer()).toString('hex')
const makerKey = bsv.PrivateKey.fromRandom('testnet')
const takerKey = bsv.PrivateKey.fromRandom('testnet')
const strangerKey = bsv.PrivateKey.fromRandom('testnet')
const makerPKH = pkhOf(makerKey)
const takerPKH = pkhOf(takerKey)
const strangerPKH = pkhOf(strangerKey)

const ANCHOR = 10080
const ANCHOR_TIP = 'ab'.repeat(32)
const ANCHOR_BITS = 0x1d00ffff
const STRIKE =
    '26959535291011309493156476344723991336010898738574164086137773096960'
const EXPIRY = 10090
const NOW_HEIGHT = 10086

function makeQuote(overrides: Record<string, unknown> = {}): Quote {
    return {
        quoteId: 'qa-adversarial-1',
        market: {
            anchorHeight: ANCHOR,
            anchorTipHex: ANCHOR_TIP,
            anchorBits: ANCHOR_BITS,
            window: 144,
            strikeTarget: STRIKE,
            bounty: 1500,
        },
        makerSide: 'no',
        makerStake: 9000,
        takerStake: 11000,
        makerPKH,
        expiryHeight: EXPIRY,
        ...overrides,
    } as unknown as Quote
}
const base = makeQuote()
const market = (patch: Record<string, unknown>) =>
    makeQuote({ market: { ...base.market, ...patch } })

const coin = (id: string, owner: string, value = 30000): UtxoRef => ({
    txId: id.repeat(64),
    outputIndex: 0,
    satoshis: value,
    script: p2pkhScriptHex(owner),
})
const makerUtxo = coin('1', makerPKH)
const takerUtxo = coin('3', takerPKH)
const ctx: MatchContext = {
    acceptedQuote: base,
    makerPrevouts: [makerUtxo],
    takerPrevouts: [takerUtxo],
    feeRate: 100,
    currentHeight: NOW_HEIGHT,
}
const deploy = () =>
    buildDeployTx(base, makerUtxo, takerUtxo, takerPKH, 100, NOW_HEIGHT)
const halfHex = () => makerSign(deploy(), makerKey, 0)
const complete = (hex: string, c: MatchContext = ctx) =>
    takerComplete(hex, takerKey, c)
const out = (script: bsv.Script, satoshis: number) =>
    new bsv.Transaction.Output({ script, satoshis })
async function rejects(p: Promise<unknown>, re: RegExp) {
    let err: unknown
    try {
        await p
    } catch (e) {
        err = e
    }
    expect(err, 'expected rejection ' + re).to.be.instanceOf(Error)
    expect((err as Error).message).to.match(re)
}
let ledgerSeq = 0

describe('QA adversarial: quote schema fail-closed', () => {
    it('accepts the synthetic fixture', () => {
        expect(isQuote(base)).to.equal(true)
        expect(() => parseQuote(base)).to.not.throw()
        expect(quotePot(base)).to.equal(20000)
    })
    it('rejects non-object roots', () => {
        for (const bad of [null, undefined, 42, 'quote', true, [], [base]]) {
            expect(() => parseQuote(bad), JSON.stringify(bad)).to.throw(
                QuoteValidationError
            )
            expect(isQuote(bad)).to.equal(false)
        }
    })
    it('rejects wrong primitive types per field', () => {
        const cases: Array<[string, unknown]> = [
            ['quoteId', 123],
            ['makerPKH', 5],
            ['makerSide', 'YES'],
            ['makerStake', '9000'],
            ['takerStake', 11000.5],
            ['expiryHeight', '20'],
        ]
        for (const [field, value] of cases) {
            expect(
                () => parseQuote({ ...base, [field]: value }),
                field
            ).to.throw(QuoteValidationError)
        }
    })
    it('rejects malformed market subfields (structural)', () => {
        const badMarkets: Array<Record<string, unknown>> = [
            { anchorHeight: 1.5 },
            { anchorTipHex: 'AB'.repeat(32) },
            { anchorTipHex: 'ab'.repeat(31) },
            { anchorBits: -1 },
            { strikeTarget: '0x1234' },
            { strikeTarget: '0123' },
            { bounty: 0 },
            { bounty: 20000 },
        ]
        for (const patch of badMarkets) {
            expect(
                () => parseQuote(market(patch)),
                JSON.stringify(patch)
            ).to.throw(QuoteValidationError)
        }
        expect(() => parseQuote({ ...base, market: null })).to.throw(
            QuoteValidationError
        )
    })
    it('rejects malformed identifiers', () => {
        expect(() =>
            parseQuote({ ...base, makerPKH: makerPKH.toUpperCase() })
        ).to.throw(/makerPKH/)
        expect(() => parseQuote({ ...base, quoteId: '' })).to.throw(
            QuoteValidationError
        )
        expect(() =>
            parseQuote({ ...base, quoteId: 'x'.repeat(129) })
        ).to.throw(QuoteValidationError)
    })
    it('rejects out-of-range stakes', () => {
        for (const v of [0, -1, 1.5, MAX_SATS + 1, Number.MAX_SAFE_INTEGER]) {
            expect(
                () => parseQuote({ ...base, makerStake: v }),
                'makerStake ' + v
            ).to.throw(QuoteValidationError)
            expect(
                () => parseQuote({ ...base, takerStake: v }),
                'takerStake ' + v
            ).to.throw(QuoteValidationError)
        }
        expect(
            quotePot({ ...base, makerStake: MAX_SATS, takerStake: 1 })
        ).to.equal(MAX_SATS + 1)
    })
    it('validateQuote rejects expiry, shallow anchor and unsupported window', () => {
        expect(() => validateQuote(base, EXPIRY)).to.throw(/expired/)
        expect(() => validateQuote(base, ANCHOR + 5)).to.throw(/confirmations/)
        expect(() => validateQuote(base, ANCHOR - 1)).to.throw(/confirmations/)
        expect(() =>
            validateQuote(market({ window: 16 }), NOW_HEIGHT)
        ).to.throw(/unsupported window/)
        expect(() =>
            validateQuote(market({ window: 1008 }), NOW_HEIGHT)
        ).to.throw(/unsupported window/)
        expect(() => validateQuote(base, NOW_HEIGHT)).to.not.throw()
    })
    it('derivePKHs maps sides correctly and refuses a self-match', () => {
        const d = derivePKHs(base, takerPKH) // makerSide 'no'
        expect(d.noPKH).to.equal(makerPKH)
        expect(d.yesPKH).to.equal(takerPKH)
        const yes = derivePKHs(makeQuote({ makerSide: 'yes' }), takerPKH)
        expect(yes.yesPKH).to.equal(makerPKH)
        expect(yes.noPKH).to.equal(takerPKH)
        expect(() => derivePKHs(base, makerPKH)).to.throw(/self-matched/)
    })
})

describe('QA adversarial: match-tx fail-closed', () => {
    it('happy path half-signs and completes to a 2-in/3-out tx', () => {
        const full = new bsv.Transaction(complete(halfHex()))
        expect(full.inputs).to.have.length(2)
        expect(full.outputs).to.have.length(3)
        expect(full.toString()).to.equal(full.toString().toLowerCase())
    })
    it('rejects non-canonical / malformed halfSignedHex', () => {
        expect(() => complete('zz')).to.throw(/even-length hex/)
        expect(() => complete('0')).to.throw(/even-length hex/)
        expect(() => complete('00')).to.throw(MatchTxError)
        expect(() => complete(halfHex() + '00')).to.throw(/not canonical/)
        expect(() => complete(halfHex().toUpperCase())).to.not.throw()
    })
    it('rejects wrong counts, locktime, sequence, already-signed taker, reused outpoint', () => {
        const counts = deploy()
        counts.inputs.splice(1, 1)
        expect(() => complete(makerSign(counts, makerKey, 0))).to.throw(
            /expected exactly 2 inputs and 3 outputs/
        )
        const lt = deploy()
        lt.nLockTime = 5
        expect(() => complete(makerSign(lt, makerKey, 0))).to.throw(
            /unexpected tx version or locktime/
        )
        const seq = deploy()
        seq.inputs[0].sequenceNumber = 0xfffffffe
        expect(() => complete(makerSign(seq, makerKey, 0))).to.throw(
            /unexpected input sequence number/
        )
        const signed = deploy()
        signed.inputs[1].setScript(bsv.Script.fromHex('00'))
        expect(() => complete(makerSign(signed, makerKey, 0))).to.throw(
            /taker input is already signed/
        )
        const reuse = deploy()
        ;(reuse.inputs[1] as unknown as { prevTxId: Buffer }).prevTxId =
            reuse.inputs[0].prevTxId
        expect(() => complete(makerSign(reuse, makerKey, 0))).to.throw(
            MatchTxError
        )
    })
    it('rejects wrong maker/taker outpoints from the match context', () => {
        expect(() =>
            complete(halfHex(), {
                ...ctx,
                takerPrevouts: [coin('4', takerPKH)] as [UtxoRef],
            })
        ).to.throw(/input 1 is not the taker UTXO supplied/)
        expect(() =>
            complete(halfHex(), {
                ...ctx,
                makerPrevouts: [coin('2', makerPKH)] as [UtxoRef],
            })
        ).to.throw(/input 0 is not the independently resolved maker UTXO/)
    })
    it('rejects invalid maker signatures', () => {
        expect(() => complete(deploy().toString())).to.throw(/half-signature/)
        const flip = new bsv.Transaction(halfHex())
        const fb = Buffer.from(flip.inputs[0].script.chunks[0].buf!)
        fb[fb.length - 1] = 0x01
        flip.inputs[0].setScript(
            new bsv.Script('')
                .add(fb as never)
                .add(flip.inputs[0].script.chunks[1].buf as never)
        )
        expect(() => complete(flip.toString())).to.throw(
            /SIGHASH_ALL\|SIGHASH_FORKID/
        )
        const der = new bsv.Transaction(halfHex())
        const db = Buffer.from(der.inputs[0].script.chunks[0].buf!)
        db[0] = 0x31
        der.inputs[0].setScript(
            new bsv.Script('')
                .add(db as never)
                .add(der.inputs[0].script.chunks[1].buf as never)
        )
        expect(() => complete(der.toString())).to.throw(/not valid DER/)
        const wrongPub = new bsv.Transaction(halfHex())
        wrongPub.inputs[0].setScript(
            new bsv.Script('')
                .add(wrongPub.inputs[0].script.chunks[0].buf as never)
                .add(strangerKey.publicKey.toBuffer() as never)
        )
        expect(() => complete(wrongPub.toString())).to.throw(
            /does not hash to makerPKH/
        )
        const crypto = new bsv.Transaction(halfHex())
        const cb = Buffer.from(crypto.inputs[0].script.chunks[0].buf!)
        cb[10] ^= 0xff
        crypto.inputs[0].setScript(
            new bsv.Script('')
                .add(cb as never)
                .add(crypto.inputs[0].script.chunks[1].buf as never)
        )
        expect(() => complete(crypto.toString())).to.throw(
            /maker signature failed verification/
        )
        expect(() => takerComplete(halfHex(), strangerKey, ctx)).to.throw(
            MatchTxError
        )
    })
    it('rejects covenant / pot / change tampering', () => {
        const cov = deploy()
        cov.outputs[0] = out(
            bsv.Script.fromHex(
                compileMarketLockingScriptHex(
                    makeQuote({ makerSide: 'yes' }),
                    takerPKH
                )
            ),
            cov.outputs[0].satoshis
        )
        expect(() => complete(makerSign(cov, makerKey, 0))).to.throw(
            /tampered covenant output/
        )
        const pot = deploy()
        pot.outputs[0] = out(pot.outputs[0].script, pot.outputs[0].satoshis + 1)
        expect(() => complete(makerSign(pot, makerKey, 0))).to.throw(
            /wrong pot/
        )
        const mc = deploy()
        mc.outputs[1] = out(
            bsv.Script.fromHex(p2pkhScriptHex(strangerPKH)),
            mc.outputs[1].satoshis
        )
        expect(() => complete(makerSign(mc, makerKey, 0))).to.throw(
            /maker change output does not pay makerPKH/
        )
        const md = deploy()
        md.outputs[1] = out(md.outputs[1].script, DUST_LIMIT - 1)
        expect(() => complete(makerSign(md, makerKey, 0))).to.throw(
            /maker change output is missing or dust/
        )
        const tc = deploy()
        tc.outputs[2] = out(
            bsv.Script.fromHex(p2pkhScriptHex(strangerPKH)),
            tc.outputs[2].satoshis
        )
        expect(() => complete(makerSign(tc, makerKey, 0))).to.throw(
            /taker change output does not pay the taker key/
        )
        const td = deploy()
        td.outputs[2] = out(td.outputs[2].script, DUST_LIMIT - 1)
        expect(() => complete(makerSign(td, makerKey, 0))).to.throw(
            /taker change mismatch/
        )
    })
    it('rejects stale height and mismatched prevout amount', () => {
        expect(() =>
            complete(halfHex(), { ...ctx, currentHeight: EXPIRY })
        ).to.throw(QuoteValidationError)
        expect(() =>
            complete(halfHex(), {
                ...ctx,
                takerPrevouts: [coin('3', takerPKH, base.takerStake)] as [
                    UtxoRef
                ],
            })
        ).to.throw(MatchTxError)
    })
})

describe('QA adversarial: maker service fail-closed', () => {
    let dir: string
    let config: Config
    let chain: Chain
    const clock = 100000
    const height = NOW_HEIGHT
    const attach = (tx: bsv.Transaction, owner: string) => {
        tx.inputs[0].output = out(
            bsv.Script.fromHex(p2pkhScriptHex(owner)),
            30000
        )
        return tx
    }
    const goodSigner = async (hex: string) =>
        makerSign(attach(new bsv.Transaction(hex), makerPKH), makerKey, 0)
    const mkMaker = (sign: (hex: string) => Promise<string>) =>
        new Maker(
            config,
            chain,
            new Ledger(join(dir, `holds-${++ledgerSeq}.jsonl`)),
            sign,
            () => clock
        )
    const req = (m: Maker, txid = '3'.repeat(64)): Take => ({
        quoteId: m.quotes[0].quoteId,
        takerPKH,
        takerInput: { txid, vout: 0 },
    })
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'pop-qa-'))
        config = {
            live: true,
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
                hash: ANCHOR_TIP,
                bits: ANCHOR_BITS,
                target: STRIKE,
            }),
            coins: async () => [coin('1', makerPKH)],
            resolve: async (txid, vout, owner) => ({
                ...coin(txid[0], owner),
                outputIndex: vout,
            }),
        }
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('refuses a take whose taker outpoint equals the maker coin (self-match)', async () => {
        const m = mkMaker(goodSigner)
        await m.refresh()
        await rejects(m.take(req(m, '1'.repeat(64))), /same outpoint/)
    })
    it('refuses a second take of the same quote (replay -> RESERVED)', async () => {
        const m = mkMaker(goodSigner)
        await m.refresh()
        const r = req(m)
        await m.take(r)
        await rejects(m.take(r), /RESERVED/)
    })
    it('refuses malformed take requests', async () => {
        const m = mkMaker(goodSigner)
        await m.refresh()
        await rejects(
            m.take({
                quoteId: m.quotes[0].quoteId,
                takerPKH: 'zz',
                takerInput: { txid: '3'.repeat(64), vout: 0 },
            }),
            /INVALID_REQUEST/
        )
        await rejects(
            m.take({
                quoteId: m.quotes[0].quoteId,
                takerPKH,
                takerInput: { txid: 'nothex', vout: 0 },
            }),
            /INVALID_REQUEST/
        )
    })
    it('rejects every malformed vault response (INVALID_VAULT_RESPONSE)', async () => {
        const variants: Array<(hex: string) => Promise<string>> = [
            async () => 'not-hex',
            async (hex) => hex,
            async (hex) => {
                const tx = new bsv.Transaction(hex)
                tx.inputs.splice(1, 1)
                return tx.toString()
            },
            async (hex) =>
                makerSign(
                    attach(new bsv.Transaction(hex), takerPKH),
                    takerKey,
                    0
                ),
            async (hex) => {
                const signed = new bsv.Transaction(
                    makerSign(
                        attach(new bsv.Transaction(hex), makerPKH),
                        makerKey,
                        0
                    )
                )
                const buf = Buffer.from(signed.inputs[0].script.chunks[0].buf!)
                buf[buf.length - 1] = 0x01
                signed.inputs[0].setScript(
                    new bsv.Script('')
                        .add(buf as never)
                        .add(signed.inputs[0].script.chunks[1].buf as never)
                )
                return signed.toString()
            },
            async (hex) => {
                const signed = new bsv.Transaction(
                    makerSign(
                        attach(new bsv.Transaction(hex), makerPKH),
                        makerKey,
                        0
                    )
                )
                signed.outputs[1] = out(
                    signed.outputs[1].script,
                    signed.outputs[1].satoshis + 1
                )
                return signed.toString()
            },
        ]
        for (const sign of variants) {
            const m = mkMaker(sign)
            await m.refresh()
            await rejects(m.take(req(m)), /INVALID_VAULT_RESPONSE/)
        }
    })
})

describe('QA adversarial: maker HTTP boundary', () => {
    const listen = (maker: unknown) => {
        const app = server(maker as Maker)
        return new Promise<{ app: ReturnType<typeof server>; base: string }>(
            (resolve) =>
                app.listen(0, '127.0.0.1', () =>
                    resolve({
                        app,
                        base: `http://127.0.0.1:${
                            (app.address() as { port: number }).port
                        }`,
                    })
                )
        )
    }
    it('maps an unknown internal error to 503 UNAVAILABLE, never leaks it', async () => {
        const { app, base } = await listen({
            view: () => ({ quotes: [], status: {} }),
            take: async () => {
                throw new Error('secret-internal-detail')
            },
        })
        try {
            const res = await fetch(base + '/take', {
                method: 'POST',
                body: '{}',
                headers: { 'Content-Type': 'application/json' },
            })
            expect(res.status).to.equal(503)
            const body = await res.text()
            expect(body).to.not.include('secret-internal-detail')
            expect(JSON.parse(body).error).to.equal('UNAVAILABLE')
        } finally {
            await new Promise<void>((r) => app.close(() => r()))
        }
    })
    it('unknown routes/methods 404, non-JSON content-type 415, OPTIONS 204', async () => {
        const { app, base } = await listen({
            view: () => ({ quotes: [], status: {} }),
            take: async () => ({ halfSignedTxHex: '00' }),
        })
        try {
            expect((await fetch(base + '/nope')).status).to.equal(404)
            expect(
                (await fetch(base + '/quotes', { method: 'POST' })).status
            ).to.equal(404)
            expect((await fetch(base + '/take')).status).to.equal(404)
            expect(
                (await fetch(base + '/quotes', { method: 'DELETE' })).status
            ).to.equal(404)
            expect(
                (
                    await fetch(base + '/take', {
                        method: 'POST',
                        body: '{}',
                        headers: { 'Content-Type': 'text/plain' },
                    })
                ).status
            ).to.equal(415)
            expect(
                (await fetch(base + '/take', { method: 'OPTIONS' })).status
            ).to.equal(204)
        } finally {
            await new Promise<void>((r) => app.close(() => r()))
        }
    })
})
