import { expect, use } from 'chai'
import { HashrateDerivative } from '../src/contracts/hashrateDerivative'
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

const ALL_HEADERS: string[] = fixture.headers
const ANCHOR = toByteString(fixture.anchor_internal_hex) as ByteString
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
const N_CHUNKS = ALL_HEADERS.length / CHUNK // 4

// Raw (internal-order) sha256d of a header hex — matches the contract's hash256 output.
function sha256dHex(hex: string): string {
    const b = Buffer.from(hex, 'hex')
    const h1 = createHash('sha256').update(b).digest()
    return createHash('sha256').update(h1).digest('hex')
}

// Off-chain mirror of the contract's bits2target, for the client-side tx builder.
// The contract remains the authority: a builder that pays the wrong side fails
// the covenant's hashOutputs check.
function endpointTargetOf(headerHex: string): bigint {
    const bitsLE = Buffer.from(headerHex.slice(144, 152), 'hex')
    const bits = BigInt('0x' + Buffer.from(bitsLE).reverse().toString('hex'))
    const exponent = bits / 16777216n
    const mantissa = bits % 8388608n
    return mantissa * 256n ** (exponent - 3n)
}

// The SDK's default tx builder only adds `next` state outputs + change; payout
// covenants bind a custom builder that adds the winner + bounty outputs.
function settleTxBuilder(winnerPKH: PubKeyHash, winnerAmt: bigint) {
    return async (
        current: HashrateDerivative,
        options: MethodCallOptions<HashrateDerivative>
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

async function deployMarket(strikeTarget: bigint) {
    const market = new HashrateDerivative(
        ANCHOR,
        strikeTarget,
        YES_PKH,
        NO_PKH,
        BOUNTY,
        ANCHOR, // ladder starts at the anchor
        0n, // headersSeen
        0n // endpointTarget (captured at rung 3)
    )
    await market.connect(getDefaultSigner())
    await market.deploy(POT)
    return market
}

function chunkHeaders(c: number): FixedArray<ByteString, 4> {
    return ALL_HEADERS.slice(c * CHUNK, c * CHUNK + CHUNK).map((h) =>
        toByteString(h)
    ) as FixedArray<ByteString, 4>
}

// Drive the full 4-rung settlement ladder. Options inject attacks.
async function runLadder(
    strike: bigint,
    opts: { tamperChunk?: number; wrongWinner?: boolean } = {}
) {
    let current = await deployMarket(strike)
    for (let c = 0; c < N_CHUNKS; c++) {
        const hexes = ALL_HEADERS.slice(c * CHUNK, c * CHUNK + CHUNK)
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
            await current.methods.settle(chunk, CRANK_PKH, {
                next: { instance: next, balance: POT },
            } as MethodCallOptions<HashrateDerivative>)
            current = next
        } else {
            let winner =
                endpointTargetOf(ALL_HEADERS[12]) <= strike ? YES_PKH : NO_PKH
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

describe('HDRAFT-0001 PoC: Binary Difficulty Market — chunked ladder', () => {
    before(async () => {
        await HashrateDerivative.loadArtifact()
    })

    it('settles YES through 4 cranks when strike equals the real endpoint target', async () => {
        await expect(runLadder(ENDPOINT_TARGET)).not.to.be.rejected
    })

    it('settles NO when strike demands more difficulty than the endpoint has', async () => {
        await expect(runLadder(ENDPOINT_TARGET - 1n)).not.to.be.rejected
    })

    it('rejects a tampered header mid-ladder (chunk 1 nonce flip)', async () => {
        await expect(runLadder(ENDPOINT_TARGET, { tamperChunk: 1 })).to.be
            .rejected
    })

    it('rejects a cranker who builds the payout to the wrong side', async () => {
        await expect(runLadder(ENDPOINT_TARGET, { wrongWinner: true })).to.be
            .rejected
    })

    it('rejects skipping ahead (chunk 1 offered first breaks linkage)', async () => {
        const market = await deployMarket(ENDPOINT_TARGET)
        const next = market.next()
        next.tipHash = toByteString(sha256dHex(ALL_HEADERS[7]))
        next.headersSeen = 8n
        next.endpointTarget = 0n
        const call = async () =>
            market.methods.settle(chunkHeaders(1), CRANK_PKH, {
                next: { instance: next, balance: POT },
            } as MethodCallOptions<HashrateDerivative>)
        await expect(call()).to.be.rejected
    })
})
