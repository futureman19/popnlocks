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
    len,
    toByteString,
} from 'scrypt-ts'

/** POP-1 daily market: 144 post-anchor headers, three 48-header cranks.
 * Endpoint index 143 is the final header. Bounty is paid on EACH crank.
 * Separate artifact; POP-0 geometry and economics remain unchanged. */
export class PopnlocksProductionMarket extends SmartContract {
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

    // Anchor block's compact bits — base for the difficulty floor (§4 Lite).
    // Counterparties verify off-chain that this matches the anchor block.
    @prop()
    anchorBits: bigint

    // --- ladder state ---
    @prop(true)
    tipHash: ByteString // last verified header digest (internal order)

    @prop(true)
    headersSeen: bigint

    @prop(true)
    endpointTarget: bigint // captured when the ladder crosses ENDPOINT_IDX

    @prop(true)
    prevTarget: bigint // last header's target — drift base for the next chunk

    static readonly CHUNK: bigint = 48n
    static readonly TOTAL: bigint = 144n
    static readonly ENDPOINT_IDX: bigint = 143n

    // §4 Lite DAA tier: per-header target drift bound (+/-5% — natural cw-144
    // drift measured at <=1.9% on golden mainnet data) and a hard floor: no
    // header's target may exceed 8x the anchor's (faking the window costs at
    // least ~1/8 of real mainnet work per block; pot cap in §5 prices the rest).
    static readonly FLOOR_FACTOR: bigint = 8n

    constructor(
        anchorTip: ByteString,
        strikeTarget: bigint,
        yesPKH: PubKeyHash,
        noPKH: PubKeyHash,
        bounty: bigint,
        anchorBits: bigint,
        tipHash: ByteString,
        headersSeen: bigint,
        endpointTarget: bigint,
        prevTarget: bigint
    ) {
        super(...arguments)
        this.anchorTip = anchorTip
        this.strikeTarget = strikeTarget
        this.yesPKH = yesPKH
        this.noPKH = noPKH
        this.bounty = bounty
        this.anchorBits = anchorBits
        this.tipHash = tipHash
        this.headersSeen = headersSeen
        this.endpointTarget = endpointTarget
        this.prevTarget = prevTarget
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
    public settle(headers: FixedArray<ByteString, 48>, crankPKH: PubKeyHash) {
        assert(
            this.headersSeen >= 0n &&
                this.headersSeen < PopnlocksProductionMarket.TOTAL,
            'invalid rung'
        )
        assert(
            this.headersSeen % PopnlocksProductionMarket.CHUNK == 0n,
            'unaligned rung'
        )
        assert(this.bounty > 0n, 'invalid bounty')
        assert(
            this.ctx.utxo.value >
                this.bounty *
                    ((PopnlocksProductionMarket.TOTAL - this.headersSeen) /
                        PopnlocksProductionMarket.CHUNK),
            'insufficient pot'
        )
        let prev: ByteString = this.tipHash
        let endpointTarget: bigint = this.endpointTarget
        const anchorTarget: bigint = PopnlocksProductionMarket.bits2target(
            this.anchorBits
        )
        let prevTarget: bigint = this.prevTarget

        for (let i: bigint = 0n; i < PopnlocksProductionMarket.CHUNK; i++) {
            const header: ByteString = headers[Number(i)]

            assert(len(header) == 80n, 'invalid header length')
            // 1. Linkage: this header's prevHash must equal the previous digest.
            assert(slice(header, 4n, 36n) == prev, 'broken header linkage')

            // 2. PoW: sha256d(header) interpreted as little-endian uint256
            //    must be below the target declared by this header's own bits.
            const bits: bigint = Utils.fromLEUnsigned(slice(header, 72n, 76n))
            const target: bigint = PopnlocksProductionMarket.bits2target(bits)
            const digest: ByteString = hash256(header)
            assert(Utils.fromLEUnsigned(digest) < target, 'insufficient PoW')

            // 3. Lite DAA: floor first (anchor-relative), then drift bound.
            assert(
                target <= anchorTarget * PopnlocksProductionMarket.FLOOR_FACTOR,
                'difficulty floor breached'
            )
            assert(
                target * 20n >= prevTarget * 19n &&
                    target * 20n <= prevTarget * 21n,
                'bits drift bound exceeded'
            )
            prevTarget = target

            if (
                this.headersSeen + i ==
                PopnlocksProductionMarket.ENDPOINT_IDX
            ) {
                endpointTarget = target
            }
            prev = digest
        }

        const seen: bigint = this.headersSeen + PopnlocksProductionMarket.CHUNK
        const balance: bigint = this.ctx.utxo.value
        let outputs: ByteString = toByteString('')

        if (seen < PopnlocksProductionMarket.TOTAL) {
            // Mid-ladder: preserve collateral less this crank bounty.
            this.tipHash = prev
            this.headersSeen = seen
            this.endpointTarget = endpointTarget
            this.prevTarget = prevTarget
            outputs =
                this.buildStateOutput(balance - this.bounty) +
                Utils.buildPublicKeyHashOutput(crankPKH, this.bounty) +
                this.buildChangeOutput()
        } else {
            // Final crank: difficulty at/above strike <=> target at/below strike.
            const winner: PubKeyHash =
                endpointTarget <= this.strikeTarget ? this.yesPKH : this.noPKH
            outputs =
                Utils.buildPublicKeyHashOutput(winner, balance - this.bounty) +
                Utils.buildPublicKeyHashOutput(crankPKH, this.bounty) +
                this.buildChangeOutput()
        }

        assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
    }
}
