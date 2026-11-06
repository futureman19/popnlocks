/*
 * POP-1 §2 — matched-pair deploy transactions (the WO-1 matchTx library).
 *
 * Flow (POP-1 §2): the maker builds a deploy tx spending one maker UTXO and
 * one taker UTXO into the PopnlocksMarket covenant (pot = makerStake +
 * takerStake, yesPKH/noPKH per makerSide) plus change for both sides, signs
 * its own input, and hands the half-signed hex to the taker. The taker
 * re-derives the entire expected shape from the quote before signing, so a
 * tampered covenant output, a wrong pot, or an expired quote is refused
 * before the taker's funds can move. Either both fund or nothing moves.
 *
 * Wire conventions (both sides run this same code, so all of it is
 * deterministic and recomputed identically on both ends):
 * - Input order: input 0 = maker, input 1 = taker.
 * - Output order: output 0 = covenant (exactly pot sats), output 1 = maker
 *   change (P2PKH to makerPKH), output 2 = taker change (P2PKH to takerPKH).
 * - Signatures: SIGHASH_ALL|SIGHASH_FORKID (0x41) — POP-1 §2 says
 *   "SIGHASH_ALL"; on BSV the FORKID bit is consensus-mandatory.
 * - Fee: ceil(estimatedSignedSize * feeRate / 1000) with a fixed-size
 *   estimate (max-size 140-byte P2PKH unlocking scripts), split maker pays
 *   ceil(fee/2), taker pays floor(fee/2). The estimate never undershoots the
 *   final signed size, so the effective rate is always >= feeRate.
 * - Dust: a side whose change would fall below DUST_LIMIT fails the build
 *   instead of folding into the fee — folding would still be deterministic,
 *   but refusal keeps the change equation trivially auditable.
 *
 * "Fresh local compile" (takerComplete): the covenant locking script is
 * rebuilt locally on every call — the checked-in artifact of the protected
 * contract source (artifacts/popnlocksMarket.json) is instantiated with the
 * market params taken from the *quote*, never from the transaction under
 * inspection. Output 0's script must equal that compile byte for byte.
 *
 * Completion requires independently resolved maker and taker prevouts.
 * Raw transaction hex lacks their values: never infer them from its outputs.
 * Maker ECDSA verification, both outpoints, and both change amounts are
 * checked before signing. Callers must independently authenticate the quote,
 * prevouts, anchor, and fresh height; this library does not query a node.
 *
 * This module performs no network access and never broadcasts.
 */
import * as fs from 'fs'
import * as path from 'path'
import { bsv, ByteString, PubKeyHash, toByteString, Utils } from 'scrypt-ts'
import { MarketContract, MARKET_ARTIFACT_NAME } from './marketContract'
import {
    MAX_SATS,
    Quote,
    derivePKHs,
    quotePot,
    validateQuote,
} from './quoteSchema'

/** A spendable outpoint with its full prevout descriptor. */
export interface UtxoRef {
    /** Funding txid, 64 lowercase hex chars (display/big-endian order). */
    txId: string
    /** Output index within the funding tx. */
    outputIndex: number
    /** Value in satoshis. */
    satoshis: number
    /** Full locking script hex. v1 requires P2PKH to the party's PKH. */
    script: string
}

/**
 * Everything the taker needs to independently re-derive the expected deploy
 * tx shape before signing. `acceptedQuote` is re-validated (including expiry against
 * `currentHeight`) inside takerComplete — pass a freshly observed height.
 */
export interface MatchContext {
    /** The quote being taken (raw JSON or typed Quote; re-validated). */
    acceptedQuote: unknown
    /** Exactly one independently resolved maker prevout (v1). */
    makerPrevouts: readonly [UtxoRef]
    /** Exactly one independently resolved taker prevout (v1). */
    takerPrevouts: readonly [UtxoRef]
    /** Agreed fee rate in sat/KB (must equal what the maker used). */
    feeRate: number
    /** Freshly observed chain tip height. */
    currentHeight: number
}

