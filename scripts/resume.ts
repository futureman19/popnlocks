/*
 * Resume the on-chain settlement ladder after mempool-chain-depth limits.
 *
 *   npx ts-node scripts/resume.ts <completedCranks> <tipTxid>
 *
 * Rebuilds the contract instance at the state after <completedCranks> chunks
 * (all state is deterministic from the fixture), points it at the existing
 * on-chain UTXO <tipTxid>:0, and continues cranking to final settlement.
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
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

const fixture = JSON.parse(
    fs.readFileSync(
        path.join(__dirname, '..', 'tests', 'fixtures', 'headers.json'),
        'utf8'
    )
)
const ANCHOR_TIP: string = fixture.anchor_internal_hex
const ANCHOR_BITS: bigint = BigInt(fixture.all_bits[0])
const HEADERS: string[] = fixture.headers.slice(1) // 16 headers after anchor
const CHUNK = 4
const BOUNTY = 100n
const POT = 1000
const STRIKE = BigInt(fixture.endpoint_target) // YES wins

const ownPKH = PubKeyHash(
    toByteString(
        bsv.crypto.Hash.sha256ripemd160(
            myPrivateKey.publicKey.toBuffer()
        ).toString('hex')
    )
)

// scrypt-ts hardcodes 1 sat/KB — miner-invisible. ARC requires >=100 sat/KB.
class FeeProvider extends DefaultProvider {
    async getFeePerKb(): Promise<number> {
        return 100
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
    const h1 = createHash('sha256').update(Buffer.from(hex, 'hex')).digest()
    return createHash('sha256').update(h1).digest('hex')
}

function bitsToTarget(bits: bigint): bigint {
    const exponent = bits / 16777216n // 2^24
    const mantissa = bits % 8388608n // 2^23
    let target = mantissa
    for (let i = 0; i < 32; i++) {
        if (16777216n * 2n ** BigInt(i) === 2n ** (exponent - 3n + 24n)) {
            break
        }
        target *= 256n
    }
    return target
}

function targetOfHeader(headerHex: string): bigint {
    const bitsLE = Buffer.from(headerHex, 'hex').subarray(72, 76)
    return bitsToTarget(
        BigInt('0x' + Buffer.from(bitsLE).reverse().toString('hex'))
    )
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 1; attempt <= 8; attempt++) {
        try {
            return await fn()
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            if (msg.includes('429') && attempt < 8) {
                console.log(
                    `${label}: rate-limited, waiting 65s (attempt ${attempt}/8)`
                )
                await new Promise((r) => setTimeout(r, 65000))
                continue
            }
            throw e
        }
    }
    throw new Error('unreachable')
}

async function main() {
    const completed = Number(process.argv[2])
    const tipTxid = process.argv[3]
    if (!Number.isInteger(completed) || completed < 0 || !tipTxid) {
        throw new Error('usage: resume.ts <completedCranks> <tipTxid>')
    }
    await HashrateDerivative.loadArtifact()
    const signer = mainnetSigner()
    console.log('resume from crank', completed, '| tip', tipTxid)

    // State after `completed` chunks is fully determined by the fixture.
    const lastIdx = completed * CHUNK - 1 // index into HEADERS
    let market = new HashrateDerivative(
        toByteString(ANCHOR_TIP) as ByteString,
        STRIKE,
        ownPKH,
        ownPKH,
        BOUNTY,
        ANCHOR_BITS,
        completed === 0
            ? (toByteString(ANCHOR_TIP) as ByteString)
            : (toByteString(sha256dHex(HEADERS[lastIdx])) as ByteString),
        BigInt(completed * CHUNK),
        0n, // endpoint not reached before chunk 3 in the demo geometry
        completed === 0
            ? bitsToTarget(ANCHOR_BITS)
            : targetOfHeader(HEADERS[lastIdx])
    )
    await market.connect(signer)
    if (completed > 0) {
        market.from = {
            txId: tipTxid,
            outputIndex: 0,
            script: market.lockingScript.toHex(),
            satoshis: POT,
        }
    }

    for (let c = completed; c < HEADERS.length / CHUNK; c++) {
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
            console.log(
                'SETTLED: YES side paid',
                POT - Number(BOUNTY),
                'sats; bounty',
                Number(BOUNTY)
            )
        }
    }
}

main().catch((e) => {
    console.error('RESUME FAILED:', e)
    process.exit(1)
})
