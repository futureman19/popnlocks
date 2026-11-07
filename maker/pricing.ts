export function priceYes(
    history: number[],
    spot: number,
    strike: number,
    periods: number
): number {
    if (
        history.length < 3 ||
        [...history, spot, strike, periods].some(
            (v) => !Number.isFinite(v) || v <= 0
        )
    )
        throw new Error('invalid pricing observations')
    const returns = history.slice(1).map((v, i) => Math.log(v / history[i]))
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length
    const variance =
        returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (returns.length - 1)
    const distance = Math.log(strike / spot) - mean * periods
    if (variance < 1e-20) return distance >= 0 ? 1 : 0
    const z = distance / Math.sqrt(variance * periods)
    const t = 1 / (1 + 0.2316419 * Math.abs(z))
    const tail =
        (Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI)) *
        t *
        (0.31938153 +
            t *
                (-0.356563782 +
                    t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
    return Math.max(0, Math.min(1, z >= 0 ? 1 - tail : tail))
}
export function prices(p: number) {
    if (!Number.isFinite(p) || p < 0 || p > 1)
        throw new Error('invalid probability')
    return { yesAsk: Math.min(1, p + 0.04), noAsk: Math.min(1, 1 - p + 0.04) }
}
