/*
 * On-chain demo: HDRAFT-0001 retro market on BSV mainnet.
 * Anchor = block 830000 (long buried) => the 16-header window already exists,
 * so the full ladder settles immediately. All payouts route back to the demo
 * key; total cost is fees only. Strike = real endpoint target => YES wins.
 */
import { HashrateDerivative } from '../src/contracts/hashrateDerivative'
import { myPrivateKey } from '../tests/utils/privateKey'
import {
    ByteString,
    DefaultProvider,
    FixedArray,
    MethodCallOptions,
    PubKeyHash,
    TestWallet,
    Utils,
    bsv,
    toByteString,
} from 'scrypt-ts'
import type { AddressOption, UTXO } from 'scrypt-ts/dist/bsv/types'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

const fixture = JSON.parse(
    fs.readFileSync(
        path.join(__dirname, '..', 'tests', 'fixtures', 'headers.json'),
        'utf8'
    )
)
const HEADERS: string[] = fixture.headers
const ANCHOR_TIP = fixture.anchor_internal_hex as string
const ANCHOR_BITS = BigInt(fixture.all_bits[0] as string)
const ENDPOINT_TARGET = BigInt(fixture.endpoint_target)

const CHUNK = 4
const POT = 1000
const BOUNTY = 100n

const ownPKH = PubKeyHash(
    toByteString(
        bsv.crypto.Hash.sha256ripemd160(
            myPrivateKey.publicKey.toBuffer()
        ).toString('hex')
    )
)

// The scaffold key lives in .env as a testnet WIF; rebuild the same secret as a
// mainnet key. NOTE: bsv v2 fromBuffer/fromHex mis-derive the pubkey — use the
// hex constructor (verified: matches the funded mainnet address).
// scrypt-ts hardcodes 1 sat/KB — miner-invisible. ARC requires >=100 sat/KB.
// Also: broadcast via GorillaPool ARC (WOC's mempool is poisoned by the dead
// 1-sat/KB chain) and only build on confirmed, unspent UTXOs.
interface WocUtxoRow {
    tx_hash: string
    tx_pos: number
    value: number
    status: string
    isSpentInMempoolTx: boolean
}

class FeeProvider extends DefaultProvider {
    async getFeePerKb(): Promise<number> {
        return 100
    }

    async sendRawTransaction(rawTxHex: string): Promise<string> {
        const r = await fetch('https://arc.gorillapool.io/v1/tx', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rawTx: rawTxHex }),
        })
        const d = (await r.json()) as { txid?: string }
        if (!r.ok || !d.txid) {
            throw new Error('ARC broadcast failed: ' + JSON.stringify(d))
        }
        return d.txid
    }

    async listUnspent(address: AddressOption): Promise<UTXO[]> {
        const r = await fetch(
            `https://api.whatsonchain.com/v1/bsv/main/address/${address}/unspent/all`
        )
        const d = (await r.json()) as { result?: WocUtxoRow[] }
        return (d.result || [])
            .filter((u) => u.status === 'confirmed' && !u.isSpentInMempoolTx)
            .map((u) => ({
                txId: u.tx_hash,
                outputIndex: u.tx_pos,
                satoshis: u.value,
                script: bsv.Script.buildPublicKeyHashOut(address).toHex(),
            }))
    }
}

function mainnetSigner(): TestWallet {
    const hex = myPrivateKey.bn.toString('hex').padStart(64, '0')
    const priv = new bsv.PrivateKey(hex, bsv.Networks.mainnet)
    return new TestWallet(
        priv,
        new FeeProvider({ network: bsv.Networks.mainnet })
    )
}

function sha256dHex(hex: string): string {
    const b = Buffer.from(hex, 'hex')
    const h1 = createHash('sha256').update(b).digest()
    return createHash('sha256').update(h1).digest('hex')
}

function bitsToTarget(bits: bigint): bigint {
    return (bits % 8388608n) * 256n ** (bits / 16777216n - 3n)
}

