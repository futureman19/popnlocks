/*
 * POP-1 §2 — offer/match unit tests (WO-1).
 *
 * Covers quoteSchema.ts (parse/validate) and matchTx.ts (buildDeployTx →
 * makerSign → takerComplete) against the golden mainnet header fixture.
 * All keys are local and random (tests/utils/txHelper.ts), all UTXOs are
 * fabricated in memory, and nothing here touches the network or broadcasts:
 * "broadcast-ready" is proven by locally re-verifying both final ECDSA
 * signatures against their prevouts.
 */
import { expect } from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import { bsv } from 'scrypt-ts'
import { randomPrivateKey } from './utils/txHelper'
import { PopnlocksProductionMarket as PopnlocksMarket } from '../src/contracts/popnlocksProductionMarket'
import { MARKET_GEOMETRY } from '../src/offers/marketContract'
import {
    Quote,
    QuoteValidationError,
    parseQuote,
    quotePot,
    validateQuote,
} from '../src/offers/quoteSchema'
import {
    DUST_LIMIT,
    MATCH_SIGHASH,
    MatchTxError,
    MatchContext,
    UtxoRef,
    buildDeployTx,
    compileMarketLockingScriptHex,
    estimateDeployFee,
    makerSign,
    p2pkhScriptHex,
    takerComplete,
} from '../src/offers/matchTx'

// Golden anchor: real mainnet block 830000 (tests/fixtures/headers.json).
const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'headers.json'), 'utf8')
)
const ANCHOR_HEIGHT = fixture.anchor_height as number
const ANCHOR_TIP_HEX = fixture.anchor_internal_hex as string
const ANCHOR_BITS = Number(BigInt(fixture.all_bits[0] as string))
const STRIKE_TARGET = fixture.endpoint_target as string

const FEE_RATE = 100 // sat/KB
const MAKER_STAKE = 10000
const TAKER_STAKE = 10000
const BOUNTY = 1500 // POP-1 §3 crank bounty; must be below the pot
// Quote is live at CURRENT_HEIGHT: anchor buried 10 deep, 10 to expiry.
const CURRENT_HEIGHT = ANCHOR_HEIGHT + 10
const EXPIRY_HEIGHT = ANCHOR_HEIGHT + 20
const UTXO_VALUE = 100000

function keyPair() {
    const [key, , pkhBuf] = randomPrivateKey()
    return { key, pkh: pkhBuf.toString('hex') }
}

const maker = keyPair()
const taker = keyPair()

function makeQuote(makerSide: 'yes' | 'no' = 'yes'): Quote {
    return {
        quoteId: 'offerMatch-test-quote',
        market: {
            anchorHeight: ANCHOR_HEIGHT,
            anchorTipHex: ANCHOR_TIP_HEX,
            anchorBits: ANCHOR_BITS,
            window: 144, // production daily geometry
            strikeTarget: STRIKE_TARGET,
            bounty: BOUNTY,
        },
        makerSide,
        makerStake: MAKER_STAKE,
        takerStake: TAKER_STAKE,
        makerPKH: maker.pkh,
        expiryHeight: EXPIRY_HEIGHT,
    }
}

// Fabricated local P2PKH outpoint — never broadcast, never looked up.
function makeUtxo(pkh: string, txIdByte: string, satoshis: number): UtxoRef {
    return {
        txId: txIdByte.repeat(32),
        outputIndex: 0,
        satoshis,
        script: p2pkhScriptHex(pkh),
    }
}

function makerUtxoOf(): UtxoRef {
    return {
        ...makeUtxo(maker.pkh, '11', UTXO_VALUE),
        txId: '0123456789abcdef'.repeat(4),
    }
}

function takerUtxoOf(): UtxoRef {
    return {
        ...makeUtxo(taker.pkh, '22', UTXO_VALUE),
        txId: 'fedcba9876543210'.repeat(4),
    }
}