/** Thrown for any deploy-tx shape/signature problem. */
export class MatchTxError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'MatchTxError'
    }
}

/** POP-1 §2 "SIGHASH_ALL" with the BSV-mandatory FORKID bit (0x41). */
export const MATCH_SIGHASH =
    bsv.crypto.Signature.SIGHASH_ALL | bsv.crypto.Signature.SIGHASH_FORKID

/** Canonical input positions in a deploy tx. */
export const MAKER_INPUT_INDEX = 0
export const TAKER_INPUT_INDEX = 1

/**
 * Minimum value for a change output. Deliberately conservative (the classic
 * 546-sat relay dust limit): a side whose change would be smaller fails the
 * build rather than folding the dust into the fee.
 */
export const DUST_LIMIT = 546

/** Sanity bounds on feeRate (sat/KB). 100_000 sat/KB = 100 sat/byte. */
const MIN_FEE_RATE = 1
const MAX_FEE_RATE = 100_000

/*
 * Worst-case signed P2PKH unlocking script: push(73-byte max sig incl. the
 * sighash byte) + push(65-byte uncompressed pubkey) = 1+73 + 1+65 = 140.
 * Reserve the uncompressed maximum because the builder receives only PKHs.
 */
const MAX_UNLOCKING_SCRIPT_BYTES = 140
/* Signed input: 32 prevTxId + 4 vout + 1 scriptLen varint + script + 4 seq. */
const SIGNED_INPUT_BYTES = 32 + 4 + 1 + MAX_UNLOCKING_SCRIPT_BYTES + 4
/* P2PKH output: 8 value + 1 varint + 25 script. */
const CHANGE_OUTPUT_BYTES = 34
/* 4 version + 1 input-count varint + 1 output-count varint + 4 locktime. */
const TX_OVERHEAD_BYTES = 10

const HEX_64 = /^[0-9a-f]{64}$/
const HEX_EVEN = /^([0-9a-f]{2})*$/
const SEQUENCE_FINAL = 0xffffffff

function varintBytes(n: number): number {
    return n < 253 ? 1 : n <= 0xffff ? 3 : 5
}

/**
 * Deterministic deploy fee: fixed-size estimate of the fully signed tx
 * (2 max-size P2PKH inputs, covenant output, 2 change outputs) at feeRate
 * sat/KB, rounded up. Never undershoots the real signed size.
 */
export function estimateDeployFee(
    covenantScriptBytes: number,
    feeRate: number
): number {
    const size =
        TX_OVERHEAD_BYTES +
        2 * SIGNED_INPUT_BYTES +
        (8 + varintBytes(covenantScriptBytes) + covenantScriptBytes) +
        2 * CHANGE_OUTPUT_BYTES
    return Math.ceil((size * feeRate) / 1000)
}

/** Maker pays the odd satoshi. */
function makerFeeShare(fee: number): number {
    return Math.ceil(fee / 2)
}

function takerFeeShare(fee: number): number {
    return Math.floor(fee / 2)
}

function checkFeeRate(feeRate: number): void {
    if (
        typeof feeRate !== 'number' ||
        !Number.isSafeInteger(feeRate) ||
        feeRate < MIN_FEE_RATE ||
        feeRate > MAX_FEE_RATE
    ) {
        throw new MatchTxError(
            `feeRate must be an integer of ${MIN_FEE_RATE}..` +
                `${MAX_FEE_RATE} sat/KB`
        )
    }
}

/** P2PKH locking script hex for a 20-byte pubkey hash (40 hex chars). */
export function p2pkhScriptHex(pkh: string): string {
    return Utils.buildPublicKeyHashScript(PubKeyHash(toByteString(pkh)))
}

