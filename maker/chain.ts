import { bsv } from 'scrypt-ts'
import { WocReader } from '../scripts/locksmith'
import { Block, Chain } from './service'
import { UtxoRef, p2pkhScriptHex } from '../src/offers/matchTx'
export class MainnetChain implements Chain {
    constructor(
        readonly reader: Pick<
            WocReader,
            'get' | 'height' | 'header' | 'tx'
        > = new WocReader()
    ) {}
    height() {
        return this.reader.height()
    }
    async block(height: number): Promise<Block> {
        if (!Number.isSafeInteger(height) || height < 1)
            throw new Error('INVALID_HEIGHT')
        // WocReader checks header hash and height, throttles requests and backs
        // off 65s on HTTP 429 (bounded attempts, 30s request timeout).
        const raw = Buffer.from(await this.reader.header(height), 'hex')
        if (raw.length !== 80) throw new Error('INVALID_HEADER')
        const bits = raw.readUInt32LE(72)
        const exponent = bits >>> 24,
            mantissa = bits & 0x7fffff
        if (bits & 0x800000 || exponent < 3 || exponent > 32 || !mantissa)
            throw new Error('INVALID_BITS')
        const target = BigInt(mantissa) * 256n ** BigInt(exponent - 3)
        return {
            height,
            hash: bsv.crypto.Hash.sha256sha256(raw).toString('hex'),
            bits,
            target: target.toString(),
        }
    }
    async coins(pkh: string): Promise<UtxoRef[]> {
        if (!/^[0-9a-f]{40}$/.test(pkh)) throw new Error('INVALID_PKH')
        const address = bsv.Address.fromPublicKeyHash(
            Buffer.from(pkh, 'hex'),
            bsv.Networks.mainnet
        ).toString()
        const rows = await this.reader.get(`/address/${address}/unspent`)
        if (!Array.isArray(rows)) throw new Error('INVALID_UNSPENT')
        return rows.map((r) => {
            if (
                !r ||
                !/^[0-9a-f]{64}$/.test(r.tx_hash) ||
                !Number.isSafeInteger(r.tx_pos) ||
                r.tx_pos < 0 ||
                r.tx_pos > 0xffffffff ||
                !Number.isSafeInteger(r.value) ||
                r.value < 1 ||
                r.value > 2100000000000000
            )
                throw new Error('INVALID_UNSPENT')
            return {
                txId: r.tx_hash,
                outputIndex: r.tx_pos,
                satoshis: r.value,
                script: p2pkhScriptHex(pkh),
            }
        })
    }
    async resolve(txid: string, vout: number, pkh: string): Promise<UtxoRef> {
        if (
            !/^[0-9a-f]{64}$/.test(txid) ||
            !Number.isSafeInteger(vout) ||
            vout < 0 ||
            vout > 0xffffffff
        )
            throw new Error('INVALID_OUTPOINT')
        const tx = await this.reader.tx(txid)
        const out = tx.outputs[vout]
        const coin = (await this.coins(pkh)).find(
            (u) => u.txId === txid && u.outputIndex === vout
        )
        if (
            tx.id !== txid ||
            !out ||
            !coin ||
            out.satoshis !== coin.satoshis ||
            out.script.toHex() !== coin.script
        )
            throw new Error('PREVOUT_MISMATCH')
        return coin
    }
}