// Locally re-verify the ECDSA signature on a signed input against its
// prevout; also checks the <sig> <pubkey> shape and the sighash flag.
function inputSigVerifies(
    tx: bsv.Transaction,
    inputIndex: number,
    key: bsv.PrivateKey,
    utxo: UtxoRef
): boolean {
    const chunks = tx.inputs[inputIndex].script.chunks
    if (chunks.length !== 2 || !chunks[0].buf || !chunks[1].buf) {
        return false
    }
    const sigBuf = chunks[0].buf as Buffer
    if (sigBuf[sigBuf.length - 1] !== MATCH_SIGHASH) {
        return false
    }
    const sig = bsv.crypto.Signature.fromTxFormat(sigBuf)
    return bsv.Transaction.Sighash.verify(
        tx,
        // The bundled bsv d.ts mistypes this parameter as
        // Transaction.Signature; the runtime expects a crypto.Signature
        // (same cast as matchTx.ts).
        sig as unknown as bsv.Transaction.Signature,
        key.publicKey,
        inputIndex,
        bsv.Script.fromHex(utxo.script),
        new bsv.crypto.BN(utxo.satoshis)
    )
}

// Full POP-1 §2 match: maker builds + half-signs, taker completes.
function runMatchFlow(makerSide: 'yes' | 'no' = 'yes') {
    const quote = makeQuote(makerSide)
    const makerUtxo = makerUtxoOf()
    const takerUtxo = takerUtxoOf()
    const tx = buildDeployTx(
        quote,
        makerUtxo,
        takerUtxo,
        taker.pkh,
        FEE_RATE,
        CURRENT_HEIGHT
    )
    const halfSignedHex = makerSign(tx, maker.key, 0)
    const finalHex = takerComplete(halfSignedHex, taker.key, {
        acceptedQuote: quote,
        takerPrevouts: [takerUtxo],
        makerPrevouts: [makerUtxoOf()],
        feeRate: FEE_RATE,
        currentHeight: CURRENT_HEIGHT,
    })
    return { quote, makerUtxo, takerUtxo, halfSignedHex, finalHex }
}

function prevTxIdHex(tx: bsv.Transaction, inputIndex: number): string {
    return Buffer.from(tx.inputs[inputIndex].prevTxId).toString('hex')
}

