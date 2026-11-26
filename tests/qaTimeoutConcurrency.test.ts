/**
 * QA-only timeout/concurrency probes (card t_62e2ce8f).
 * Synthetic keys, fake chain data, temporary ledgers and loopback transport only.
 * No product edits, vault, credentials, funded coins, external DNS or broadcast.
 */
import { expect } from 'chai'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AddressInfo, connect } from 'net'
import { bsv } from 'scrypt-ts'
import { Maker, Config, Chain, Take } from '../maker/service'
import { Ledger } from '../maker/ledger'
import { server } from '../maker/http'
import { UtxoRef, makerSign, p2pkhScriptHex } from '../src/offers/matchTx'
import { Quote } from '../src/offers/quoteSchema'

const makerKey = bsv.PrivateKey.fromRandom('testnet')
const takerKey = bsv.PrivateKey.fromRandom('testnet')
const pkh = (key: bsv.PrivateKey) =>
    bsv.crypto.Hash.sha256ripemd160(key.publicKey.toBuffer()).toString('hex')
const makerPKH = pkh(makerKey)
const takerPKH = pkh(takerKey)
const HEIGHT = 10086
const ANCHOR = 10080
const ANCHOR_TIP = 'ab'.repeat(32)
const STRIKE =
    '26959535291011309493156476344723991336010898738574164086137773096960'

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

async function rejects(promise: Promise<unknown>, code: string) {
    try {
        await promise
        expect.fail('expected rejection ' + code)
    } catch (error) {
        expect((error as Error).message).eq(code)
    }
}

async function bounded<T>(promise: Promise<T>, milliseconds = 750): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error('QA bounded wait expired')),
                    milliseconds
                )
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

const coin = (id: string, owner: string): UtxoRef => ({
    txId: id.repeat(64),
    outputIndex: 0,
    satoshis: 30000,
    script: p2pkhScriptHex(owner),
})

function quote(id: string, side: 'no' | 'yes' = 'no'): Quote {
    return {
        quoteId: id,
        market: {
            anchorHeight: ANCHOR,
            anchorTipHex: ANCHOR_TIP,
            anchorBits: 0x1d00ffff,
            window: 144,
            strikeTarget: STRIKE,
            bounty: 1500,
        },
        makerSide: side,
        makerStake: 9000,
        takerStake: 11000,
        makerPKH,
        expiryHeight: HEIGHT + 4,
    }
}

function goodSignature(hex: string) {
    const tx = new bsv.Transaction(hex)
    tx.inputs[0].output = new bsv.Transaction.Output({
        script: bsv.Script.fromHex(p2pkhScriptHex(makerPKH)),
        satoshis: 30000,
    })
    return makerSign(tx, makerKey, 0)
}

async function rawResponse(port: number, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port }, () => {
            socket.write(payload)
        })
        let response = ''
        let settled = false
        const finish = (error?: Error) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            socket.destroy()
            if (error) reject(error)
            else resolve(response)
        }
        const timer = setTimeout(
            () => finish(new Error('raw loopback response was not bounded')),
            1500
        )
        socket.on('data', (chunk) => {
            response += chunk.toString('utf8')
        })
        socket.on('end', () => finish())
        socket.on('close', () => finish())
        socket.on('error', (error) => {
            if (response.includes(' 408 ')) finish()
            else finish(error)
        })
    })
}

