import {
    method,
    prop,
    SmartContract,
    hash256,
    assert,
    ByteString,
    PubKeyHash,
    FixedArray,
    Utils,
    slice,
} from 'scrypt-ts'

/*
 * HDRAFT-0001 PoC — Binary Difficulty Market, stateless core.
 *
 * One-shot covenant: YES and NO collateral locked at deploy. Anyone settles by
 * presenting the 16 real headers following the anchor (12-block window + 4
 * confirmation). The contract verifies linkage + per-header PoW in-script,
 * reads difficulty (bits -> target) at the endpoint header, pays the winner,
 * and pays a bounty to whoever cranked settlement.
 *
 * PoC scope: single-call settle over 16 headers. The chunked ladder (§3.3 of
 * the spec) is the same verification loop with continuation state — next gate.
 */
export class HashrateDerivative extends SmartContract {
    // Internal byte order (raw sha256d digest order) of the anchor block hash.
    @prop()
    anchorTip: ByteString

    // Strike expressed as a 256-bit target. endpointTarget <= strikeTarget -> YES.
    @prop()
    strikeTarget: bigint

    @prop()
    yesPKH: PubKeyHash

    @prop()
    noPKH: PubKeyHash

    @prop()
    bounty: bigint

    static readonly N_HEADERS: bigint = 16n
    static readonly ENDPOINT_IDX: bigint = 12n

    constructor(
        anchorTip: ByteString,
        strikeTarget: bigint,
        yesPKH: PubKeyHash,
        noPKH: PubKeyHash,
        bounty: bigint
    ) {
        super(...arguments)
        this.anchorTip = anchorTip
        this.strikeTarget = strikeTarget
        this.yesPKH = yesPKH
        this.noPKH = noPKH
        this.bounty = bounty
    }

    // Expand Bitcoin's compact bits to the full 256-bit target.
    // target = mantissa * 256^(exponent - 3); exponent bounded, loop unrolled.
    @method()
    static bits2target(bits: bigint): bigint {
        // 2^24 and 2^23 as literals (shift/mask ops are not transformable)
        const exponent: bigint = bits / 16777216n
        let target: bigint = bits % 8388608n
        for (let i: bigint = 0n; i < 32n; i++) {
            if (i < exponent - 3n) {
                target *= 256n
            }
        }
        return target
    }

    @method()
    public settle(headers: FixedArray<ByteString, 16>, crankPKH: PubKeyHash) {
        let prev: ByteString = this.anchorTip
        let endpointTarget: bigint = 0n

        for (let i: bigint = 0n; i < HashrateDerivative.N_HEADERS; i++) {
            const header: ByteString = headers[Number(i)]

            // 1. Linkage: this header's prevHash must equal the previous digest.
            assert(slice(header, 4n, 36n) == prev, 'broken header linkage')

            // 2. PoW: sha256d(header) interpreted as little-endian uint256
            //    must be below the target declared by this header's own bits.
            const bits: bigint = Utils.fromLEUnsigned(slice(header, 72n, 76n))
            const target: bigint = HashrateDerivative.bits2target(bits)
            const digest: ByteString = hash256(header)
            assert(Utils.fromLEUnsigned(digest) < target, 'insufficient PoW')

            if (i == HashrateDerivative.ENDPOINT_IDX) {
                endpointTarget = target
            }
            prev = digest
        }

        // 3. Outcome: difficulty at/above strike <=> endpoint target at/below strike target.
        const winner: PubKeyHash =
            endpointTarget <= this.strikeTarget ? this.yesPKH : this.noPKH

        // 4. Payout: winner gets pot minus bounty; cranker claims the bounty.
        const balance: bigint = this.ctx.utxo.value
        const outputs: ByteString =
            Utils.buildPublicKeyHashOutput(winner, balance - this.bounty) +
            Utils.buildPublicKeyHashOutput(crankPKH, this.bounty) +
            this.buildChangeOutput()
        assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
    }
}
