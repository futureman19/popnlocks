import { expect } from 'chai'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Ledger, Hold } from '../maker/ledger'

describe('maker durable reservations', () => {
    let dir: string
    let file: string
    const hold: Hold = {
        quoteId: 'q',
        market: 'anchor',
        coin: 'coin:0',
        stake: 100,
        at: 1000,
    }
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'pop-maker-'))
        file = join(dir, 'holds.jsonl')
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))
    it('persists reservations and refuses replay / coin reuse across restarts', () => {
        new Ledger(file).reserve(hold, 100, 100)
        expect(new Ledger(file).all()).deep.eq([hold])
        expect(() => new Ledger(file).reserve(hold, 1000, 1000)).throws(
            'RESERVED'
        )
        expect(() =>
            new Ledger(file).reserve({ ...hold, quoteId: 'other' }, 1000, 1000)
        ).throws('RESERVED')
    })
    it('declines per-market and daily exposure; unresolved signatures remain charged after midnight', () => {
        const l = new Ledger(file)
        l.reserve(hold, 100, 200)
        expect(() =>
            l.reserve({ ...hold, quoteId: 'b', coin: 'b' }, 100, 200)
        ).throws('MARKET_LIMIT')
        expect(() =>
            l.reserve(
                {
                    ...hold,
                    quoteId: 'c',
                    coin: 'c',
                    market: 'new',
                    at: 86400001,
                },
                100,
                150
            )
        ).throws('DAILY_LIMIT')
    })
    it('fails closed on corrupt ledger', () => {
        writeFileSync(file, '{broken')
        expect(() => new Ledger(file).all()).throws()
        writeFileSync(file, JSON.stringify({ ...hold, stake: -1 }) + '\n')
        expect(() => new Ledger(file).all()).throws()
    })
})