function pubKeyHashOf(key: bsv.PrivateKey): string {
    return bsv.crypto.Hash.sha256ripemd160(key.publicKey.toBuffer()).toString(
        'hex'
    )
}

function assertUtxoRef(u: UtxoRef, name: string, expectedPKH: string): void {
    if (typeof u !== 'object' || u === null) {
        throw new MatchTxError(`${name} must be an object`)
    }
    if (typeof u.txId !== 'string' || !HEX_64.test(u.txId)) {
        throw new MatchTxError(`${name}.txId must be 64 lowercase hex chars`)
    }
    if (
        typeof u.outputIndex !== 'number' ||
        !Number.isSafeInteger(u.outputIndex) ||
        u.outputIndex < 0 ||
        u.outputIndex > 0xffffffff
    ) {
        throw new MatchTxError(`${name}.outputIndex must be a uint32`)
    }
    if (
        typeof u.satoshis !== 'number' ||
        !Number.isSafeInteger(u.satoshis) ||
        u.satoshis < 1 ||
        u.satoshis > MAX_SATS
    ) {
        throw new MatchTxError(
            `${name}.satoshis must be an integer of 1..${MAX_SATS}`
        )
    }
    if (typeof u.script !== 'string' || !HEX_EVEN.test(u.script)) {
        throw new MatchTxError(`${name}.script must be even-length hex`)
    }
    if (u.script !== p2pkhScriptHex(expectedPKH)) {
        throw new MatchTxError(
            `${name} must be a P2PKH UTXO paying the expected pubkey hash`
        )
    }
}

function isArtifactLoaded(): boolean {
    try {
        MarketContract.getArtifact()
        return true
    } catch {
        return false
    }
}

/*
 * Load the checked-in compile of the protected contract source. Resolved
 * relative to this file (src/offers -> repo artifacts/; dist/offers ->
 * repo artifacts/), never via cwd, so the library works from any process.
 */
function ensureMarketArtifact(): void {
    if (isArtifactLoaded()) {
        return
    }
    const artifactPath = path.join(
        __dirname,
        '..',
        '..',
        'artifacts',
        MARKET_ARTIFACT_NAME
    )
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
    MarketContract.loadArtifact(artifact)
}

/*
 * Off-chain mirror of the contract's bits2target, including its loop cap:
 * target = mantissa * 256^min(max(exponent-3, 0), 32).
 */
function bitsToTarget(bits: bigint): bigint {
    const exponent = bits / 16777216n
    const mantissa = bits % 8388608n
    const shifts =
        exponent > 3n ? (exponent - 3n > 32n ? 32n : exponent - 3n) : 0n
    return mantissa * 256n ** shifts
}

/**
 * Fresh local compile of the market covenant's locking script: instantiate
 * the checked-in artifact with params derived from the quote (PKHs mapped
 * per makerSide; ladder state initialized exactly as at deploy: tipHash =
 * anchor, headersSeen = 0, endpointTarget = 0, prevTarget = anchor target).
 * Validates takerPKH and refuses self-matches via derivePKHs.
 */
export function compileMarketLockingScriptHex(
    quote: Quote,
    takerPKH: string
): string {
    ensureMarketArtifact()
    const { yesPKH, noPKH } = derivePKHs(quote, takerPKH)
    const anchorTip = toByteString(quote.market.anchorTipHex) as ByteString
    const anchorBits = BigInt(quote.market.anchorBits)
    const instance = new MarketContract(
        anchorTip,
        BigInt(quote.market.strikeTarget),
        PubKeyHash(toByteString(yesPKH)),
        PubKeyHash(toByteString(noPKH)),
        BigInt(quote.market.bounty),
        anchorBits,
        anchorTip, // ladder starts at the anchor
        0n, // headersSeen
        0n, // endpointTarget
        bitsToTarget(anchorBits) // drift base starts at the anchor's target
    )
    return instance.markAsGenesis().lockingScript.toHex()
}