describe('POP-1 §2 offer/match: deploy tx flow', () => {
    before(async () => {
        await PopnlocksMarket.loadArtifact()
    })

    it('runs buildDeployTx → makerSign → takerComplete into a broadcast-ready tx', () => {
        const { quote, makerUtxo, takerUtxo, finalHex } = runMatchFlow('yes')
        const tx = new bsv.Transaction(finalHex)

        // Canonical wire shape: 2 inputs (maker, taker), 3 outputs.
        expect(tx.toString()).to.equal(finalHex)
        expect(tx.inputs).to.have.length(2)
        expect(tx.outputs).to.have.length(3)
        expect(prevTxIdHex(tx, 0)).to.equal(makerUtxo.txId)
        expect(prevTxIdHex(tx, 1)).to.equal(takerUtxo.txId)

        // Covenant output: byte-exact fresh compile, exact pot.
        const covenantHex = compileMarketLockingScriptHex(quote, taker.pkh)
        expect(tx.outputs[0].script.toHex()).to.equal(covenantHex)
        expect(tx.outputs[0].satoshis).to.equal(quotePot(quote))

        // Deterministic fee split: maker pays ceil(fee/2), taker floor.
        const fee = estimateDeployFee(covenantHex.length / 2, FEE_RATE)
        expect(tx.outputs[1].script.toHex()).to.equal(p2pkhScriptHex(maker.pkh))
        expect(tx.outputs[1].satoshis).to.equal(
            makerUtxo.satoshis - MAKER_STAKE - Math.ceil(fee / 2)
        )
        expect(tx.outputs[2].script.toHex()).to.equal(p2pkhScriptHex(taker.pkh))
        expect(tx.outputs[2].satoshis).to.equal(
            takerUtxo.satoshis - TAKER_STAKE - Math.floor(fee / 2)
        )
        expect(tx.outputs[1].satoshis).to.be.at.least(DUST_LIMIT)
        expect(tx.outputs[2].satoshis).to.be.at.least(DUST_LIMIT)

        // Broadcast-ready: both inputs carry SIGHASH_ALL|FORKID signatures
        // that ECDSA-verify locally against their prevouts.
        expect(inputSigVerifies(tx, 0, maker.key, makerUtxo)).to.equal(true)
        expect(inputSigVerifies(tx, 1, taker.key, takerUtxo)).to.equal(true)
    })

    it('maps covenant yes/no PKHs per makerSide (no-side quote completes)', () => {
        const { quote, makerUtxo, takerUtxo, finalHex } = runMatchFlow('no')
        const tx = new bsv.Transaction(finalHex)

        const noCovenantHex = compileMarketLockingScriptHex(quote, taker.pkh)
        expect(tx.outputs[0].script.toHex()).to.equal(noCovenantHex)
        // Swapping the maker side must change the covenant (yesPKH/noPKH
        // are baked in as constructor props).
        const yesCovenantHex = compileMarketLockingScriptHex(
            makeQuote('yes'),
            taker.pkh
        )
        expect(noCovenantHex).to.not.equal(yesCovenantHex)
        expect(inputSigVerifies(tx, 0, maker.key, makerUtxo)).to.equal(true)
        expect(inputSigVerifies(tx, 1, taker.key, takerUtxo)).to.equal(true)
    })

    it('rejects a tampered covenant output before the taker signs', () => {
        const { quote, takerUtxo, halfSignedHex } = runMatchFlow('yes')
        const tx = new bsv.Transaction(halfSignedHex)
        // Maker bait-and-switch: a valid-looking covenant compiled from a
        // different strike target.
        const tamperedQuote: Quote = {
            ...quote,
            market: {
                ...quote.market,
                strikeTarget: (BigInt(STRIKE_TARGET) + 1n).toString(),
            },
        }
        tx.outputs[0] = new bsv.Transaction.Output({
            script: bsv.Script.fromHex(
                compileMarketLockingScriptHex(tamperedQuote, taker.pkh)
            ),
            satoshis: tx.outputs[0].satoshis,
        })
        expect(() =>
            takerComplete(tx.toString(), taker.key, {
                acceptedQuote: quote,
                takerPrevouts: [takerUtxo],
                makerPrevouts: [makerUtxoOf()],
                feeRate: FEE_RATE,
                currentHeight: CURRENT_HEIGHT,
            })
        ).to.throw(MatchTxError, /tampered covenant output/)
    })

    it('rejects a wrong pot (covenant value skimmed by one sat)', () => {
        const { quote, takerUtxo, halfSignedHex } = runMatchFlow('yes')
        const tx = new bsv.Transaction(halfSignedHex)
        tx.outputs[0] = new bsv.Transaction.Output({
            script: tx.outputs[0].script,
            satoshis: tx.outputs[0].satoshis - 1,
        })
        expect(() =>
            takerComplete(tx.toString(), taker.key, {
                acceptedQuote: quote,
                takerPrevouts: [takerUtxo],
                makerPrevouts: [makerUtxoOf()],
                feeRate: FEE_RATE,
                currentHeight: CURRENT_HEIGHT,
            })
        ).to.throw(MatchTxError, /wrong pot/)
    })

    it('rejects an expired quote at completion time', () => {
        const { quote, takerUtxo, halfSignedHex } = runMatchFlow('yes')
        expect(() =>
            takerComplete(halfSignedHex, taker.key, {
                acceptedQuote: quote,
                takerPrevouts: [takerUtxo],
                makerPrevouts: [makerUtxoOf()],
                feeRate: FEE_RATE,
                currentHeight: EXPIRY_HEIGHT, // reached expiry: stale
            })
        ).to.throw(QuoteValidationError, /expired/)
    })

    it('rejects a fee-rate disagreement (taker change mismatch)', () => {
        const { quote, takerUtxo, halfSignedHex } = runMatchFlow('yes')
        expect(() =>
            takerComplete(halfSignedHex, taker.key, {
                acceptedQuote: quote,
                takerPrevouts: [takerUtxo],
                makerPrevouts: [makerUtxoOf()],
                feeRate: FEE_RATE * 2,
                currentHeight: CURRENT_HEIGHT,
            })
        ).to.throw(MatchTxError, /taker change mismatch/)
    })

    it('requires a fresh height at build time and rejects expired quotes', () => {
        for (const height of [undefined, EXPIRY_HEIGHT]) {
            expect(() =>
                buildDeployTx(
                    makeQuote(),
                    makerUtxoOf(),
                    takerUtxoOf(),
                    taker.pkh,
                    FEE_RATE,
                    height as number
                )
            ).to.throw(QuoteValidationError)
        }
    })

    it('requires independently resolved maker funding and exact change', () => {
        const { quote, takerUtxo, makerUtxo, halfSignedHex } = runMatchFlow()
        const ctx: MatchContext = {
            acceptedQuote: quote,
            makerPrevouts: [makerUtxo],
            takerPrevouts: [takerUtxo],
            feeRate: FEE_RATE,
            currentHeight: CURRENT_HEIGHT,
        }
        expect(() =>
            takerComplete(halfSignedHex, taker.key, {
                ...ctx,
                makerPrevouts: [undefined as unknown as UtxoRef],
            })
        ).to.throw(MatchTxError, /makerUtxo must be an object/)
        expect(() =>
            takerComplete(halfSignedHex, taker.key, {
                ...ctx,
                makerPrevouts: [{ ...makerUtxo, txId: '33'.repeat(32) }],
            })
        ).to.throw(MatchTxError, /independently resolved maker UTXO/)
        expect(() =>
            takerComplete(halfSignedHex, taker.key, {
                ...ctx,
                makerPrevouts: [
                    { ...makerUtxo, satoshis: makerUtxo.satoshis + 1 },
                ],
            })
        ).to.throw(MatchTxError, /maker change mismatch/)
    })

    it('rejects a DER-valid maker signature made against a different prevout amount', () => {
        const quote = makeQuote()
        const makerUtxo = makerUtxoOf()
        const takerUtxo = takerUtxoOf()
        const tx = buildDeployTx(
            quote,
            makerUtxo,
            takerUtxo,
            taker.pkh,
            FEE_RATE,
            CURRENT_HEIGHT
        )
        const sig = bsv.Transaction.Sighash.sign(
            tx,
            maker.key,
            MATCH_SIGHASH,
            0,
            bsv.Script.fromHex(makerUtxo.script),
            new bsv.crypto.BN(makerUtxo.satoshis + 1)
        )
        tx.inputs[0].setScript(
            new bsv.Script('')
                .add(sig.toTxFormat())
                .add(maker.key.publicKey.toBuffer())
        )
        expect(() =>
            takerComplete(tx.toString(), taker.key, {
                acceptedQuote: quote,
                makerPrevouts: [makerUtxo],
                takerPrevouts: [takerUtxo],
                feeRate: FEE_RATE,
                currentHeight: CURRENT_HEIGHT,
            })
        ).to.throw(MatchTxError, /maker signature failed verification/)
    })

    it('rejects mismatched windows at build and completion', () => {
        const { quote, halfSignedHex, makerUtxo, takerUtxo } = runMatchFlow()
        const badQuote = {
            ...quote,
            market: {
                ...quote.market,
                window: Number(PopnlocksMarket.TOTAL) + 1,
            },
        }
        expect(() =>
            buildDeployTx(
                badQuote,
                makerUtxo,
                takerUtxo,
                taker.pkh,
                FEE_RATE,
                CURRENT_HEIGHT
            )
        ).to.throw(QuoteValidationError, /unsupported window/)
        expect(() =>
            takerComplete(halfSignedHex, taker.key, {
                acceptedQuote: badQuote,
                makerPrevouts: [makerUtxo],
                takerPrevouts: [takerUtxo],
                feeRate: FEE_RATE,
                currentHeight: CURRENT_HEIGHT,
            })
        ).to.throw(QuoteValidationError, /unsupported window/)
    })

    it('rejects altered taker funding amounts and non-singleton prevouts', () => {
        const { quote, halfSignedHex, makerUtxo, takerUtxo } = runMatchFlow()
        const ctx: MatchContext = {
            acceptedQuote: quote,
            makerPrevouts: [makerUtxo],
            takerPrevouts: [takerUtxo],
            feeRate: FEE_RATE,
            currentHeight: CURRENT_HEIGHT,
        }
        expect(() =>
            takerComplete(halfSignedHex, taker.key, {
                ...ctx,
                takerPrevouts: [
                    { ...takerUtxo, satoshis: takerUtxo.satoshis + 1 },
                ],
            })
        ).to.throw(MatchTxError, /taker change mismatch/)
        for (const prevouts of [undefined, [], [makerUtxo, makerUtxo]]) {
            expect(() =>
                takerComplete(halfSignedHex, taker.key, {
                    ...ctx,
                    makerPrevouts: prevouts as unknown as [UtxoRef],
                })
            ).to.throw(MatchTxError, /exactly one/)
        }
    })

    it('makerSign refuses a key that does not own the maker input', () => {
        const tx = buildDeployTx(
            makeQuote('yes'),
            makerUtxoOf(),
            takerUtxoOf(),
            taker.pkh,
            FEE_RATE,
            CURRENT_HEIGHT
        )
        expect(() => makerSign(tx, taker.key, 0)).to.throw(
            MatchTxError,
            /does not pay to the maker key/
        )
    })
})

