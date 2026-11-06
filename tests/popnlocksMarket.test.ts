import { expect, use } from 'chai'
import { PopnlocksMarket } from '../src/contracts/popnlocksMarket'
import { getDefaultSigner } from './utils/txHelper'
import {
    ByteString,
    FixedArray,
    MethodCallOptions,
    PubKeyHash,
    Utils,
    bsv,
    toByteString,
} from 'scrypt-ts'
import chaiAsPromised from 'chai-as-promised'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

use(chaiAsPromised)

// Golden vectors: 17 real BSV mainnet headers (anchor 830000 + 16 following),
// reconstruction-verified against sha256d(header) == block hash at fetch time.
const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'headers.json'), 'utf8')
)
// Synthetic chains: locally ground at trivial difficulty (valid control,
// drift-bound violation, floor breach).
const synthetic = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'synthetic.json'), 'utf8')
)

const GOLDEN = {
    headers: fixture.headers as string[],
    anchorTip: fixture.anchor_internal_hex as string,
    anchorBits: BigInt(fixture.all_bits[0] as string),
}
const SYNTH = {
    anchorTip: synthetic.anchor_internal_hex as string,
    anchorBits: BigInt(synthetic.anchor_bits as string),
}

const ENDPOINT_TARGET = BigInt(fixture.endpoint_target)

const YES_PKH = PubKeyHash(
    toByteString('00000000000000000000000000000000000000aa')
)
const NO_PKH = PubKeyHash(
    toByteString('00000000000000000000000000000000000000bb')
)
const CRANK_PKH = PubKeyHash(
    toByteString('00000000000000000000000000000000000000cc')
)

const POT = 10000
const BOUNTY = 100n
const CHUNK = 4
const N_CHUNKS = GOLDEN.headers.length / CHUNK // 4

// Raw (internal-order) sha256d of a header hex — matches the contract's hash256 output.
function sha256dHex(hex: string): string {
    const b = Buffer.from(hex, 'hex')
    const h1 = createHash('sha256').update(b).digest()
    return createHash('sha256').update(h1).digest('hex')
}

// Off-chain mirror of the contract's bits2target (compact bits -> 256-bit target).
function bitsToTarget(bits: bigint): bigint {
    const exponent = bits / 16777216n
    const mantissa = bits % 8388608n
    return mantissa * 256n ** (exponent - 3n)
}

function targetOfHeader(headerHex: string): bigint {
    const bitsLE = Buffer.from(headerHex.slice(144, 152), 'hex')
    const bits = BigInt('0x' + Buffer.from(bitsLE).reverse().toString('hex'))
    return bitsToTarget(bits)
}

// The SDK's default tx builder only adds `next` state outputs + change; payout
// covenants bind a custom builder that adds the winner + bounty outputs.
function settleTxBuilder(winnerPKH: PubKeyHash, winnerAmt: bigint) {
    return async (
        current: PopnlocksMarket,
        options: MethodCallOptions<PopnlocksMarket>
    ): Promise<{
        tx: bsv.Transaction
        atInputIndex: number
        nexts: undefined
    }> => {
        const tx = new bsv.Transaction().addInput(
            current.buildContractInput(options.fromUTXO)
        )
        tx.addOutput(
            new bsv.Transaction.Output({
                script: bsv.Script.fromHex(
                    Utils.buildPublicKeyHashScript(winnerPKH)
                ),
                satoshis: Number(winnerAmt),
            })
        )
        tx.addOutput(
            new bsv.Transaction.Output({
                script: bsv.Script.fromHex(
                    Utils.buildPublicKeyHashScript(CRANK_PKH)
                ),
                satoshis: Number(BOUNTY),
            })
        )
        tx.change(
            options.changeAddress || (await current.signer.getDefaultAddress())
        )
        return Promise.resolve({ tx, atInputIndex: 0, nexts: undefined })
    }
}

async function deployMarket(
    strikeTarget: bigint,
    anchorTip: string,
    anchorBits: bigint
) {
    const market = new PopnlocksMarket(
        toByteString(anchorTip) as ByteString,
        strikeTarget,
        YES_PKH,
        NO_PKH,
        BOUNTY,
        anchorBits,
        toByteString(anchorTip) as ByteString, // ladder starts at the anchor
        0n, // headersSeen
        0n, // endpointTarget (captured at rung 3)
        bitsToTarget(anchorBits) // drift base starts at the anchor's target
    )
    await market.connect(getDefaultSigner())
    await market.deploy(POT)
    return market
}

