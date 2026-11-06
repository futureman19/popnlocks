/* Parameterized shared recovery; no demo key or fixture imports. */
import { createHash } from 'crypto'
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from 'fs'
import { dirname } from 'path'
export const GEOMETRY = Object.freeze({
    total: 144,
    chunk: 48,
    endpointIndex: 143,
})
export function digest(header: string): string {
    return createHash('sha256')
        .update(
            createHash('sha256').update(Buffer.from(header, 'hex')).digest()
        )
        .digest('hex')
}
export function targetFromBits(bits: bigint): bigint {
    const exponent = bits >> 24n
    const mantissa = bits & 0x7fffffn
    if (
        bits < 1n ||
        bits > 0xffffffffn ||
        (bits & 0x800000n) !== 0n ||
        exponent < 3n ||
        exponent > 32n ||
        mantissa === 0n
    )
        throw new Error('invalid compact bits')
    return mantissa * 256n ** (exponent - 3n)
}
export function headerTarget(header: string): bigint {
    if (!/^[0-9a-f]{160}$/.test(header)) throw new Error('invalid header')
    return targetFromBits(BigInt(Buffer.from(header, 'hex').readUInt32LE(72)))
}
export function rebuildState(
    anchor: string,
    anchorBits: bigint,
    headers: string[],
    completed: number,
    geometry = GEOMETRY
) {
    if (
        !Number.isInteger(completed) ||
        completed < 0 ||
        completed > geometry.total / geometry.chunk
    )
        throw new Error('invalid rung')
    if (!/^[0-9a-f]{64}$/.test(anchor)) throw new Error('invalid anchor')
    const seen = completed * geometry.chunk
    if (headers.length < seen) throw new Error('insufficient headers')
    let tipHash = anchor
    let prevTarget = targetFromBits(anchorBits)
    const anchorTarget = prevTarget
    let endpointTarget = 0n
    for (let i = 0; i < seen; i++) {
        const h = headers[i]
        const target = headerTarget(h)
        if (h.slice(8, 72) !== tipHash) throw new Error('broken header linkage')
        tipHash = digest(h)
        if (
            BigInt(
                '0x' + Buffer.from(tipHash, 'hex').reverse().toString('hex')
            ) >= target
        )
            throw new Error('insufficient PoW')
        if (target > anchorTarget * 8n)
            throw new Error('difficulty floor breached')
        if (target * 20n < prevTarget * 19n || target * 20n > prevTarget * 21n)
            throw new Error('bits drift bound exceeded')
        prevTarget = target
        if (i === geometry.endpointIndex) endpointTarget = target
    }
    return { tipHash, headersSeen: BigInt(seen), endpointTarget, prevTarget }
}
export interface ResumeHooks {
    rebuild(completed: number): Promise<void>
    crank(completed: number): Promise<string>
    waitConfirmed(txid: string): Promise<void>
    save(txids: string[]): Promise<void>
}
/** Explicit depth rejection only; unknown outcomes halt for reconciliation. */
export async function resumeLadder(
    txids: string[],
    hooks: ResumeHooks,
    totalCranks = 3
) {
    if (txids.length < 1 || txids.length > totalCranks + 1)
        throw new Error('invalid checkpoint')
    let retries = 0
    while (txids.length <= totalCranks) {
        const completed = txids.length - 1
        await hooks.rebuild(completed)
        let id: string
        try {
            id = await hooks.crank(completed)
        } catch (e) {
            if (!String(e).includes('too-long-mempool-chain') || retries++ >= 3)
                throw e
            await hooks.waitConfirmed(txids[completed])
            continue
        }
        if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('invalid returned txid')
        txids.push(id)
        await hooks.save(txids)
        retries = 0
    }
}
export function atomicJson(file: string, value: unknown) {
    mkdirSync(dirname(file), { recursive: true })
    const temp = file + '.tmp'
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    renameSync(temp, file)
}
export interface SettlementRecord {
    marketId: string
    market: object
    txids: string[]
    winnerSide: 'yes' | 'no'
}
/** Single writer; malformed/conflicting existing data fails closed. */
export function appendSettlement(file: string, record: SettlementRecord) {
    const records = existsSync(file)
        ? JSON.parse(readFileSync(file, 'utf8'))
        : []
    if (!Array.isArray(records)) throw new Error('pops.json must be an array')
    const existing = records.find((r) => r.marketId === record.marketId)
    if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(record))
            throw new Error('conflicting settlement record')
        return
    }
    atomicJson(file, [...records, record])
}
if (require.main === module) {
    import('./locksmith')
        .then(({ main }) => main())
        .catch((e) => {
            console.error(String(e))
            process.exitCode = 1
        })
}
