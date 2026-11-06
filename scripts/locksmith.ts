/* Watchlist v1. Dry-run is default and never loads a key or creates a signer. */
import { existsSync, readFileSync, openSync, closeSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import {
    bsv,
    DefaultProvider,
    TestWallet,
    PubKeyHash,
    toByteString,
} from 'scrypt-ts'
import type { AddressOption, UTXO } from 'scrypt-ts/dist/bsv/types'
import { PopnlocksProductionMarket as Market } from '../src/contracts/popnlocksProductionMarket'
import { crank } from '../src/settlement/crank'
import {
    appendSettlement,
    atomicJson,
    digest,
    GEOMETRY,
    rebuildState,
    resumeLadder,
    targetFromBits,
} from './resume'

const BASE = 'https://api.whatsonchain.com/v1/bsv/main'
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const hex = (v: unknown, n: number) =>
    typeof v === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(v)
export interface WatchedMarket {
    deployTxid: string
    anchorHeight: number
    anchorTipHex: string
    anchorBits: number
    window: number
    strikeTarget: string
    yesPKH: string
    noPKH: string
    bounty: number
    pot: number
}
export function parseWatchlist(value: unknown): WatchedMarket[] {
    if (!Array.isArray(value)) throw new Error('watchlist must be an array')
    const ids = new Set<string>()
    return value.map((m: WatchedMarket) => {
        if (
            !m ||
            !hex(m.deployTxid, 64) ||
            !hex(m.anchorTipHex, 64) ||
            !hex(m.yesPKH, 40) ||
            !hex(m.noPKH, 40) ||
            m.yesPKH === m.noPKH ||
            !Number.isSafeInteger(m.anchorHeight) ||
            m.anchorHeight < 1 ||
            m.window !== 144 ||
            !Number.isSafeInteger(m.anchorBits) ||
            typeof m.strikeTarget !== 'string' ||
            !/^[1-9][0-9]*$/.test(m.strikeTarget) ||
            BigInt(m.strikeTarget) >= 1n << 256n ||
            !Number.isSafeInteger(m.bounty) ||
            m.bounty < 1 ||
            !Number.isSafeInteger(m.pot) ||
            m.pot > 2100000000000000 ||
            m.pot <= m.bounty * 3
        )
            throw new Error('invalid production watchlist market')
        targetFromBits(BigInt(m.anchorBits))
        if (ids.has(m.deployTxid)) throw new Error('duplicate market')
        ids.add(m.deployTxid)
        return m
    })
}
export class WocReader {
    async get(path: string, allowMissing = false): Promise<unknown> {
        for (let attempt = 0; attempt < 3; attempt++) {
            const response = await fetch(BASE + path, {
                signal: AbortSignal.timeout(30000),
            })
            if (response.status === 429 && attempt < 2) {
                await sleep(65000)
                continue
            }
            if (allowMissing && response.status === 404) return null
            if (!response.ok)
                throw new Error(`WOC GET ${path}: ${response.status}`)
            const text = await response.text()
            try {
                return JSON.parse(text)
            } catch {
                return text.trim()
            }
        }
        throw new Error('WOC retry exhausted')
    }
    async height(): Promise<number> {
        const d = (await this.get('/chain/info')) as {
            chain: string
            blocks: number
        }
        if (d.chain !== 'main' || !Number.isSafeInteger(d.blocks))
            throw new Error('invalid mainnet chain info')
        return d.blocks
    }
    async header(height: number): Promise<string> {
        const b = (await this.get(`/block/height/${height}`)) as {
            height: number
            hash: string
            version: number
            previousblockhash: string
            merkleroot: string
            time: number
            bits: string
            nonce: number
        }
        if (
            b.height !== height ||
            !hex(b.hash, 64) ||
            !hex(b.previousblockhash, 64) ||
            !hex(b.merkleroot, 64) ||
            !hex(b.bits, 8)
        )
            throw new Error('invalid block response')
        const raw = Buffer.alloc(80)
        raw.writeUInt32LE(b.version >>> 0, 0)
        Buffer.from(b.previousblockhash, 'hex').reverse().copy(raw, 4)
        Buffer.from(b.merkleroot, 'hex').reverse().copy(raw, 36)
        raw.writeUInt32LE(b.time, 68)
        raw.writeUInt32LE(parseInt(b.bits, 16), 72)
        raw.writeUInt32LE(b.nonce, 76)
        const h = raw.toString('hex')
        if (Buffer.from(digest(h), 'hex').reverse().toString('hex') !== b.hash)
            throw new Error('header hash mismatch')
        await sleep(500)
        return h
    }
    async tx(id: string): Promise<bsv.Transaction> {
        if (!hex(id, 64)) throw new Error('invalid txid')
        const raw = await this.get(`/tx/${id}/hex`)
        if (typeof raw !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(raw))
            throw new Error('invalid raw tx')
        const tx = new bsv.Transaction(raw)
        if (tx.id !== id) throw new Error('transaction hash mismatch')
        return tx
    }
    async assertUnspent(id: string) {
        const spent = await this.get(`/tx/${id}/0/spent`, true)
        if (spent !== null)
            throw new Error(
                `market output already spent: ${id}; reconcile checkpoint`
            )
    }
    async waitConfirmed(id: string) {
        for (let i = 0; i < 120; i++) {
            const info = (await this.get(`/tx/hash/${id}`)) as {
                confirmations?: number
            }
            if (
                Number.isSafeInteger(info.confirmations) &&
                info.confirmations! >= 1
            )
                return
            await sleep(30000)
        }
        throw new Error('confirmation timeout; checkpoint retained')
    }
}
export function marketAt(
    m: WatchedMarket,
    headers: string[],
    completed: number
): Market {
    const s = rebuildState(
        m.anchorTipHex,
        BigInt(m.anchorBits),
        headers,
        completed
    )
    let instance = new Market(
        toByteString(m.anchorTipHex),
        BigInt(m.strikeTarget),
        PubKeyHash(m.yesPKH),
        PubKeyHash(m.noPKH),
        BigInt(m.bounty),
        BigInt(m.anchorBits),
        toByteString(m.anchorTipHex),
        0n,
        0n,
        targetFromBits(BigInt(m.anchorBits))
    )
    if (completed) {
        instance = instance.next()
        Object.assign(instance, s)
    }
    return completed === 0 ? instance.markAsGenesis() : instance
}
interface Journal {
    txids: string[]
    pending?: string
}
/** Journal a candidate before network write. Ambiguous outcomes are never retried. */
class LocksmithProvider extends DefaultProvider {
    constructor(
        private reader: WocReader,
        private journal: Journal,
        private save: () => void
    ) {
        super({ network: bsv.Networks.mainnet })
    }
    async getFeePerKb() {
        return 100
    }
    async listUnspent(address: AddressOption): Promise<UTXO[]> {
        const d = (await this.reader.get(
            `/address/${address}/unspent/all`
        )) as {
            result: {
                tx_hash: string
                tx_pos: number
                value: number
                status: string
                isSpentInMempoolTx: boolean
            }[]
        }
        if (!Array.isArray(d.result)) throw new Error('invalid funding UTXOs')
        const utxos: UTXO[] = []
        const script = bsv.Script.buildPublicKeyHashOut(address).toHex()
        for (const u of d.result.filter(
            (u) => u.status === 'confirmed' && u.isSpentInMempoolTx === false
        )) {
            const tx = await this.reader.tx(u.tx_hash)
            const out = tx.outputs[u.tx_pos]
            if (
                !out ||
                out.script.toHex() !== script ||
                out.satoshis !== u.value
            )
                throw new Error('funding prevout mismatch')
            utxos.push({
                txId: u.tx_hash,
                outputIndex: u.tx_pos,
                satoshis: u.value,
                script,
            })
        }
        return utxos
    }
    async sendRawTransaction(raw: string): Promise<string> {
        const id = new bsv.Transaction(raw).id
        this.journal.pending = id
        this.save()
        const response = await fetch('https://arc.gorillapool.io/v1/tx', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rawTx: raw }),
            signal: AbortSignal.timeout(30000),
        })
        const d = (await response.json()) as {
            txid?: string
            txStatus?: string
            extraInfo?: string
        }
        if (
            d.txStatus === 'REJECTED' &&
            String(d.extraInfo).includes('too-long-mempool-chain')
        ) {
            delete this.journal.pending
            this.save()
            throw new Error('too-long-mempool-chain')
        }
        // A receipt is not acceptance: independently resolve the exact tx bytes.
        if (!response.ok || d.txid !== id || d.txStatus === 'REJECTED')
            throw new Error(
                `broadcast outcome unresolved; inspect pending ${id}`
            )
        const observed = await this.reader.tx(id)
        if (observed.toString() !== raw)
            throw new Error('broadcast readback mismatch')
        return id
    }
}
export async function inspectWindow(
    m: WatchedMarket,
    reader: WocReader,
    height: number
) {
    if (height < m.anchorHeight + GEOMETRY.total) return undefined
    const anchor = await reader.header(m.anchorHeight)
    if (
        digest(anchor) !== m.anchorTipHex ||
        Buffer.from(anchor, 'hex').readUInt32LE(72) !== m.anchorBits
    )
        throw new Error('anchor mismatch')
    const headers: string[] = []
    for (let i = 1; i <= 144; i++)
        headers.push(await reader.header(m.anchorHeight + i))
    rebuildState(m.anchorTipHex, BigInt(m.anchorBits), headers, 3)
    // Detect a reorg during header collection.
    if ((await reader.header(m.anchorHeight + 144)) !== headers[143])
        throw new Error('window reorg; retry inspection')
    return headers
}
export async function verifySettlement(
    m: WatchedMarket,
    headers: string[],
    txids: string[],
    reader: WocReader
) {
    if (txids.length !== 4 || txids[0] !== m.deployTxid)
        throw new Error('incomplete settlement or wrong deployment')
    const target = rebuildState(
        m.anchorTipHex,
        BigInt(m.anchorBits),
        headers,
        3
    ).endpointTarget
    const winner = target <= BigInt(m.strikeTarget) ? m.yesPKH : m.noPKH
    for (let n = 0; n < 4; n++) {
        const tx = await reader.tx(txids[n])
        const expected =
            n < 3
                ? marketAt(m, headers, n).lockingScript.toHex()
                : bsv.Script.buildPublicKeyHashOut(
                      bsv.Address.fromPublicKeyHash(Buffer.from(winner, 'hex'))
                  ).toHex()
        if (
            !tx.outputs[0] ||
            tx.outputs[0].script.toHex() !== expected ||
            tx.outputs[0].satoshis !== m.pot - n * m.bounty
        )
            throw new Error(
                `settlement output mismatch at rung ${n}: value ${
                    tx.outputs[0]?.satoshis
                }, script match ${tx.outputs[0]?.script.toHex() === expected}`
            )
        if (
            n &&
            (!tx.inputs[0] ||
                tx.inputs[0].outputIndex !== 0 ||
                tx.inputs[0].prevTxId.toString('hex') !== txids[n - 1])
        )
            throw new Error('settlement lineage mismatch')
    }
    if ((await reader.header(m.anchorHeight + 144)) !== headers[143])
        throw new Error('settlement window reorg')
}
export async function main(args = process.argv.slice(2)) {
    const file = args[0]
    if (
        !file ||
        args
            .slice(1)
            .some(
                (a) => !['--dry-run', '--watch', '--broadcast'].includes(a)
            ) ||
        (args.includes('--dry-run') && args.includes('--broadcast'))
    )
        throw new Error(
            'usage: locksmith.ts watchlist.json [--dry-run|--broadcast] [--watch]'
        )
    const broadcast = args.includes('--broadcast')
    const reader = new WocReader()
    await Market.loadArtifact()
    let key: bsv.PrivateKey | undefined
    if (broadcast) {
        // dotenv is deliberately loaded only on the explicitly enabled write path.
        const dotenv = await import('dotenv')
        dotenv.config()
        if (!process.env.LOCKSMITH_WIF)
            throw new Error('LOCKSMITH_WIF required; never use a treasury key')
        key = bsv.PrivateKey.fromWIF(process.env.LOCKSMITH_WIF)
        if (key.toAddress().network.name !== 'livenet')
            throw new Error('mainnet locksmith key required')
    }
    const lock = resolve('.locksmith.lock')
    const fd = broadcast ? openSync(lock, 'wx') : undefined
    try {
        do {
            const markets = parseWatchlist(
                JSON.parse(readFileSync(resolve(file), 'utf8'))
            )
            const height = await reader.height()
            console.log(
                JSON.stringify({
                    mode: broadcast ? 'broadcast' : 'dry-run',
                    network: 'main',
                    height,
                    markets: markets.length,
                })
            )
            for (const m of markets) {
                const headers = await inspectWindow(m, reader, height)
                if (!headers) {
                    console.log(
                        `${m.deployTxid}: waiting for height ${
                            m.anchorHeight + 144
                        }`
                    )
                    continue
                }
                const winner =
                    rebuildState(
                        m.anchorTipHex,
                        BigInt(m.anchorBits),
                        headers,
                        3
                    ).endpointTarget <= BigInt(m.strikeTarget)
                        ? 'yes'
                        : 'no'
                const journalFile = resolve(
                    '.locksmith-state',
                    m.deployTxid + '.json'
                )
                const journal: Journal = existsSync(journalFile)
                    ? JSON.parse(readFileSync(journalFile, 'utf8'))
                    : { txids: [m.deployTxid] }
                if (
                    !Array.isArray(journal.txids) ||
                    journal.txids[0] !== m.deployTxid ||
                    journal.txids.length > 4 ||
                    journal.txids.some((id) => !hex(id, 64))
                )
                    throw new Error('invalid checkpoint')
                if (journal.pending)
                    throw new Error(
                        `unresolved pending ${journal.pending}; reconcile before restart (see docs/locksmith.md)`
                    )
                const save = () => atomicJson(journalFile, journal)
                const completed = journal.txids.length - 1
                if (completed < 3) {
                    const expected = marketAt(m, headers, completed)
                    const tx = await reader.tx(journal.txids[completed])
                    if (
                        !tx.outputs[0] ||
                        tx.outputs[0].script.toHex() !==
                            expected.lockingScript.toHex() ||
                        tx.outputs[0].satoshis !== m.pot - completed * m.bounty
                    )
                        throw new Error('checkpoint covenant/value mismatch')
                }
                console.log(
                    `${m.deployTxid}: eligible; ${
                        3 - completed
                    } cranks remain; winner ${winner}`
                )
                if (!broadcast) continue
                const signer = new TestWallet(
                    key!,
                    new LocksmithProvider(reader, journal, save)
                )
                signer.enableSplitFeeTx(false) // never create an unjournaled funding/split transaction
                const ownPKH = PubKeyHash(
                    bsv.crypto.Hash.sha256ripemd160(
                        key!.publicKey.toBuffer()
                    ).toString('hex')
                )
                let current: Market
                await resumeLadder(journal.txids, {
                    rebuild: async (n) => {
                        current = marketAt(m, headers, n)
                        const tx = await reader.tx(journal.txids[n])
                        if (
                            !tx.outputs[0] ||
                            tx.outputs[0].script.toHex() !==
                                current.lockingScript.toHex() ||
                            tx.outputs[0].satoshis !== m.pot - n * m.bounty
                        )
                            throw new Error('rebuild covenant/value mismatch')
                        await reader.assertUnspent(tx.id)
                        if (
                            (await reader.header(m.anchorHeight + 144)) !==
                            headers[143]
                        )
                            throw new Error('window reorg; halt')
                        current.from = {
                            txId: tx.id,
                            outputIndex: 0,
                            script: tx.outputs[0].script.toHex(),
                            satoshis: tx.outputs[0].satoshis,
                        }
                        await current.connect(signer)
                    },
                    crank: async (n) => {
                        const next =
                            n < 2 ? marketAt(m, headers, n + 1) : undefined
                        const result = await crank(
                            current,
                            headers.slice(n * 48, (n + 1) * 48),
                            next,
                            m.pot - n * m.bounty,
                            ownPKH,
                            PubKeyHash(winner === 'yes' ? m.yesPKH : m.noPKH)
                        )
                        return result.tx.id
                    },
                    waitConfirmed: (id) => reader.waitConfirmed(id),
                    save: async () => {
                        delete journal.pending
                        save()
                    },
                })
                await reader.waitConfirmed(journal.txids[3])
                await verifySettlement(m, headers, journal.txids, reader)
                appendSettlement(resolve('docs/data/pops.json'), {
                    marketId: m.deployTxid,
                    market: m,
                    txids: journal.txids,
                    winnerSide: winner,
                })
            }
            if (args.includes('--watch')) await sleep(60000)
        } while (args.includes('--watch'))
    } finally {
        if (fd !== undefined) {
            closeSync(fd)
            unlinkSync(lock)
        }
    }
}
if (require.main === module)
    main().catch((e) => {
        console.error(String(e))
        process.exitCode = 1
    })