describe('POP-1 §2 offer/match: quote schema', () => {
    it('derives all geometry from the bound contract, including its final endpoint', () => {
        expect(MARKET_GEOMETRY).to.deep.equal({
            total: Number(PopnlocksMarket.TOTAL),
            chunk: Number(PopnlocksMarket.CHUNK),
            endpointIndex: Number(PopnlocksMarket.ENDPOINT_IDX),
        })
        // Production daily geometry; POP-0 tests retain their separate class.
        expect(MARKET_GEOMETRY).to.deep.equal({
            total: 144,
            chunk: 48,
            endpointIndex: 143,
        })
    })

    it('validateQuote refuses shallow anchors and unsupported windows', () => {
        const quote = makeQuote('yes')
        expect(
            () => validateQuote(quote, ANCHOR_HEIGHT + 5) // 5 confs < 6
        ).to.throw(QuoteValidationError, /fewer than 6 confirmations/)

        const badWindow: Quote = {
            ...quote,
            market: { ...quote.market, window: 16 },
        }
        expect(() => validateQuote(badWindow, CURRENT_HEIGHT)).to.throw(
            QuoteValidationError,
            /unsupported window/
        )
    })

    it('rejects zero bounty and a pot exhausted by three production cranks', () => {
        for (const bounty of [0, 7000]) {
            const q = makeQuote()
            q.market.bounty = bounty
            expect(() => parseQuote(q)).to.throw(QuoteValidationError, /bounty/)
        }
    })

    it('parseQuote rejects malformed records and reports every issue', () => {
        try {
            parseQuote({})
            expect.fail('parseQuote({}) should have thrown')
        } catch (e) {
            const err = e as QuoteValidationError
            expect(err).to.be.instanceOf(QuoteValidationError)
            // One issue per missing/invalid field, not just the first.
            expect(err.issues.length).to.be.greaterThan(3)
        }

        const badStrike: Quote = {
            ...makeQuote('yes'),
            market: { ...makeQuote('yes').market, strikeTarget: '0x1234' },
        }
        expect(() => parseQuote(badStrike)).to.throw(
            QuoteValidationError,
            /strikeTarget/
        )
    })
})