describe('QA focused: offline timeout and concurrency boundaries', () => {
    let dir: string
    let config: Config
    let chain: Chain
    let ledger: Ledger
    let maker: Maker
    let clock: number
    let heightCalls: number
    let signerCalls: number

    const request = (value: Quote, txid = '3'.repeat(64)): Take => ({
        quoteId: value.quoteId,
        takerPKH,
        takerInput: { txid, vout: 0 },
    })
    const install = (value: Quote) => {
        maker.quotes = [value]
        maker.refreshedAt = clock
        maker.currentHeight = HEIGHT
    }
    const listen = async (value: unknown) => {
        const app = server(value as Maker)
        await new Promise<void>((resolve) =>
            app.listen(0, '127.0.0.1', resolve)
        )
        const port = (app.address() as AddressInfo).port
        return { app, port, base: `http://127.0.0.1:${port}` }
    }
    const close = (app: ReturnType<typeof server>) =>
        new Promise<void>((resolve) => app.close(() => resolve()))

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'pop-qa-concurrency-'))
        clock = 100000
        heightCalls = 0
        signerCalls = 0
        config = {
            live: true,
            makerPKH,
            pot: 20000,
            bounty: 1500,
            maxMarketStake: 50000,
            maxDailyExposure: 100000,
            maxCoinSats: 40000,
            killfile: join(dir, 'STOP_MAKER'),
        }
        chain = {
            height: async () => {
                heightCalls++
                return HEIGHT
            },
            block: async (h) => ({
                height: h,
                hash: ANCHOR_TIP,
                bits: 0x1d00ffff,
                target: STRIKE,
            }),
            coins: async () => [coin('1', makerPKH)],
            resolve: async (txid, vout, owner) => ({
                ...coin(txid[0], owner),
                outputIndex: vout,
            }),
        }
        ledger = new Ledger(join(dir, 'holds.jsonl'))
        maker = new Maker(
            config,
            chain,
            ledger,
            async (hex) => {
                signerCalls++
                return goodSignature(hex)
            },
            () => clock
        )
        install(quote('qa-focused-no'))
    })

    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('enforces header/body request timeouts with generic 408 responses', async () => {
        const headerCanary = 'qa-header-canary-408'
        const bodyCanary = 'qa-body-canary-408'
        const app = server({
            view: () => ({ quotes: [], status: {} }),
            take: async () => ({ halfSignedTxHex: '00' }),
        } as unknown as Maker)
        expect(app.requestTimeout).eq(15000)
        expect(app.headersTimeout).eq(10000)
        // Shrink only the QA server instance so the real Node timeout paths run fast.
        app.requestTimeout = 100
        app.headersTimeout = 60
        ;(
            app as unknown as { connectionsCheckingInterval: number }
        ).connectionsCheckingInterval = 20
        await new Promise<void>((resolve) =>
            app.listen(0, '127.0.0.1', resolve)
        )
        const port = (app.address() as AddressInfo).port
        try {
            const headers = await rawResponse(
                port,
                'POST /take HTTP/1.1\r\nHost: localhost\r\n' +
                    'Content-Type: application/json\r\nConnection: close\r\n' +
                    'X-QA-Canary: ' +
                    headerCanary +
                    '\r\n'
            )
            const body = await rawResponse(
                port,
                'POST /take HTTP/1.1\r\nHost: localhost\r\n' +
                    'Content-Type: application/json\r\nContent-Length: 100\r\n' +
                    'Connection: close\r\n\r\n{"qa":"' +
                    bodyCanary +
                    '"'
            )
            for (const response of [headers, body]) {
                expect(response.split('\r\n')[0]).eq(
                    'HTTP/1.1 408 Request Timeout'
                )
                expect(response).not.includes(headerCanary)
                expect(response).not.includes(bodyCanary)
            }
        } finally {
            await close(app)
        }
    })

    it('bounds a slow concurrent HTTP take with BUSY and sanitizes its failure', async () => {
        const entered = deferred()
        const outcome = deferred<string>()
        maker = new Maker(
            config,
            chain,
            ledger,
            async () => {
                signerCalls++
                entered.resolve()
                return outcome.promise
            },
            () => clock
        )
        install(quote('qa-focused-slow-http'))
        const { app, base } = await listen(maker)
        const first = fetch(base + '/take', {
            method: 'POST',
            body: JSON.stringify(request(maker.quotes[0])),
            headers: { 'Content-Type': 'application/json' },
        })
        try {
            await bounded(entered.promise)
            expect(ledger.all()).length(1)
            const second = await bounded(
                fetch(base + '/take', {
                    method: 'POST',
                    body: JSON.stringify(request(maker.quotes[0])),
                    headers: { 'Content-Type': 'application/json' },
                })
            )
            expect(second.status).eq(409)
            expect(await second.json()).deep.eq({ error: 'BUSY' })
            expect(signerCalls).eq(1)
            outcome.reject(new Error('synthetic-secret-internal-detail'))
            const slow = await bounded(first)
            expect(slow.status).eq(503)
            const text = await slow.text()
            expect(text).eq('{"error":"UNAVAILABLE"}')
            expect(JSON.parse(text)).deep.eq({ error: 'UNAVAILABLE' })
            expect(text).not.includes('synthetic-secret-internal-detail')
            expect(ledger.all()).length(1)
            expect(signerCalls).eq(1)
        } finally {
            outcome.reject(new Error('QA cleanup'))
            await first.catch(() => undefined)
            await close(app)
        }
    })

    it('publishes only honest empty books for stale and stopped HTTP views', async () => {
        maker.refreshedAt = clock - 90001
        const { app, base } = await listen(maker)
        try {
            const stale = (await (await fetch(base + '/quotes')).json()) as {
                quotes: unknown[]
                status: { stale: boolean; stopped: boolean }
            }
            expect(stale.quotes).deep.eq([])
            expect(stale.status.stale).eq(true)
            expect(stale.status.stopped).eq(false)
            maker.refreshedAt = clock
            writeFileSync(config.killfile, '')
            const stopped = (await (await fetch(base + '/quotes')).json()) as {
                quotes: unknown[]
                status: { stale: boolean; stopped: boolean }
            }
            expect(stopped.quotes).deep.eq([])
            expect(stopped.status.stale).eq(false)
            expect(stopped.status.stopped).eq(true)
        } finally {
            await close(app)
        }
    })

    it('rejects overlapping duplicate and distinct takes at the first height read', async () => {
        const heightStarted = deferred()
        const firstHeight = deferred<number>()
        chain.height = async () => {
            heightCalls++
            if (heightCalls === 1) {
                heightStarted.resolve()
                return firstHeight.promise
            }
            return HEIGHT
        }
        maker = new Maker(
            config,
            chain,
            ledger,
            async (hex) => {
                signerCalls++
                return goodSignature(hex)
            },
            () => clock
        )
        const firstQuote = quote('qa-focused-race')
        const otherQuote = quote('qa-focused-other', 'yes')
        maker.quotes = [firstQuote, otherQuote]
        maker.refreshedAt = clock
        const first = maker.take(request(firstQuote))
        try {
            await bounded(heightStarted.promise)
            expect(heightCalls).eq(1)
            expect(ledger.all()).length(0)
            expect(signerCalls).eq(0)
            const before = heightCalls
            const duplicate = maker.take(request(firstQuote))
            const other = maker.take(request(otherQuote, '4'.repeat(64)))
            // BUSY is the synchronous pre-await gate, before any competing chain work.
            expect(heightCalls).eq(before)
            expect(ledger.all()).length(0)
            expect(signerCalls).eq(0)
            await rejects(duplicate, 'BUSY')
            await rejects(other, 'BUSY')
            expect(heightCalls).eq(before)
            expect(ledger.all()).length(0)
            expect(signerCalls).eq(0)
            firstHeight.resolve(HEIGHT)
            expect((await first).halfSignedTxHex).matches(/^[0-9a-f]+$/)
            expect(signerCalls).eq(1)
            expect(ledger.all()).length(1)
        } finally {
            firstHeight.resolve(HEIGHT)
            await first.catch(() => undefined)
        }
    })

    it('rejects duplicate quote reservations and reused coins across maker instances', async () => {
        const firstQuote = quote('qa-focused-replay')
        install(firstQuote)
        await maker.take(request(firstQuote))
        expect(signerCalls).eq(1)
        maker.quotes = [firstQuote, firstQuote]
        const beforeReplayHeightCalls = heightCalls
        await rejects(maker.take(request(firstQuote)), 'RESERVED')
        expect(heightCalls).eq(beforeReplayHeightCalls)
        expect(ledger.all()).length(1)
        expect(() =>
            ledger.reserve(
                {
                    quoteId: 'qa-focused-different-quote',
                    market: ANCHOR_TIP,
                    coin: '1'.repeat(64) + ':0',
                    stake: 9000,
                    at: clock,
                },
                config.maxMarketStake,
                config.maxDailyExposure
            )
        ).throws('RESERVED')
        const second = new Maker(
            config,
            chain,
            ledger,
            async (hex) => {
                signerCalls++
                return goodSignature(hex)
            },
            () => clock
        )
        install(quote('qa-focused-no'))
        second.quotes = [quote('qa-focused-reused-coin', 'yes')]
        second.refreshedAt = clock
        await rejects(
            second.take(request(second.quotes[0], '4'.repeat(64))),
            'NO_SIZED_COIN'
        )
        expect(signerCalls).eq(1)
        expect(ledger.all()).length(1)
    })

    it('rejects stale quotes after a slow height response before reserve or signing', async () => {
        const heightStarted = deferred()
        const slowHeight = deferred<number>()
        chain.height = async () => {
            heightCalls++
            heightStarted.resolve()
            return slowHeight.promise
        }
        install(quote('qa-focused-slow-height'))
        const pending = maker.take(request(maker.quotes[0]))
        await bounded(heightStarted.promise)
        clock += 90001
        slowHeight.resolve(HEIGHT)
        await rejects(pending, 'STALE_QUOTE')
        expect(signerCalls).eq(0)
        expect(ledger.all()).length(0)
    })

    it('checks STOP_MAKER before work and again before durable reservation', async () => {
        install(quote('qa-focused-pre-stop'))
        writeFileSync(config.killfile, '')
        await rejects(maker.take(request(maker.quotes[0])), 'STOPPED')
        expect(heightCalls).eq(0)
        expect(signerCalls).eq(0)
        expect(ledger.all()).length(0)
        rmSync(config.killfile, { force: true })
        chain.resolve = async (txid, vout, owner) => {
            if (txid[0] === '1') writeFileSync(config.killfile, '')
            return { ...coin(txid[0], owner), outputIndex: vout }
        }
        await rejects(maker.take(request(maker.quotes[0])), 'STOPPED')
        expect(signerCalls).eq(0)
        expect(ledger.all()).length(0)
    })

    it('keeps a durable hold when stopped after reserve but before signing', async () => {
        install(quote('qa-focused-pre-sign-stop'))
        const reserve = ledger.reserve.bind(ledger)
        ledger.reserve = (hold, maxMarket, maxDaily) => {
            reserve(hold, maxMarket, maxDaily)
            writeFileSync(config.killfile, '')
        }
        await rejects(maker.take(request(maker.quotes[0])), 'STOPPED')
        expect(signerCalls).eq(0)
        expect(ledger.all()).length(1)
        await rejects(maker.take(request(maker.quotes[0])), 'STOPPED')
        expect(signerCalls).eq(0)
        expect(ledger.all()).length(1)
    })

    it('retains the documented in-flight signature boundary without new work', async () => {
        const entered = deferred()
        const release = deferred()
        maker = new Maker(
            config,
            chain,
            ledger,
            async (hex) => {
                signerCalls++
                writeFileSync(config.killfile, '')
                entered.resolve()
                await release.promise
                return goodSignature(hex)
            },
            () => clock
        )
        install(quote('qa-focused-in-flight-stop'))
        const first = maker.take(request(maker.quotes[0]))
        await bounded(entered.promise)
        expect(ledger.all()).length(1)
        await rejects(maker.take(request(maker.quotes[0])), 'STOPPED')
        expect(signerCalls).eq(1)
        expect(maker.view().quotes).deep.eq([])
        expect(maker.view().status.stopped).eq(true)
        release.resolve()
        expect((await first).halfSignedTxHex).matches(/^[0-9a-f]+$/)
        expect(signerCalls).eq(1)
        expect(ledger.all()).length(1)
    })
})
