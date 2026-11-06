/*
 * POP-1 §2 — quote record type + validation for matched-pair markets.
 *
 * Quotes are data, not transactions: a maker publishes a quote on the
 * board, a taker takes it, and only then does matchTx.ts build the deploy
 * tx locking both stakes into the PopnlocksMarket covenant. This module is
 * the fail-closed gate in front of that flow — parse + validate every quote
 * before any transaction is constructed or signed. Hand-rolled checks: the
 * repo carries no validation dependency and POP-1 adds none.
 *
 * Shape (POP-1 §2, verbatim):
 *   { quoteId, market: {anchorHeight, anchorTipHex, anchorBits, window,
 *     strikeTarget, bounty}, makerSide: "yes"|"no", makerStake, takerStake,
 *     makerPKH, expiryHeight }
 *
 * Field conventions:
 * - anchorTipHex: 32-byte anchor block hash as 64 lowercase hex chars, in
 *   internal sha256d digest byte order (the byte order the covenant stores
 *   in its anchorTip prop — block explorers display the reversed digest).
 * - strikeTarget: 256-bit target as a canonical decimal string (JSON has
 *   no bigint). endpointTarget <= strikeTarget settles YES (POP-0 §2).
 * - makerPKH / takerPKH: 20-byte pubkey hashes, 40 lowercase hex chars.
 * - Stakes and bounty are satoshi amounts as safe integers bounded by
 *   MAX_SATS, so pot arithmetic never leaves integer range.
 * - expiryHeight: a quote is live iff currentHeight < expiryHeight
 *   (POP-1 §7: expiry is "a few blocks"; stale quotes are declined).
 *
 * validateQuote additionally enforces the liveness rules against a
 * caller-supplied currentHeight — this module never touches the network:
 * - quote not expired (currentHeight < expiryHeight);
 * - anchor buried >= MIN_ANCHOR_CONFIRMATIONS (POP-1 §2 anchor rule);
 * - market.window in SUPPORTED_WINDOWS, fail-closed. Only 16 today: the
 *   test geometry of src/contracts/popnlocksMarket.ts (TOTAL=16). WO-4's
 *   production artifact extends the set; do not add unsupported values.
 */

import { MARKET_GEOMETRY } from './marketContract'

/** Side of the market the maker is quoting. */
export type QuoteSide = 'yes' | 'no'

/** Market parameters of a quote — one per flagship market instance. */
export interface QuoteMarket {
    /** Block height of the anchor block. */
    anchorHeight: number
    /** Anchor block hash, 64 lowercase hex chars, sha256d digest order. */
    anchorTipHex: string
    /** Anchor block's compact bits (uint32) — base of the §4 Lite floor. */
    anchorBits: number
    /** Total post-anchor headers the covenant verifies (artifact TOTAL). */
    window: number
    /** 256-bit strike target as a canonical decimal string. */
    strikeTarget: string
    /** Satoshis carved from the pot for whoever cranks settlement. */
    bounty: number
}

/** A maker quote as published on the board (POP-1 §2 quote record). */
export interface Quote {
    quoteId: string
    market: QuoteMarket
    makerSide: QuoteSide
    /** Maker's stake in satoshis. */
    makerStake: number
    /** Required taker stake in satoshis. pot = makerStake + takerStake. */
    takerStake: number
    /** Maker payout pubkey hash, 40 lowercase hex chars. */
    makerPKH: string
    /** Quote is stale once the chain reaches this height. */
    expiryHeight: number
}

/**
 * Window values (total post-anchor headers) this library can deploy.
 * Fail-closed: anything else is rejected. 16 is the test geometry of the
 * protected covenant (TOTAL=16); production windows arrive with WO-4.
 */
export const SUPPORTED_WINDOWS: readonly number[] = Object.freeze([
    MARKET_GEOMETRY.total,
])

/** Minimum anchor depth at deploy (POP-1 §2 anchor rule, POP-0 §6). */
export const MIN_ANCHOR_CONFIRMATIONS = 6

/** Total BSV supply in satoshis — hard upper bound for any stake field. */
export const MAX_SATS = 2100000000000000

const MAX_QUOTE_ID_LENGTH = 128
const UINT256_MAX = (1n << 256n) - 1n
const HEX_64 = /^[0-9a-f]{64}$/
const HEX_40 = /^[0-9a-f]{40}$/
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/

