import { PopnlocksProductionMarket as Market } from '../contracts/popnlocksProductionMarket'
import {
    bsv,
    ByteString,
    FixedArray,
    PubKeyHash,
    Utils,
    MethodCallOptions,
} from 'scrypt-ts'

/** Output 0 is continuation/winner; output 1 always pays the locksmith.
 * External fee inputs/change belong only to the locksmith signer. */
export function bindCrankBuilder(
    current: Market,
    next: Market | undefined,
    balance: number,
    crankPKH: PubKeyHash,
    winner: PubKeyHash
) {
    const remaining = balance - Number(current.bounty)
    current.bindTxBuilder('settle', async (contract, options) => {
        const tx = new bsv.Transaction().addInput(
            contract.buildContractInput(options.fromUTXO)
        )
        tx.addOutput(
            new bsv.Transaction.Output({
                script: next
                    ? next.lockingScript
                    : bsv.Script.fromHex(
                          Utils.buildPublicKeyHashScript(winner)
                      ),
                satoshis: remaining,
            })
        )
        tx.addOutput(
            new bsv.Transaction.Output({
                script: bsv.Script.fromHex(
                    Utils.buildPublicKeyHashScript(crankPKH)
                ),
                satoshis: Number(current.bounty),
            })
        )
        tx.change(
            options.changeAddress || (await contract.signer.getDefaultAddress())
        )
        return {
            tx,
            atInputIndex: 0,
            nexts: next
                ? [{ instance: next, balance: remaining, atOutputIndex: 0 }]
                : [],
        }
    })
}
export async function crank(
    current: Market,
    headers: string[],
    next: Market | undefined,
    balance: number,
    crankPKH: PubKeyHash,
    winner: PubKeyHash
) {
    if (headers.length !== 48) throw new Error('expected 48 headers')
    bindCrankBuilder(current, next, balance, crankPKH, winner)
    return current.methods.settle(
        headers as FixedArray<ByteString, 48>,
        crankPKH,
        { verify: true } as MethodCallOptions<Market>
    )
}
