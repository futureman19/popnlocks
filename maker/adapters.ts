import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { Config } from './service'
export type Runner = (
    file: string,
    args: string[],
    cwd: string
) => Promise<{ stdout: string; stderr: string }>
const execute: Runner = (file, args, cwd) =>
    new Promise((resolve, reject) => {
        execFile(
            file,
            args,
            {
                cwd,
                timeout: 120000,
                maxBuffer: 2 * 1024 * 1024,
                windowsHide: true,
                shell: false,
            },
            (error, stdout, stderr) => {
                if (error) reject(Object.assign(error, { stderr }))
                else resolve({ stdout, stderr })
            }
        )
    })
export function vaultSigner(
    config: Config,
    cwd: string,
    run: Runner = execute
) {
    // Captured permission: changing an object later cannot enable a dry signer.
    const enabled = config.live === true
    return async (hex: string): Promise<string> => {
        if (!enabled) throw new Error('DRY_RUN')
        if (existsSync(config.killfile)) throw new Error('STOPPED')
        if (!/^(?:[0-9a-f]{2})+$/.test(hex))
            throw new Error('INVALID_TRANSACTION')
        let stdout: string
        try {
            const response = await run(
                'bun',
                ['src/cli.ts', 'popnlocks-sign', hex, '0'],
                cwd
            )
            stdout = response.stdout
        } catch (e) {
            const text = String((e as { stderr?: string }).stderr || '')
            throw new Error(
                /Exceeds popnlocks\.maxPer(?:Tx|Day)Sats/.test(text)
                    ? 'VAULT_CAP'
                    : 'VAULT_FAILED'
            )
        }
        const result = stdout.trim()
        if (!/^(?:[0-9a-f]{2})+$/.test(result))
            throw new Error('INVALID_VAULT_RESPONSE')
        return result
    }
}
