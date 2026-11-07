/* Default is read-only: no vault runner or state directory is used without --live. */
import { mkdirSync, openSync, closeSync, unlinkSync, readFileSync } from 'fs'
import { resolve, join } from 'path'
import { Config, Maker } from './service'
import { MainnetChain } from './chain'
import { Ledger } from './ledger'
import { vaultSigner } from './adapters'
import { server } from './http'

export async function main(args = process.argv.slice(2)) {
    if (args.some((a) => a !== '--live' && !a.startsWith('--config=')))
        throw new Error(
            'usage: maker/cli.ts [--config=public-config.json] [--live]'
        )
    const file = args.find((a) => a.startsWith('--config='))?.slice(9)
    const raw = file ? JSON.parse(readFileSync(resolve(file), 'utf8')) : {}
    const live = args.includes('--live')
    const config: Config = {
        live,
        makerPKH: raw.makerPKH ?? '00'.repeat(20),
        pot: raw.pot ?? 20000,
        bounty: raw.bounty ?? 1500,
        maxMarketStake: raw.maxMarketStake ?? 50000,
        maxDailyExposure: raw.maxDailyExposure ?? 200000,
        maxCoinSats: raw.maxCoinSats ?? 25000,
        killfile: resolve(raw.killfile ?? 'STOP_MAKER'),
    }
    const port = raw.port ?? 8787
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
        throw new Error('INVALID_PORT')
    if (
        live &&
        (!file ||
            config.makerPKH === '00'.repeat(20) ||
            typeof raw.vaultCwd !== 'string' ||
            !['maxMarketStake', 'maxDailyExposure', 'maxCoinSats'].every(
                (k) => Number.isSafeInteger(raw[k]) && raw[k] > 0
            ))
    )
        throw new Error('LIVE_REQUIRES_EXPLICIT_PUBLIC_CONFIG')
    const state = resolve(raw.stateDir ?? 'maker/state')
    const ledger = new Ledger(join(state, 'holds.jsonl'))
    // The dry-run signer is not even wired to the subprocess adapter.
    const signer = live
        ? vaultSigner(config, resolve(raw.vaultCwd))
        : async () => {
              throw new Error('DRY_RUN')
          }
    const maker = new Maker(config, new MainnetChain(), ledger, signer)
    if (live) {
        mkdirSync(state, { recursive: true })
        const lock = join(state, 'maker.lock')
        const fd = openSync(lock, 'wx', 0o600)
        process.once('exit', () => {
            closeSync(fd)
            unlinkSync(lock)
        })
        ledger.all() // fail closed on malformed/truncated persisted exposure
    }
    const app = server(maker, raw.origin ?? 'https://popnlocks.com')
    await new Promise<void>((done, reject) => {
        app.once('error', reject)
        app.listen(port, raw.host ?? '127.0.0.1', done)
    })
    console.log(
        JSON.stringify({
            mode: live ? 'live' : 'dry-run',
            port,
            flagship: 'Daily Pop',
            feeRate: 100,
        })
    )
    let running = true
    const stopPoll = setInterval(() => {
        if (maker.stopped()) maker.quotes = []
    }, 10000)
    const stop = () => {
        running = false
        clearInterval(stopPoll)
        app.close()
        process.exit(0)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    while (running) {
        try {
            await maker.refresh()
        } catch {
            maker.quotes = []
            console.error(
                'Quote refresh unavailable; retrying read-only chain requests'
            )
        }
        await new Promise((r) => setTimeout(r, 20000))
    }
}
if (require.main === module)
    main().catch((e) => {
        console.error((e as Error).message)
        process.exit(1)
    })