/**
 * Build the unsigned matched-pair deploy tx. `quote` is always re-parsed
 * structurally; the required fresh `currentHeight` enforces the
 * liveness rules (expiry, anchor depth, supported window) at build time —
 * the maker /take endpoint must do so (POP-1 §2 step 2, §7).
 *
 * Returns the unsigned bsv.Transaction with both prevouts attached (ready
 * for makerSign). Inputs: [maker, taker]. Outputs: [covenant(pot),
 * makerChange, takerChange].
 */
export function buildDeployTx(
    quote: Quote,
    makerUtxo: UtxoRef,
    takerUtxo: UtxoRef,
    takerPKH: string,
    feeRate: number,
    currentHeight: number
): bsv.Transaction {
    const q = validateQuote(quote, currentHeight)
    checkFeeRate(feeRate)
    const covenantHex = compileMarketLockingScriptHex(q, takerPKH)
    assertUtxoRef(makerUtxo, 'makerUtxo', q.makerPKH)
    assertUtxoRef(takerUtxo, 'takerUtxo', takerPKH)
    if (
        makerUtxo.txId === takerUtxo.txId &&
        makerUtxo.outputIndex === takerUtxo.outputIndex
    ) {
        throw new MatchTxError('maker and taker UTXOs are the same outpoint')
    }

    const pot = quotePot(q)
    const fee = estimateDeployFee(covenantHex.length / 2, feeRate)
    const makerChange = makerUtxo.satoshis - q.makerStake - makerFeeShare(fee)
    const takerChange = takerUtxo.satoshis - q.takerStake - takerFeeShare(fee)

    if (makerChange < 0) {
        throw new MatchTxError(
            'maker UTXO cannot cover makerStake + maker fee share'
        )
    }
    if (takerChange < 0) {
        throw new MatchTxError(
            'taker UTXO cannot cover takerStake + taker fee share'
        )
    }
    if (makerChange < DUST_LIMIT) {
        throw new MatchTxError(
            `maker change would be dust (${makerChange} < ${DUST_LIMIT});` +
                ' supply a larger maker UTXO'
        )
    }
    if (takerChange < DUST_LIMIT) {
        throw new MatchTxError(
            `taker change would be dust (${takerChange} < ${DUST_LIMIT});` +
                ' supply a larger taker UTXO'
        )
    }

    const tx = new bsv.Transaction()
    tx.from({ ...makerUtxo })
    tx.from({ ...takerUtxo })
    tx.addOutput(
        new bsv.Transaction.Output({
            script: bsv.Script.fromHex(covenantHex),
            satoshis: pot,
        })
    )
    tx.addOutput(
        new bsv.Transaction.Output({
            script: bsv.Script.fromHex(p2pkhScriptHex(q.makerPKH)),
            satoshis: makerChange,
        })
    )
    tx.addOutput(
        new bsv.Transaction.Output({
            script: bsv.Script.fromHex(p2pkhScriptHex(takerPKH)),
            satoshis: takerChange,
        })
    )

    // Self-verify: the covenant output must equal the fresh compile exactly.
    if (
        tx.outputs[0].script.toHex() !== covenantHex ||
        tx.outputs[0].satoshis !== pot
    ) {
        throw new MatchTxError(
            'internal error: built covenant output differs from the compile'
        )
    }
    return tx
}

/**
 * Sign the maker input of a deploy tx built by buildDeployTx and return the
 * half-signed tx hex. Refuses to sign an input whose prevout does not pay to
 * makerKey, an already-signed input, or an input without attached prevout
 * info. The signature is verified locally before returning.
 */
