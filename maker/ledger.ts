import {
    existsSync,
    readFileSync,
    openSync,
    writeSync,
    fsyncSync,
    closeSync,
} from 'fs'
export interface Hold {
    quoteId: string
    market: string
    coin: string
    stake: number
    at: number
}
function valid(h: Hold) {
    if (
        !h ||
        !['quoteId', 'market', 'coin'].every(
            (k) => typeof h[k] === 'string' && h[k].length > 0
        ) ||
        !Number.isSafeInteger(h.stake) ||
        h.stake <= 0 ||
        !Number.isSafeInteger(h.at) ||
        h.at < 0
    )
        throw new Error('LEDGER_CORRUPT')
}
/** Exclusive process lock is owned by CLI. Holds are never auto-released: a
 * returned/ambiguous half-signature can be broadcast long after quote expiry. */
export class Ledger {
    constructor(readonly file: string) {}
    all(): Hold[] {
        if (!existsSync(this.file)) return []
        const text = readFileSync(this.file, 'utf8')
        if (text && !text.endsWith('\n')) throw new Error('LEDGER_CORRUPT')
        return text
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const h = JSON.parse(line)
                valid(h)
                return h
            })
    }
    reserve(hold: Hold, maxMarket: number, maxDaily: number) {
        valid(hold)
        if (
            ![maxMarket, maxDaily].every(
                (n) => Number.isSafeInteger(n) && n > 0
            )
        )
            throw new Error('INVALID_LIMIT')
        const holds = this.all()
        if (
            holds.some(
                (h) => h.quoteId === hold.quoteId || h.coin === hold.coin
            )
        )
            throw new Error('RESERVED')
        if (
            holds
                .filter((h) => h.market === hold.market)
                .reduce((s, h) => s + h.stake, hold.stake) > maxMarket
        )
            throw new Error('MARKET_LIMIT')
        if (holds.reduce((s, h) => s + h.stake, hold.stake) > maxDaily)
            throw new Error('DAILY_LIMIT')
        const fd = openSync(this.file, 'a', 0o600)
        try {
            writeSync(fd, JSON.stringify(hold) + '\n')
            fsyncSync(fd)
        } finally {
            closeSync(fd)
        }
    }
}
