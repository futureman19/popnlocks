import { expect } from 'chai'
import { execute, vaultSigner } from '../maker/adapters'
import { buildDeployTx, p2pkhScriptHex } from '../src/offers/matchTx'
import { Config } from '../maker/service'

describe('maker vault subprocess boundary', () => {
    it('pipes a real production deploy through an inert child without transaction argv', async function () {
        this.timeout(10000)
        const makerPKH = '11'.repeat(20),
            takerPKH = '22'.repeat(20)
        const coin = (owner: string, id: string) => ({
            txId: id.repeat(64),
            outputIndex: 0,
            satoshis: 30000,
            script: p2pkhScriptHex(owner),
        })
        const hex = buildDeployTx(
            {
                quoteId: 'transport-test',
                makerSide: 'yes',
                makerPKH,
                makerStake: 10000,
                takerStake: 10000,
                expiryHeight: 10090,
                market: {
                    anchorHeight: 10080,
                    anchorTipHex: 'ab'.repeat(32),
                    anchorBits: 0x1d00ffff,
                    window: 144,
                    bounty: 1500,
                    strikeTarget:
                        '26959535291011309493156476344723991336010898738574164086137773096960',
                },
            },
            coin(makerPKH, '1'),
            coin(takerPKH, '2'),
            takerPKH,
            100,
            10086
        ).uncheckedSerialize()
        expect(hex.length).greaterThan(70910)
        const sign = vaultSigner(
            { live: true, killfile: 'NONEXISTENT_TEST_KILLFILE' } as Config,
            process.cwd(),
            async (file, args, cwd, stdin) => {
                expect(file).eq('bun')
                expect(args).deep.eq([
                    'src/cli.ts',
                    'popnlocks-sign',
                    '--stdin',
                    '0',
                ])
                expect(stdin).eq(hex)
                // Only Node echoing bytes: no vault, keys, signing or network.
                return execute(
                    process.execPath,
                    [
                        '-e',
                        "let s='';process.stdin.setEncoding('ascii');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{clearTimeout(t);process.stdout.write(s)});const t=setTimeout(()=>{console.error('missing EOF');process.exit(2)},1000)",
                    ],
                    cwd,
                    stdin
                )
            }
        )
        expect(await sign(hex)).eq(hex)
    })
    it('rejects oversized stdin before runner invocation', async () => {
        let calls = 0
        const sign = vaultSigner(
            { live: true, killfile: 'NONEXISTENT_TEST_KILLFILE' } as Config,
            'unused',
            async () => {
                calls++
                return { stdout: '00', stderr: '' }
            }
        )
        try {
            await sign('00'.repeat(524289))
            expect.fail('signed')
        } catch (e) {
            expect((e as Error).message).eq('INVALID_TRANSACTION')
        }
        expect(calls).eq(0)
    })
    it('accepts the exact 1 MiB boundary through a real inert child', async function () {
        this.timeout(10000)
        const hex = 'ab'.repeat(524288)
        const result = await execute(
            process.execPath,
            ['-e', 'process.stdin.pipe(process.stdout)'],
            process.cwd(),
            hex
        )
        expect(result.stdout).eq(hex)
    })
    it('surfaces child rejection diagnostics and launch errors without unhandled pipe errors', async function () {
        this.timeout(10000)
        try {
            await execute(
                process.execPath,
                [
                    '-e',
                    "process.stderr.write('inert rejection');process.exit(7)",
                ],
                process.cwd(),
                '00'
            )
            expect.fail('accepted')
        } catch (e) {
            expect((e as { stderr: string }).stderr).eq('inert rejection')
        }
        try {
            await execute(
                'nonexistent-pop-maker-test-executable',
                [],
                process.cwd(),
                '00'.repeat(36000)
            )
            expect.fail('launched')
        } catch (e) {
            expect((e as Error).message).not.eq('launched')
        }
    })
    it('dry-run cannot invoke runner, even if called directly', async () => {
        let calls = 0
        const sign = vaultSigner(
            { live: false } as Config,
            'unused',
            async () => {
                calls++
                return { stdout: '00', stderr: '' }
            }
        )
        try {
            await sign('00')
            expect.fail('signed')
        } catch (e) {
            expect((e as Error).message).eq('DRY_RUN')
        }
        expect(calls).eq(0)
    })
    it('uses fixed command/args and classifies cap errors without logging vault output', async () => {
        const sign = vaultSigner(
            { live: true, killfile: 'NONEXISTENT_TEST_KILLFILE' } as Config,
            'test-cwd',
            async (file, args, cwd) => {
                expect(file).eq('bun')
                expect(args).deep.eq([
                    'src/cli.ts',
                    'popnlocks-sign',
                    '--stdin',
                    '0',
                ])
                expect(cwd).eq('test-cwd')
                throw Object.assign(new Error('vault'), {
                    stderr: 'Exceeds popnlocks.maxPerTxSats',
                })
            }
        )
        try {
            await sign('00')
            expect.fail('signed')
        } catch (e) {
            expect((e as Error).message).eq('VAULT_CAP')
        }
    })
    it('rejects nonhex stdout', async () => {
        const sign = vaultSigner(
            { live: true, killfile: 'NONEXISTENT_TEST_KILLFILE' } as Config,
            'test-cwd',
            async () => ({ stdout: 'debug\n00', stderr: '' })
        )
        try {
            await sign('00')
            expect.fail('signed')
        } catch (e) {
            expect((e as Error).message).eq('INVALID_VAULT_RESPONSE')
        }
    })
})