export function makerSign(
    tx: bsv.Transaction,
    makerKey: bsv.PrivateKey,
    inputIndex: number
): string {
    if (!(tx instanceof bsv.Transaction)) {
        throw new MatchTxError('tx must be a bsv.Transaction')
    }
    if (
        typeof inputIndex !== 'number' ||
        !Number.isSafeInteger(inputIndex) ||
        inputIndex < 0 ||
        inputIndex >= tx.inputs.length
    ) {
        throw new MatchTxError(
            `inputIndex must be an integer of 0..${tx.inputs.length - 1}`
        )
    }
    const input = tx.inputs[inputIndex]
    if (!input.output) {
        throw new MatchTxError(
            'input has no prevout info attached; build the tx with ' +
                'buildDeployTx (or tx.from) first'
        )
    }
    if (input.script.toBuffer().length > 0) {
        throw new MatchTxError(`input ${inputIndex} is already signed`)
    }
    const prevScript = input.output.script
    if (prevScript.toHex() !== p2pkhScriptHex(pubKeyHashOf(makerKey))) {
        throw new MatchTxError(
            'refusing to sign: input prevout does not pay to the maker key'
        )
    }
    const satoshis = new bsv.crypto.BN(input.output.satoshis)
    const sig = bsv.Transaction.Sighash.sign(
        tx,
        makerKey,
        MATCH_SIGHASH,
        inputIndex,
        prevScript,
        satoshis
    )
    input.setScript(
        // new Script('') == new Script(): the bundled d.ts requires an arg.
        new bsv.Script('')
            .add(sig.toTxFormat())
            .add(makerKey.publicKey.toBuffer())
    )
    const verified = bsv.Transaction.Sighash.verify(
        tx,
        // The bundled bsv d.ts mistypes this parameter as
        // Transaction.Signature; the runtime expects a crypto.Signature
        // (as returned by Sighash.sign above).
        sig as unknown as bsv.Transaction.Signature,
        makerKey.publicKey,
        inputIndex,
        prevScript,
        satoshis
    )
    if (!verified) {
        throw new MatchTxError(
            'internal error: fresh maker signature failed local verification'
        )
    }
    return tx.toString()
}

/**
 * Validate a half-signed deploy tx against the quote and sign the taker
 * input, returning the final (fully signed, broadcast-ready) tx hex.
 *
 * Refuses — before signing — any tx whose:
 * - quote is expired / anchor too shallow / window unsupported
 *   (QuoteValidationError from validateQuote against ctx.currentHeight);
 * - covenant output script differs from a fresh local compile of the
 *   quote's market params (tampered covenant);
 * - covenant output value differs from pot = makerStake + takerStake
 *   (wrong pot);
 * - input/output layout, taker funding outpoint, fee split, or change
 *   routing deviates from the deterministic wire conventions above;
 * - maker half-signature is missing, malformed, not SIGHASH_ALL|FORKID, or
 *   from a key other than makerPKH.
 *
 * The taker signature is verified locally before the hex is returned.
 */
