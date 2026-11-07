import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { Config } from './service'
export type Runner = (
    file: string,
    args: string[],
    cwd: string,
    stdin: string
) => Promise<{ stdout: string; stderr: string }>
// Matches Dogfood's supported stdin contract; hex is ASCII bytes, not argv.
export const MAX_STDIN_BYTES = 1048576
function validateInput(hex: string) {
    if (
        hex.length > MAX_STDIN_BYTES ||
        hex.length % 2 ||
        !/^[0-9a-f]+$/.test(hex)
    )
        throw new Error('INVALID_TRANSACTION')
}
export const execute: Runner = (file, args, cwd, stdin) =>
    new Promise((resolve, reject) => {
        validateInput(stdin)
        const child = execFile(
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
        // End sends EOF immediately; the vault additionally enforces its 10s read deadline.
        child.stdin!.on('error', (error) => {
            child.kill()
            reject(error)
        })
        child.stdin!.end(stdin, 'ascii')
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
        validateInput(hex)
        let stdout: string
        try {
            const response = await run(
                'bun',
                ['src/cli.ts', 'popnlocks-sign', '--stdin', '0'],
                cwd,
                hex
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
