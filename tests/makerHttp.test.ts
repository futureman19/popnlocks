import { expect } from 'chai'
import { server } from '../maker/http'
import { Maker } from '../maker/service'
import { AddressInfo } from 'net'

describe('maker HTTP contract', () => {
    it('serves quotes; dry-run take returns machine code; rejects malformed/oversized bodies and foreign origin', async () => {
        const app = server({
            view: () => ({ quotes: [], status: { mode: 'dry-run' } }),
            take: async () => {
                throw new Error('DRY_RUN')
            },
        } as unknown as Maker)
        await new Promise<void>((resolve) =>
            app.listen(0, '127.0.0.1', resolve)
        )
        const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`
        try {
            expect(await (await fetch(base + '/quotes')).json()).deep.eq({
                quotes: [],
                status: { mode: 'dry-run' },
            })
            const result = await fetch(base + '/take', {
                method: 'POST',
                body: '{}',
                headers: { 'Content-Type': 'application/json' },
            })
            expect(result.status).eq(409)
            expect(await result.json()).deep.eq({ error: 'DRY_RUN' })
            expect(
                (
                    await fetch(base + '/take', {
                        method: 'POST',
                        body: '{',
                        headers: { 'Content-Type': 'application/json' },
                    })
                ).status
            ).eq(400)
            expect(
                (
                    await fetch(base + '/take', {
                        method: 'POST',
                        body: 'x'.repeat(5000),
                        headers: { 'Content-Type': 'application/json' },
                    })
                ).status
            ).eq(413)
            expect(
                (
                    await fetch(base + '/take', {
                        method: 'POST',
                        body: '{}',
                        headers: {
                            origin: 'https://evil.invalid',
                            'Content-Type': 'application/json',
                        },
                    })
                ).status
            ).eq(403)
        } finally {
            await new Promise<void>((resolve) => app.close(() => resolve()))
        }
    })
})
