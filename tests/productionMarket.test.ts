import { compileMarketLockingScriptHex } from '../src/offers/matchTx'
import { expect } from 'chai'
import { PubKeyHash, bsv } from 'scrypt-ts'
import { PopnlocksProductionMarket as Market } from '../src/contracts/popnlocksProductionMarket'
import { crank } from '../src/settlement/crank'
import { fixture144 } from './locksmith.test'
import {
    marketAt,
    WatchedMarket,
    parseWatchlist,
    inspectWindow,
    WocReader,
} from '../scripts/locksmith'
import { getDefaultSigner } from './utils/txHelper'
import { main, verifySettlement } from '../scripts/locksmith'

const f = fixture144()
const m: WatchedMarket = {
    deployTxid: 'aa'.repeat(32),
    anchorHeight: 100,
    anchorTipHex: f.anchor,
    anchorBits: 0x207fffff,
    window: 144,
    strikeTarget: f.target.toString(),
    yesPKH: 'aa'.repeat(20),
    noPKH: 'bb'.repeat(20),
    bounty: 1500,
    pot: 20000,
}
const keeper = PubKeyHash('cc'.repeat(20))
async function ladder(strike: bigint, wrongWinner = false, tamper = false) {
    const params = { ...m, strikeTarget: strike.toString() }
    let current = marketAt(params, f.headers, 0)
    await current.connect(getDefaultSigner())
    const deploy = await current.deploy(params.pot)
    params.deployTxid = deploy.id
    const transactions = [deploy]
    for (let n = 0; n < 3; n++) {
        const next = n < 2 ? marketAt(params, f.headers, n + 1) : undefined
        const headers = f.headers.slice(n * 48, (n + 1) * 48)
        if (tamper && n === 1) headers[0] = '00'.repeat(80)
        let winner = f.target <= strike ? m.yesPKH : m.noPKH
        if (wrongWinner) winner = winner === m.yesPKH ? m.noPKH : m.yesPKH
        const result = await crank(
            current,
            headers,
            next,
            m.pot - n * m.bounty,
            keeper,
            PubKeyHash(winner)
        )
        transactions.push(result.tx)
        expect(result.tx.outputs[0].satoshis).equals(m.pot - (n + 1) * m.bounty)
        expect(result.tx.outputs[1].satoshis).equals(m.bounty)
        expect(result.tx.outputs[1].script.toHex()).equals(
            bsv.Script.buildPublicKeyHashOut(
                bsv.Address.fromPublicKeyHash(Buffer.from(keeper, 'hex'))
            ).toHex()
        )
        if (next) {
            expect(result.tx.outputs[0].script.toHex()).equals(
                next.lockingScript.toHex()
            )
            current = next
            await current.connect(getDefaultSigner())
        }
    }
    class LocalReader extends WocReader {
        async tx(id: string) {
            return transactions.find((t) => t.id === id)!
        }
        async header() {
            return f.headers[143]
        }
    }
    await verifySettlement(
        params,
        f.headers,
        transactions.map((t) => t.id),
        new LocalReader()
    )
    await rejects(
        () =>
            verifySettlement(
                { ...params, pot: params.pot + 1 },
                f.headers,
                transactions.map((t) => t.id),
                new LocalReader()
            ),
        /output mismatch/
    )
}
async function rejects(fn: () => Promise<unknown>, match: RegExp) {
    try {
        await fn()
        expect.fail('expected rejection')
    } catch (e) {
        expect(String(e)).matches(match)
    }
}
describe('POP-1 production Script VM ladder', function () {
    this.timeout(30000)
    before(() => Market.loadArtifact())
    it('uses byte-identical genesis scripts in offers, SDK deployment and watcher', () => {
        const script = compileMarketLockingScriptHex(
            {
                quoteId: 'local',
                market: m,
                makerSide: 'yes',
                makerStake: 10000,
                takerStake: 10000,
                makerPKH: m.yesPKH,
                expiryHeight: 120,
            },
            m.noPKH
        )
        expect(script).equals(marketAt(m, f.headers, 0).lockingScript.toHex())
    })
    it('settles YES at equality using final header, paying three bounties', () =>
        ladder(f.target))
    it('settles NO below the final target', () => ladder(f.target - 1n))
    it('rejects a wrong-side payout', () =>
        rejects(() => ladder(f.target, true), /hashOutputs|SCRIPT_ERR/))
    it('rejects tampered chunk-48 linkage', () =>
        rejects(() => ladder(f.target, false, true), /linkage|SCRIPT_ERR/))
    it('rejects unsupported geometry and pots unable to fund every crank', () => {
        expect(parseWatchlist([m])).deep.equals([m])
        for (const bad of [
            { ...m, window: 16 },
            { ...m, bounty: 0 },
            { ...m, pot: 4500 },
        ])
            expect(() => parseWatchlist([bad])).throws(/invalid/)
    })
    it('default CLI uses GET only with no key and no broadcast provider', async () => {
        const original = global.fetch
        let calls = 0
        global.fetch = (async (_url, init) => {
            expect(init?.method || 'GET').equals('GET')
            calls++
            return {
                ok: true,
                status: 200,
                text: async () =>
                    JSON.stringify({ chain: 'main', blocks: 1000000 }),
            } as Response
        }) as typeof fetch
        try {
            await main(['scripts/watchlist.example.json'])
            expect(calls).equals(1)
        } finally {
            global.fetch = original
        }
    })
    it('does not fetch headers or construct transactions before the window ends', async () => {
        class NoReads extends WocReader {
            async get(): Promise<unknown> {
                throw new Error('must not read')
            }
        }
        expect(await inspectWindow(m, new NoReads(), 243)).equals(undefined)
    })
})