function targetOfHeader(headerHex: string): bigint {
    const bitsLE = Buffer.from(headerHex.slice(144, 152), 'hex')
    return bitsToTarget(
        BigInt('0x' + Buffer.from(bitsLE).reverse().toString('hex'))
    )
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 1; attempt <= 6; attempt++) {
        try {
            return await fn()
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            if (msg.includes('429') && attempt < 6) {
                const wait = 65
                console.log(
                    `${label}: rate-limited, waiting ${wait}s (attempt ${attempt}/6)`
                )
                await new Promise((r) => setTimeout(r, wait * 1000))
                continue
            }
            throw e
        }
    }
    throw new Error('unreachable')
}

async function main() {
    await HashrateDerivative.loadArtifact()
    const [signer, addr, bal] = await withRetry(async () => {
        const s = mainnetSigner()
        const b = await s.getBalance() // forces provider connect + UTXO fetch
        return [s, await s.getDefaultAddress(), b] as const
    }, 'connect')
    console.log('demo key mainnet address:', addr.toString())
    console.log('balance:', bal.confirmed, '+', bal.unconfirmed, 'unconfirmed')

    let market = new HashrateDerivative(
        toByteString(ANCHOR_TIP) as ByteString,
        ENDPOINT_TARGET, // strike == real endpoint target => YES wins
        ownPKH, // yesPKH
        ownPKH, // noPKH (demo: both sides are us)
        BOUNTY,
        ANCHOR_BITS,
        toByteString(ANCHOR_TIP) as ByteString,
        0n,
        0n,
        bitsToTarget(ANCHOR_BITS)
    )
    await market.connect(signer)

    const deployTx = await withRetry(() => market.deploy(POT), 'deploy')
    console.log('deploy:', deployTx.id)

    for (let c = 0; c < HEADERS.length / CHUNK; c++) {
        const hexes = HEADERS.slice(c * CHUNK, c * CHUNK + CHUNK)
        const chunk = hexes.map((h) => toByteString(h)) as FixedArray<
            ByteString,
            4
        >
        const isFinal = c === HEADERS.length / CHUNK - 1

        if (!isFinal) {
            const next = market.next()
            next.tipHash = toByteString(sha256dHex(hexes[CHUNK - 1]))
            next.headersSeen = BigInt((c + 1) * CHUNK)
            next.endpointTarget = market.endpointTarget
            next.prevTarget = targetOfHeader(hexes[CHUNK - 1])
            const res = await withRetry(
                () =>
                    market.methods.settle(chunk, ownPKH, {
                        next: { instance: next, balance: POT },
                    } as MethodCallOptions<HashrateDerivative>),
                `crank ${c + 1}`
            )
            console.log(`crank ${c + 1}:`, res.tx.id)
            market = next
        } else {
            market.bindTxBuilder('settle', async (current, options) => {
                const tx = new bsv.Transaction().addInput(
                    current.buildContractInput(options.fromUTXO)
                )
                tx.addOutput(
                    new bsv.Transaction.Output({
                        script: bsv.Script.fromHex(
                            Utils.buildPublicKeyHashScript(ownPKH)
                        ),
                        satoshis: POT - Number(BOUNTY),
                    })
                )
                tx.addOutput(
                    new bsv.Transaction.Output({
                        script: bsv.Script.fromHex(
                            Utils.buildPublicKeyHashScript(ownPKH)
                        ),
                        satoshis: Number(BOUNTY),
                    })
                )
                tx.change(
                    options.changeAddress ||
                        (await current.signer.getDefaultAddress())
                )
                return Promise.resolve({
                    tx,
                    atInputIndex: 0,
                    nexts: undefined,
                })
            })
            const res = await withRetry(
                () => market.methods.settle(chunk, ownPKH),
                'settle'
            )
            console.log('settle (final):', res.tx.id)
            console.log('settle tx hex:', res.tx.toString())
        }
    }
}

main().catch((e) => {
    console.error('DEMO FAILED:', e)
    process.exit(1)
})
