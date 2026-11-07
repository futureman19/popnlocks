import { expect } from 'chai'
import { vaultSigner } from '../maker/adapters'
import { Config } from '../maker/service'

describe('maker vault subprocess boundary', () => {
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
                    '00',
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
