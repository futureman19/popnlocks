import { PopnlocksMarket } from '../contracts/popnlocksMarket'

/**
 * Local deployment binding. WO-4 owns switching this binding and its artifact
 * name to a reviewed production contract; never select code from a quote.
 * All geometry and constructor calls use this same class, so no offer logic
 * or numeric window allowlist needs changing with that binding.
 */
export const MarketContract = PopnlocksMarket
export const MARKET_ARTIFACT_NAME = 'popnlocksMarket.json'

/**
 * Artifact/class-defined geometry, not a promise that the endpoint is final.
 * Legacy test-only binding: 16 total headers, index 12 (13th header) endpoint,
 * chunks of 4; three headers follow the endpoint. No production tenor labels.
 */
export const MARKET_GEOMETRY = Object.freeze({
    total: Number(MarketContract.TOTAL),
    chunk: Number(MarketContract.CHUNK),
    endpointIndex: Number(MarketContract.ENDPOINT_IDX),
})

if (
    !Number.isSafeInteger(MARKET_GEOMETRY.total) ||
    !Number.isSafeInteger(MARKET_GEOMETRY.chunk) ||
    !Number.isSafeInteger(MARKET_GEOMETRY.endpointIndex) ||
    MARKET_GEOMETRY.total <= 0 ||
    MARKET_GEOMETRY.chunk <= 0 ||
    MARKET_GEOMETRY.total % MARKET_GEOMETRY.chunk !== 0 ||
    MARKET_GEOMETRY.endpointIndex < 0 ||
    MARKET_GEOMETRY.endpointIndex >= MARKET_GEOMETRY.total
) {
    throw new Error('Invalid local market contract geometry')
}
