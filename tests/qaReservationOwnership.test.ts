import { strict as assert } from 'assert'
import { spawn, spawnSync } from 'child_process'
import { createRequire } from 'module'
import {
    existsSync,
    openSync,
    closeSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
    appendFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { bsv } from 'scrypt-ts'
import { Maker } from '../maker/service'
import { Ledger } from '../maker/ledger'
import { p2pkhScriptHex } from '../src/offers/matchTx'

const pause = () => new Promise((r) => setTimeout(r, 10))
async function until(check: () => boolean) {
    const end = Date.now() + 30000
    while (!check()) {
        if (Date.now() > end) throw new Error('FIXTURE_TIMEOUT')
        await pause()
    }
}
const pkh = () =>
    bsv.crypto.Hash.sha256ripemd160(
        bsv.PrivateKey.fromRandom('testnet').publicKey.toBuffer()
    ).toString('hex')
const market = {
    anchorHeight: 10080,
    anchorTipHex: 'ab'.repeat(32),
    anchorBits: 0x1d00ffff,
    window: 144,
    strikeTarget:
        '26959535291011309493156476344723991336010898738574164086137773096960',
    bounty: 1500,
}
const coinId = '2'.repeat(64)

// Only the CLI owns the lock. Enter its real startup path, replacing the three
// external adapter factories before entry; never open a socket or start refresh.
async function worker(
    dir: string,
    name: string,
    quoteId: string,
    phase: string,
    peer: string
) {
    const log = (event: string) =>
        appendFileSync(join(dir, name + '.events'), event + '\n')
    const load = createRequire(__filename)
    const chainModule = load('../maker/chain')
    const adapter = load('../maker/adapters')
    const http = load('../maker/http')
    let maker: Maker
    const coin = (txId: string, owner: string) => ({
        txId,
        outputIndex: 0,
        satoshis: 30000,
        script: p2pkhScriptHex(owner),
    })
    chainModule.MainnetChain = class {
        async height() {
            log('chain')
            return 10086
        }
        async block() {
            log('chain')
            return {
                hash: market.anchorTipHex,
                bits: market.anchorBits,
                target: market.strikeTarget,
            }
        }
        async coins(owner: string) {
            log('chain')
            return [coin(coinId, owner)]
        }
        async resolve(id: string, _v: number, owner: string) {
            log('chain')
            return coin(id, owner)
        }
    }
    adapter.vaultSigner = () => async () => {
        log('sign')
        throw new Error('INERT')
    }
    const admitted = new Error('fixture admission')
    http.server = (instance: Maker) => {
        maker = instance
        throw admitted
    }
    const { main } = load('../maker/cli')
    writeFileSync(join(dir, name + '.ready'), '')
    await until(() => existsSync(join(dir, name + '.go')))
    try {
        await main(['--live', '--config=' + join(dir, 'config.json')])
        throw new Error('UNEXPECTED')
    } catch (e) {
        if (e !== admitted) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
                throw new Error('STARTUP_FAILED')
            log('EEXIST')
            return
        }
    }
    log('admitted')
    if (peer !== '-')
        await until(
            () =>
                existsSync(join(dir, peer + '.events')) &&
                readFileSync(join(dir, peer + '.events'), 'utf8').includes(
                    'EEXIST'
                )
        )
    const m = maker!
    m.quotes = [
        {
            market,
            quoteId,
            makerSide: 'no',
            makerPKH: m.config.makerPKH,
            makerStake: 9000,
            takerStake: 11000,
            expiryHeight: 10090,
        },
    ]
    m.refreshedAt = Date.now()
    if (phase === 'stop') writeFileSync(m.config.killfile, '')
    if (phase === 'crash') {
        const reserve = m.ledger.reserve.bind(m.ledger)
        m.ledger.reserve = (...args) => {
            reserve(...args)
            log('reserved')
            process.kill(process.pid, 'SIGKILL')
            throw new Error('CRASH_RETURNED')
        }
    }
    try {
        await m.take({
            quoteId,
            takerPKH: pkh(),
            takerInput: { txid: '3'.repeat(64), vout: 0 },
        })
        throw new Error('UNEXPECTED_SUCCESS')
    } catch (e) {
        const code = (e as Error).message
        if (!['INERT', 'STOPPED', 'RESERVED', 'NO_SIZED_COIN'].includes(code))
            throw new Error('TAKE_FAILED')
        log(code)
    }
}
if (require.main === module) {
    worker(
        process.argv[2],
        process.argv[3],
        process.argv[4],
        process.argv[5],
        process.argv[6]
    ).catch(() => {
        process.exitCode = 1
    })
} else
    describe('CLI state directory ownership (offline)', function () {
        this.timeout(120000)
        let dir: string
        const children = new Set<ReturnType<typeof spawn>>()
        const events = (name: string) =>
            readFileSync(join(dir, name + '.events'), 'utf8')
                .trim()
                .split('\n')
        const holds = () => new Ledger(join(dir, 'holds.jsonl')).all()
        beforeEach(() => {
            dir = mkdtempSync(join(tmpdir(), 'pop-ownership-'))
            writeFileSync(
                join(dir, 'config.json'),
                JSON.stringify({
                    stateDir: dir,
                    killfile: join(dir, 'STOP'),
                    vaultCwd: dir,
                    makerPKH: pkh(),
                    maxMarketStake: 90000,
                    maxDailyExposure: 90000,
                    maxCoinSats: 30000,
                })
            )
        })
        afterEach(async () => {
            await Promise.all(
                [...children].map(
                    (c) =>
                        new Promise<void>((r) => {
                            c.once('close', () => r())
                            c.kill('SIGKILL')
                        })
                )
            )
            rmSync(dir, { recursive: true, force: true })
        })
        const offlineEnv = () => ({
            SystemRoot: process.env.SystemRoot,
            PATH: process.env.PATH,
            TEMP: dir,
            TMP: dir,
            NETWORK: 'local',
            npm_config_offline: 'true',
        })
        function start(name: string, id: string, phase = 'normal', peer = '-') {
            const c = spawn(
                process.execPath,
                [
                    '-r',
                    require.resolve('ts-node/register/transpile-only'),
                    __filename,
                    dir,
                    name,
                    id,
                    phase,
                    peer,
                ],
                {
                    cwd: process.cwd(),
                    env: offlineEnv(),
                    stdio: 'ignore',
                    timeout: 45000,
                    killSignal: 'SIGKILL',
                }
            )
            children.add(c)
            return new Promise<number | null>((r) => {
                c.once('error', () => r(-1))
                c.once('close', (code) => {
                    children.delete(c)
                    r(code)
                })
            })
        }
        async function release(...names: string[]) {
            await until(() =>
                names.every((n) => existsSync(join(dir, n + '.ready')))
            )
            for (const n of names) writeFileSync(join(dir, n + '.go'), '')
        }
        for (const distinct of [false, true])
            it(
                distinct
                    ? 'distinct quotes cannot share one coin'
                    : 'same quote has one owner; restart rejects replay before chain reads',
                async () => {
                    const a = start('a', 'quote-a', 'normal', 'b'),
                        b = start(
                            'b',
                            distinct ? 'quote-b' : 'quote-a',
                            'normal',
                            'a'
                        )
                    await release('a', 'b')
                    assert.deepEqual(await Promise.all([a, b]), [0, 0])
                    const loser = events('a')[0] === 'EEXIST' ? 'a' : 'b',
                        winner = loser === 'a' ? 'b' : 'a'
                    assert.deepEqual(events(loser), ['EEXIST'])
                    assert.equal(
                        events(winner).filter((x) => x === 'sign').length,
                        1
                    )
                    assert.equal(events(winner).slice(-1)[0], 'INERT')
                    const rows = holds()
                    assert.equal(rows.length, 1)
                    assert.equal(
                        rows[0].quoteId,
                        distinct ? 'quote-' + winner : 'quote-a'
                    )
                    assert.equal(rows[0].coin, coinId + ':0')
                    const retry = start(
                        'retry',
                        distinct ? 'quote-' + loser : 'quote-a'
                    )
                    await release('retry')
                    assert.equal(await retry, 0)
                    if (distinct) {
                        assert.equal(
                            events('retry').slice(-1)[0],
                            'NO_SIZED_COIN'
                        )
                        assert.ok(!events('retry').includes('sign'))
                    } else
                        assert.deepEqual(events('retry'), [
                            'admitted',
                            'RESERVED',
                        ])
                    assert.deepEqual(holds(), rows)
                }
            )
        it('retains a previous-day hold on restart', async () => {
            const row = {
                at: 1,
                stake: 9000,
                quoteId: 'old',
                market: market.anchorTipHex,
                coin: coinId + ':0',
            }
            new Ledger(join(dir, 'holds.jsonl')).reserve(row, 90000, 90000)
            const c = start('old', 'old')
            await release('old')
            assert.equal(await c, 0)
            assert.deepEqual(events('old'), ['admitted', 'RESERVED'])
            assert.deepEqual(holds(), [row])
        })
        it('a stop before reservation leaves no hold', async () => {
            const c = start('stop', 'q', 'stop')
            await release('stop')
            assert.equal(await c, 0)
            assert.deepEqual(events('stop'), ['admitted', 'STOPPED'])
            assert.deepEqual(holds(), [])
        })
        it('abrupt exit after reservation preserves lock and hold without signing', async () => {
            const c = start('crash', 'q', 'crash')
            await release('crash')
            assert.notEqual(await c, 0)
            assert.equal(events('crash').slice(-1)[0], 'reserved')
            assert.ok(!events('crash').includes('sign'))
            const rows = holds()
            assert.equal(rows.length, 1)
            assert.equal(rows[0].quoteId, 'q')
            assert.equal(rows[0].coin, coinId + ':0')
            const retry = start('retry', 'q')
            await release('retry')
            assert.equal(await retry, 0)
            assert.deepEqual(events('retry'), ['EEXIST'])
            assert.deepEqual(holds(), rows)
            assert.ok(existsSync(join(dir, 'maker.lock')))
        })
        it('reports a held lock without exposing local paths from the executable', () => {
            const lock = join(dir, 'maker.lock')
            const config = join(dir, 'config.json')
            const fd = openSync(lock, 'wx', 0o600)
            try {
                const run = spawnSync(
                    process.execPath,
                    [
                        '-r',
                        require.resolve('ts-node/register/transpile-only'),
                        require.resolve('../maker/cli.ts'),
                        '--live',
                        '--config=' + config,
                    ],
                    {
                        env: offlineEnv(),
                        stdio: ['ignore', 'pipe', 'pipe'],
                        encoding: 'utf8',
                        timeout: 45000,
                        killSignal: 'SIGKILL',
                    }
                )
                assert.ifError(run.error)
                assert.equal(run.status, 1)
                assert.equal(run.stdout, '')
                assert.ok(existsSync(lock))
                assert.ok(!existsSync(join(dir, 'holds.jsonl')))
                assert.equal(run.stderr, 'MAKER_ALREADY_RUNNING\n')
            } finally {
                closeSync(fd)
            }
        })
    })