// Drive the full 4-rung settlement ladder over a header chain. Options inject attacks.
async function runLadder(
    strike: bigint,
    chain: { headers: string[]; anchorTip: string; anchorBits: bigint },
    opts: { tamperChunk?: number; wrongWinner?: boolean } = {}
) {
    let current = await deployMarket(strike, chain.anchorTip, chain.anchorBits)
    for (let c = 0; c < N_CHUNKS; c++) {
        const hexes = chain.headers.slice(c * CHUNK, c * CHUNK + CHUNK)
        if (opts.tamperChunk === c) {
            const h = hexes[1]
            hexes[1] = h.slice(0, 152) + 'ff' + h.slice(154) // flip nonce byte
        }
        const chunk = hexes.map((h) => toByteString(h)) as FixedArray<
            ByteString,
            4
        >
        const isFinal = c === N_CHUNKS - 1

        if (!isFinal) {
            const next = current.next()
            next.tipHash = toByteString(sha256dHex(hexes[CHUNK - 1]))
            next.headersSeen = BigInt((c + 1) * CHUNK)
            next.endpointTarget = current.endpointTarget
            next.prevTarget = targetOfHeader(hexes[CHUNK - 1])
            await current.methods.settle(chunk, CRANK_PKH, {
                next: { instance: next, balance: POT },
            } as MethodCallOptions<PopnlocksMarket>)
            current = next
        } else {
            let winner =
                targetOfHeader(chain.headers[12]) <= strike ? YES_PKH : NO_PKH
            if (opts.wrongWinner) {
                winner = winner === YES_PKH ? NO_PKH : YES_PKH
            }
            current.bindTxBuilder(
                'settle',
                settleTxBuilder(winner, BigInt(POT) - BOUNTY)
            )
            await current.methods.settle(chunk, CRANK_PKH)
        }
    }
}

describe('POP-0 PoC: Binary Difficulty Market — chunked ladder', () => {
    before(async () => {
        await PopnlocksMarket.loadArtifact()
    })

    it('settles YES through 4 cranks when strike equals the real endpoint target', async () => {
        await expect(runLadder(ENDPOINT_TARGET, GOLDEN)).not.to.be.rejected
    })

    it('settles NO when strike demands more difficulty than the endpoint has', async () => {
        await expect(runLadder(ENDPOINT_TARGET - 1n, GOLDEN)).not.to.be.rejected
    })

    it('rejects a tampered header mid-ladder (chunk 1 nonce flip)', async () => {
        await expect(runLadder(ENDPOINT_TARGET, GOLDEN, { tamperChunk: 1 })).to
            .be.rejected
    })

    it('rejects a cranker who builds the payout to the wrong side', async () => {
        await expect(runLadder(ENDPOINT_TARGET, GOLDEN, { wrongWinner: true }))
            .to.be.rejected
    })

    it('rejects skipping ahead (chunk 1 offered first breaks linkage)', async () => {
        const market = await deployMarket(
            ENDPOINT_TARGET,
            GOLDEN.anchorTip,
            GOLDEN.anchorBits
        )
        const next = market.next()
        next.tipHash = toByteString(sha256dHex(GOLDEN.headers[7]))
        next.headersSeen = 8n
        next.endpointTarget = 0n
        next.prevTarget = targetOfHeader(GOLDEN.headers[7])
        const chunk = GOLDEN.headers
            .slice(CHUNK, CHUNK * 2)
            .map((h) => toByteString(h)) as FixedArray<ByteString, 4>
        const call = async () =>
            market.methods.settle(chunk, CRANK_PKH, {
                next: { instance: next, balance: POT },
            } as MethodCallOptions<PopnlocksMarket>)
        await expect(call()).to.be.rejected
    })

    it('accepts a synthetic rule-abiding chain (control for Lite DAA tier)', async () => {
        const chain = { ...SYNTH, headers: synthetic.chains.valid as string[] }
        const strike = targetOfHeader(chain.headers[12])
        await expect(runLadder(strike, chain)).not.to.be.rejected
    })

    it('rejects a synthetic chain violating the per-header drift bound', async () => {
        const chain = { ...SYNTH, headers: synthetic.chains.drift as string[] }
        const strike = targetOfHeader(chain.headers[12])
        await expect(runLadder(strike, chain)).to.be.rejectedWith(/drift bound/)
    })

    it('rejects a synthetic chain breaching the anchor-relative difficulty floor', async () => {
        const chain = { ...SYNTH, headers: synthetic.chains.floor as string[] }
        const strike = targetOfHeader(chain.headers[12])
        await expect(runLadder(strike, chain)).to.be.rejectedWith(
            /floor breached/
        )
    })
})