export function takerComplete(
    halfSignedHex: string,
    takerKey: bsv.PrivateKey,
    matchContext: MatchContext
): string {
    if (typeof matchContext !== 'object' || matchContext === null) {
        throw new MatchTxError('ctx must be a MatchContext object')
    }
    if (
        !Array.isArray(matchContext.makerPrevouts) ||
        matchContext.makerPrevouts.length !== 1 ||
        !Array.isArray(matchContext.takerPrevouts) ||
        matchContext.takerPrevouts.length !== 1
    ) {
        throw new MatchTxError(
            'match context requires exactly one maker and one taker prevout'
        )
    }
    const ctx = {
        quote: matchContext.acceptedQuote,
        makerUtxo: matchContext.makerPrevouts[0],
        takerUtxo: matchContext.takerPrevouts[0],
        feeRate: matchContext.feeRate,
        currentHeight: matchContext.currentHeight,
    }
    // Expired quote, shallow anchor, unsupported window all throw here.
    const q = validateQuote(ctx.quote, ctx.currentHeight)
    checkFeeRate(ctx.feeRate)

    const takerPKH = pubKeyHashOf(takerKey)
    const covenantHex = compileMarketLockingScriptHex(q, takerPKH)
    assertUtxoRef(ctx.takerUtxo, 'ctx.takerUtxo', takerPKH)
    assertUtxoRef(ctx.makerUtxo, 'ctx.makerUtxo', q.makerPKH)

    const pot = quotePot(q)
    const fee = estimateDeployFee(covenantHex.length / 2, ctx.feeRate)
    const takerChange =
        ctx.takerUtxo.satoshis - q.takerStake - takerFeeShare(fee)
    if (takerChange < DUST_LIMIT) {
        throw new MatchTxError(
            'taker UTXO cannot cover takerStake + taker fee share at the ' +
                'agreed feeRate (change would be dust or negative)'
        )
    }

    if (
        typeof halfSignedHex !== 'string' ||
        !/^([0-9a-fA-F]{2})+$/.test(halfSignedHex)
    ) {
        throw new MatchTxError('halfSignedHex must be even-length hex')
    }
    let tx: bsv.Transaction
    try {
        tx = new bsv.Transaction(halfSignedHex)
    } catch {
        throw new MatchTxError('half-signed transaction does not parse')
    }
    // Canonical reserialization must be byte-identical: catches trailing
    // garbage and any non-canonical encoding the parser tolerated.
    if (tx.toString() !== halfSignedHex.toLowerCase()) {
        throw new MatchTxError('half-signed transaction is not canonical')
    }

    if (tx.inputs.length !== 2 || tx.outputs.length !== 3) {
        throw new MatchTxError(
            'expected exactly 2 inputs and 3 outputs ' +
                '(covenant, maker change, taker change)'
        )
    }
    // tx.version exists at runtime but is missing from the bundled d.ts.
    const version = (tx as unknown as { version: number }).version
    if (version !== 1 || tx.nLockTime !== 0) {
        throw new MatchTxError('unexpected tx version or locktime')
    }
    for (const inp of tx.inputs) {
        if (inp.sequenceNumber !== SEQUENCE_FINAL) {
            throw new MatchTxError('unexpected input sequence number')
        }
    }

    // Input 1 must spend exactly the taker outpoint from the context.
    const takerInput = tx.inputs[TAKER_INPUT_INDEX]
    const takerPrevTxId = Buffer.from(takerInput.prevTxId).toString('hex')
    if (
        takerPrevTxId !== ctx.takerUtxo.txId ||
        takerInput.outputIndex !== ctx.takerUtxo.outputIndex
    ) {
        throw new MatchTxError(
            'input 1 is not the taker UTXO supplied in the match context'
        )
    }
    if (takerInput.script.toBuffer().length !== 0) {
        throw new MatchTxError('taker input is already signed')
    }
    const makerInput = tx.inputs[MAKER_INPUT_INDEX]
    const makerPrevTxId = Buffer.from(makerInput.prevTxId).toString('hex')
    if (
        makerPrevTxId === ctx.takerUtxo.txId &&
        makerInput.outputIndex === ctx.takerUtxo.outputIndex
    ) {
        throw new MatchTxError('maker input reuses the taker outpoint')
    }

    if (
        makerPrevTxId !== ctx.makerUtxo.txId ||
        makerInput.outputIndex !== ctx.makerUtxo.outputIndex
    ) {
        throw new MatchTxError(
            'input 0 is not the independently resolved maker UTXO'
        )
    }

    // Validate maker signature encoding and ownership before ECDSA verification.
    const chunks = makerInput.script.chunks
    if (chunks.length !== 2 || !chunks[0].buf || !chunks[1].buf) {
        throw new MatchTxError(
            'maker input does not carry a <sig> <pubkey> half-signature'
        )
    }
    const sigBuf = chunks[0].buf as Buffer
    const pubBuf = chunks[1].buf as Buffer
    if (sigBuf[sigBuf.length - 1] !== MATCH_SIGHASH) {
        throw new MatchTxError(
            'maker signature is not SIGHASH_ALL|SIGHASH_FORKID'
        )
    }
    try {
        bsv.crypto.Signature.fromTxFormat(sigBuf)
    } catch {
        throw new MatchTxError('maker signature is not valid DER')
    }
    if (
        bsv.crypto.Hash.sha256ripemd160(pubBuf).toString('hex') !== q.makerPKH
    ) {
        throw new MatchTxError(
            'maker signature pubkey does not hash to makerPKH'
        )
    }

    // Covenant output: fresh local compile, exact pot.
    if (tx.outputs[0].script.toHex() !== covenantHex) {
        throw new MatchTxError(
            'covenant output script does not match a fresh local compile ' +
                'of the quote market params (tampered covenant output)'
        )
    }
    if (tx.outputs[0].satoshis !== pot) {
        throw new MatchTxError(
            `wrong pot: covenant holds ${tx.outputs[0].satoshis} sats, ` +
                `expected ${pot}`
        )
    }

    // Change routing and the deterministic fee split.
    if (tx.outputs[1].script.toHex() !== p2pkhScriptHex(q.makerPKH)) {
        throw new MatchTxError('maker change output does not pay makerPKH')
    }
    if (
        !Number.isSafeInteger(tx.outputs[1].satoshis) ||
        tx.outputs[1].satoshis < DUST_LIMIT
    ) {
        throw new MatchTxError('maker change output is missing or dust')
    }
    if (tx.outputs[2].script.toHex() !== p2pkhScriptHex(takerPKH)) {
        throw new MatchTxError('taker change output does not pay the taker key')
    }
    if (tx.outputs[2].satoshis !== takerChange) {
        throw new MatchTxError(
            `taker change mismatch: got ${tx.outputs[2].satoshis}, ` +
                `expected ${takerChange} ` +
                '(takerUtxo - takerStake - taker fee share)'
        )
    }

    const makerChange =
        ctx.makerUtxo.satoshis - q.makerStake - makerFeeShare(fee)
    if (tx.outputs[1].satoshis !== makerChange) {
        throw new MatchTxError('maker change mismatch')
    }
    let makerVerified = false
    try {
        makerVerified = bsv.Transaction.Sighash.verify(
            tx,
            bsv.crypto.Signature.fromTxFormat(
                sigBuf
            ) as unknown as bsv.Transaction.Signature,
            bsv.PublicKey.fromBuffer(pubBuf),
            MAKER_INPUT_INDEX,
            bsv.Script.fromHex(ctx.makerUtxo.script),
            new bsv.crypto.BN(ctx.makerUtxo.satoshis)
        )
    } catch {
        throw new MatchTxError('maker signature failed verification')
    }
    if (!makerVerified) {
        throw new MatchTxError('maker signature failed verification')
    }

    // All checks passed — sign the taker input.
    const subscript = bsv.Script.fromHex(ctx.takerUtxo.script)
    const satoshis = new bsv.crypto.BN(ctx.takerUtxo.satoshis)
    const sig = bsv.Transaction.Sighash.sign(
        tx,
        takerKey,
        MATCH_SIGHASH,
        TAKER_INPUT_INDEX,
        subscript,
        satoshis
    )
    takerInput.setScript(
        new bsv.Script('')
            .add(sig.toTxFormat())
            .add(takerKey.publicKey.toBuffer())
    )
    const verified = bsv.Transaction.Sighash.verify(
        tx,
        // Same d.ts mistyping as in makerSign; runtime wants crypto.Signature.
        sig as unknown as bsv.Transaction.Signature,
        takerKey.publicKey,
        TAKER_INPUT_INDEX,
        subscript,
        satoshis
    )
    if (!verified) {
        throw new MatchTxError(
            'internal error: fresh taker signature failed local verification'
        )
    }
    return tx.toString()
}
