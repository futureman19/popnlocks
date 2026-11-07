import { expect } from 'chai'
import { bsv } from 'scrypt-ts'
import { MainnetChain } from '../maker/chain'
import { p2pkhScriptHex } from '../src/offers/matchTx'

describe('maker independently resolved prevouts', () => {
    it('accepts only exact unspent txid/index/value and owner script', async () => {
        const pkh = '01'.repeat(20)
        const tx = new bsv.Transaction().addOutput(
            new bsv.Transaction.Output({
                script: bsv.Script.fromHex(p2pkhScriptHex(pkh)),
                satoshis: 12000,
            })
        )
        let value = 12000
        const reader = {
            height: async () => 10000,
            header: async () => '',
            tx: async () => tx,
            get: async () => [
                { tx_hash: tx.id, tx_pos: 0, value, height: 9990 },
            ],
        }
        const chain = new MainnetChain(reader)
        expect((await chain.resolve(tx.id, 0, pkh)).satoshis).eq(12000)
        value = 12001
        try {
            await chain.resolve(tx.id, 0, pkh)
            expect.fail('accepted')
        } catch (e) {
            expect((e as Error).message).eq('PREVOUT_MISMATCH')
        }
    })
    it('rejects malformed unspent rows instead of trusting client funding amounts', async () => {
        const chain = new MainnetChain({
            height: async () => 1,
            header: async () => '',
            tx: async () => new bsv.Transaction(),
            get: async () => [{ tx_hash: 'bad', tx_pos: -1, value: -1 }],
        })
        try {
            await chain.coins('01'.repeat(20))
            expect.fail('accepted')
        } catch (e) {
            expect((e as Error).message).eq('INVALID_UNSPENT')
        }
    })
})
