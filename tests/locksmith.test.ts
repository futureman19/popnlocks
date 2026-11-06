import { expect } from 'chai'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { rebuildState, resumeLadder, appendSettlement } from '../scripts/resume'

// Independent local PoW ground truth: 50% target; last header is harder.
export function fixture144() {
    const anchor = '00'.repeat(32)
    let prev = anchor
    const headers: string[] = []
    const hashes: string[] = []
    for (let i = 0; i < 144; i++) {
        const bits = i === 143 ? 0x207effff : 0x207fffff
        const target = BigInt(bits & 0x7fffff) << 232n
        const b = Buffer.alloc(80)
        b.writeUInt32LE(1, 0)
        Buffer.from(prev, 'hex').copy(b, 4)
        b.writeUInt32LE(i + 1, 68)
        b.writeUInt32LE(bits, 72)
        for (let nonce = 0; ; nonce++) {
            b.writeUInt32LE(nonce, 76)
            const digest = createHash('sha256')
                .update(createHash('sha256').update(b).digest())
                .digest()
            if (
                BigInt('0x' + Buffer.from(digest).reverse().toString('hex')) <
                target
            ) {
                prev = digest.toString('hex')
                break
            }
        }
        headers.push(b.toString('hex'))
        hashes.push(prev)
    }
    return { anchor, headers, hashes, target: 0x7effffn << 232n }
}

describe('locksmith reconstruction and recovery', () => {
    const f = fixture144()
    it('rebuilds every chunk boundary, capturing only header 144', () => {
        for (const completed of [0, 1, 2, 3]) {
            const state = rebuildState(
                f.anchor,
                0x207fffffn,
                f.headers,
                completed
            )
            expect(state.headersSeen).equals(BigInt(completed * 48))
            expect(state.tipHash).equals(
                completed ? f.hashes[completed * 48 - 1] : f.anchor
            )
            expect(state.endpointTarget).equals(completed === 3 ? f.target : 0n)
        }
    })
    it('rejects bad linkage, insufficient headers and invalid rungs', () => {
        expect(() =>
            rebuildState(f.anchor, 0x207fffffn, f.headers.slice(1), 1)
        ).throws(/linkage/)
        expect(() => rebuildState(f.anchor, 0x207fffffn, [], 1)).throws(
            /headers/
        )
        expect(() => rebuildState(f.anchor, 0x207fffffn, f.headers, 4)).throws(
            /rung/
        )
    })
    it('waits for confirmation and rebuilds the same rung after chain limit', async () => {
        const calls: string[] = []
        let failed = false
        const txids = ['aa'.repeat(32)]
        await resumeLadder(txids, {
            rebuild: async (n) => {
                calls.push(`rebuild:${n}`)
            },
            crank: async (n) => {
                calls.push(`crank:${n}`)
                if (!failed) {
                    failed = true
                    throw new Error('too-long-mempool-chain')
                }
                return String(n + 1).repeat(64)
            },
            waitConfirmed: async (id) => {
                expect(id).equals(txids[0])
                calls.push('confirmed')
            },
            save: async () => {
                calls.push('save')
            },
        })
        expect(calls.slice(0, 5)).deep.equals([
            'rebuild:0',
            'crank:0',
            'confirmed',
            'rebuild:0',
            'crank:0',
        ])
        expect(txids).length(4)
    })
    it('does not retry ambiguous failures or advance its checkpoint', async () => {
        const txids = ['aa'.repeat(32)]
        let waits = 0
        try {
            await resumeLadder(txids, {
                rebuild: async () => undefined,
                crank: async () => {
                    throw new Error('network timeout')
                },
                waitConfirmed: async () => {
                    waits++
                },
                save: async () => undefined,
            })
            expect.fail('must stop')
        } catch (e) {
            expect(String(e)).contains('network timeout')
        }
        expect(txids).length(1)
        expect(waits).equals(0)
    })
    it('appends settlements idempotently without erasing existing records', () => {
        const dir = mkdtempSync(join(process.cwd(), '.locksmith-test-'))
        try {
            const file = join(dir, 'pops.json')
            const record = {
                marketId: 'aa'.repeat(32),
                market: { window: 144 },
                txids: ['aa'.repeat(32), 'bb'.repeat(32)],
                winnerSide: 'yes' as const,
            }
            appendSettlement(file, record)
            appendSettlement(file, record)
            expect(JSON.parse(readFileSync(file, 'utf8'))).deep.equals([record])
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