/** Thrown by parseQuote/validateQuote; carries every problem found. */
export class QuoteValidationError extends Error {
    readonly issues: string[]

    constructor(issues: string[]) {
        super(`invalid quote: ${issues.join('; ')}`)
        this.name = 'QuoteValidationError'
        this.issues = issues
    }
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isPositiveInt(v: unknown): v is number {
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1
}

function isSats(v: unknown, min: number): v is number {
    return (
        typeof v === 'number' &&
        Number.isSafeInteger(v) &&
        v >= min &&
        v <= MAX_SATS
    )
}

/**
 * Structural parse: checks shape, types, formats, and self-contained
 * cross-field rules (bounty < pot). No chain context required.
 * Returns a typed Quote on success; throws QuoteValidationError listing
 * every problem found otherwise.
 */
export function parseQuote(raw: unknown): Quote {
    if (!isRecord(raw)) {
        throw new QuoteValidationError(['quote must be an object'])
    }
    const issues: string[] = []

    let quoteId: string | undefined
    if (typeof raw.quoteId !== 'string') {
        issues.push('quoteId must be a string')
    } else if (
        raw.quoteId.length === 0 ||
        raw.quoteId.length > MAX_QUOTE_ID_LENGTH ||
        raw.quoteId.trim() !== raw.quoteId
    ) {
        issues.push(
            `quoteId must be a trimmed string of 1..` +
                `${MAX_QUOTE_ID_LENGTH} chars`
        )
    } else {
        quoteId = raw.quoteId
    }

    let makerSide: QuoteSide | undefined
    if (raw.makerSide === 'yes' || raw.makerSide === 'no') {
        makerSide = raw.makerSide
    } else {
        issues.push('makerSide must be "yes" or "no"')
    }

    let makerStake: number | undefined
    if (isSats(raw.makerStake, 1)) {
        makerStake = raw.makerStake
    } else {
        issues.push(`makerStake must be an integer of 1..${MAX_SATS} sats`)
    }

    let takerStake: number | undefined
    if (isSats(raw.takerStake, 1)) {
        takerStake = raw.takerStake
    } else {
        issues.push(`takerStake must be an integer of 1..${MAX_SATS} sats`)
    }

    let makerPKH: string | undefined
    if (typeof raw.makerPKH === 'string' && HEX_40.test(raw.makerPKH)) {
        makerPKH = raw.makerPKH
    } else {
        issues.push(
            'makerPKH must be 40 lowercase hex chars (20-byte pubkey hash)'
        )
    }

    let expiryHeight: number | undefined
    if (isPositiveInt(raw.expiryHeight)) {
        expiryHeight = raw.expiryHeight
    } else {
        issues.push('expiryHeight must be a positive integer block height')
    }

    let anchorHeight: number | undefined
    let anchorTipHex: string | undefined
    let anchorBits: number | undefined
    let windowValue: number | undefined
    let strikeTarget: string | undefined
    let bounty: number | undefined

    const m = raw.market
    if (!isRecord(m)) {
        issues.push('market must be an object')
    } else {
        if (isPositiveInt(m.anchorHeight)) {
            anchorHeight = m.anchorHeight
        } else {
            issues.push('market.anchorHeight must be a positive integer')
        }

        if (typeof m.anchorTipHex === 'string' && HEX_64.test(m.anchorTipHex)) {
            anchorTipHex = m.anchorTipHex
        } else {
            issues.push(
                'market.anchorTipHex must be 64 lowercase hex chars ' +
                    '(32-byte anchor hash, sha256d digest byte order)'
            )
        }

        if (
            typeof m.anchorBits === 'number' &&
            Number.isSafeInteger(m.anchorBits) &&
            m.anchorBits >= 1 &&
            m.anchorBits <= 0xffffffff
        ) {
            anchorBits = m.anchorBits
        } else {
            issues.push('market.anchorBits must be a uint32 (1..0xffffffff)')
        }

        if (isPositiveInt(m.window)) {
            windowValue = m.window
        } else {
            issues.push('market.window must be a positive integer')
        }

        if (
            typeof m.strikeTarget === 'string' &&
            CANONICAL_DECIMAL.test(m.strikeTarget)
        ) {
            const target = BigInt(m.strikeTarget)
            if (target < 1n || target > UINT256_MAX) {
                issues.push('market.strikeTarget out of range (1..2^256-1)')
            } else {
                strikeTarget = m.strikeTarget
            }
        } else {
            issues.push(
                'market.strikeTarget must be a canonical decimal string ' +
                    '(no leading zeros, no hex prefix)'
            )
        }

        if (isSats(m.bounty, 0)) {
            bounty = m.bounty
        } else {
            issues.push(
                `market.bounty must be an integer of 0..${MAX_SATS} sats`
            )
        }
    }

    if (
        makerStake !== undefined &&
        takerStake !== undefined &&
        bounty !== undefined &&
        bounty >= makerStake + takerStake
    ) {
        issues.push(
            'market.bounty must be less than the pot ' +
                '(makerStake + takerStake)'
        )
    }

    if (issues.length > 0) {
        throw new QuoteValidationError(issues)
    }

    return {
        quoteId: quoteId as string,
        market: {
            anchorHeight: anchorHeight as number,
            anchorTipHex: anchorTipHex as string,
            anchorBits: anchorBits as number,
            window: windowValue as number,
            strikeTarget: strikeTarget as string,
            bounty: bounty as number,
        },
        makerSide: makerSide as QuoteSide,
        makerStake: makerStake as number,
        takerStake: takerStake as number,
        makerPKH: makerPKH as string,
        expiryHeight: expiryHeight as number,
    }
}

/**
 * Full validation: structural parse plus liveness rules checked against a
 * caller-supplied current chain height (expiry, anchor confirmations,
 * supported window). Callers resolve currentHeight independently — this
 * module performs no network access. matchTx.ts must re-validate with a
 * fresh height before building or completing any deploy transaction.
 */
export function validateQuote(raw: unknown, currentHeight: number): Quote {
    if (!isPositiveInt(currentHeight)) {
        throw new QuoteValidationError([
            'currentHeight must be a positive integer block height',
        ])
    }
    const quote = parseQuote(raw)
    const issues: string[] = []

    if (currentHeight >= quote.expiryHeight) {
        issues.push(
            `quote expired at height ${quote.expiryHeight} ` +
                `(current height ${currentHeight})`
        )
    }

    if (currentHeight - quote.market.anchorHeight < MIN_ANCHOR_CONFIRMATIONS) {
        issues.push(
            `anchor height ${quote.market.anchorHeight} has fewer than ` +
                `${MIN_ANCHOR_CONFIRMATIONS} confirmations at height ` +
                `${currentHeight}`
        )
    }

    if (!SUPPORTED_WINDOWS.includes(quote.market.window)) {
        issues.push(
            `unsupported window ${quote.market.window} ` +
                `(supported: ${SUPPORTED_WINDOWS.join(', ')})`
        )
    }

    if (issues.length > 0) {
        throw new QuoteValidationError(issues)
    }
    return quote
}

/** Non-throwing structural check. */
export function isQuote(raw: unknown): raw is Quote {
    try {
        parseQuote(raw)
        return true
    } catch {
        return false
    }
}

/** Total pot locked into the covenant at deploy. */
export function quotePot(quote: Quote): number {
    return quote.makerStake + quote.takerStake
}

/**
 * Map maker/taker pubkey hashes onto the covenant's yesPKH/noPKH props
 * per the maker's quoted side. Validates the taker-supplied PKH and
 * refuses self-matches (maker and taker keys identical).
 */
export function derivePKHs(
    quote: Quote,
    takerPKH: string
): { yesPKH: string; noPKH: string } {
    if (!HEX_40.test(takerPKH)) {
        throw new QuoteValidationError([
            'takerPKH must be 40 lowercase hex chars (20-byte pubkey hash)',
        ])
    }
    if (takerPKH === quote.makerPKH) {
        throw new QuoteValidationError([
            'takerPKH equals makerPKH: refusing a self-matched quote',
        ])
    }
    return quote.makerSide === 'yes'
        ? { yesPKH: quote.makerPKH, noPKH: takerPKH }
        : { yesPKH: takerPKH, noPKH: quote.makerPKH }
}
