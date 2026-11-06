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
import * as fs from 'fs'
import * as path from 'path'

use(chaiAsPromised)

// Golden vectors: 17 real BSV mainnet headers (anchor 830000 + 16 following),
// reconstruction-verified against sha256d(header) == block hash at fetch time.
const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'headers.json'), 'utf8')
)

const HEADERS = fixture.headers.map((h: string) =>
    toByteString(h)
) as FixedArray<ByteString, 16>
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
        BOUNTY
    )
    await market.connect(getDefaultSigner())
    await market.deploy(POT)
    // The client derives the outcome from the same public headers; the contract
    // re-derives and enforces it on-chain.
    const winner =
        endpointTargetOf(fixture.headers[12]) <= strikeTarget ? YES_PKH : NO_PKH
    market.bindTxBuilder(
        'settle',
        settleTxBuilder(winner, BigInt(POT) - BOUNTY)
    )
    return market
}

function tamperedHeaders(
    index: number,
    byteOffset: number
): FixedArray<ByteString, 16> {
    const copy = fixture.headers.slice()
    const h = copy[index]
    copy[index] = h.slice(0, byteOffset) + 'ff' + h.slice(byteOffset + 2)
    return copy.map((x: string) => toByteString(x)) as FixedArray<
        ByteString,
        16
    >
}

describe('HDRAFT-0001 PoC: Binary Difficulty Market', () => {
    before(async () => {
        await HashrateDerivative.loadArtifact()
    })

    it('settles YES when strike equals the real endpoint target', async () => {
        const market = await deployMarket(ENDPOINT_TARGET)
        const call = async () => market.methods.settle(HEADERS, CRANK_PKH)
        await expect(call()).not.to.be.rejected
    })

    it('settles NO when strike demands more difficulty than the endpoint has', async () => {
        // strike target one less than endpoint target => endpointTarget <= strike fails
        const market = await deployMarket(ENDPOINT_TARGET - 1n)
        const call = async () => market.methods.settle(HEADERS, CRANK_PKH)
        await expect(call()).not.to.be.rejected
    })

    it('rejects a chain with broken linkage (swapped headers)', async () => {
        const copy = fixture.headers.slice()
        ;[copy[3], copy[4]] = [copy[4], copy[3]]
        const swapped = copy.map((x: string) => toByteString(x)) as FixedArray<
            ByteString,
            16
        >
        const market = await deployMarket(ENDPOINT_TARGET)
        const call = async () => market.methods.settle(swapped, CRANK_PKH)
        await expect(call()).to.be.rejected
    })

    it('rejects a tampered header (nonce flipped breaks PoW + downstream linkage)', async () => {
        const tampered = tamperedHeaders(5, 152) // last byte of nonce (hex offset 152..154)
        const market = await deployMarket(ENDPOINT_TARGET)
        const call = async () => market.methods.settle(tampered, CRANK_PKH)
        await expect(call()).to.be.rejected
    })
})
