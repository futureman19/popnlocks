import { createServer } from 'http'
import { Maker } from './service'
export function server(maker: Maker, origin = 'https://popnlocks.com') {
    const app = createServer(async (req, res) => {
        const send = (status: number, value: unknown) => {
            res.writeHead(status, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
            })
            res.end(JSON.stringify(value))
        }
        if (req.headers.origin && req.headers.origin !== origin)
            return send(403, { error: 'ORIGIN_DENIED' })
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Vary', 'Origin')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        if (req.method === 'OPTIONS') return send(204, null)
        if (req.method === 'GET' && req.url === '/quotes')
            return send(200, maker.view())
        if (req.method !== 'POST' || req.url !== '/take')
            return send(404, { error: 'NOT_FOUND' })
        if (req.headers['content-type']?.split(';')[0] !== 'application/json')
            return send(415, { error: 'CONTENT_TYPE' })
        try {
            const chunks: Buffer[] = []
            let size = 0
            for await (const chunk of req) {
                size += chunk.length
                if (size > 4096) {
                    send(413, { error: 'BODY_TOO_LARGE' })
                    return
                }
                chunks.push(Buffer.from(chunk))
            }
            let request: unknown
            try {
                request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            } catch {
                return send(400, { error: 'INVALID_JSON' })
            }
            const result = await maker.take(
                request as Parameters<Maker['take']>[0]
            )
            send(200, result)
        } catch (e) {
            const message = (e as Error).message
            const known = [
                'DRY_RUN',
                'STOPPED',
                'BUSY',
                'STALE_QUOTE',
                'RESERVED',
                'MARKET_LIMIT',
                'DAILY_LIMIT',
                'NO_SIZED_COIN',
                'VAULT_CAP',
                'ANCHOR_CHANGED',
                'COIN_CHANGED',
                'INVALID_REQUEST',
                'PREVOUT_MISMATCH',
            ]
            send(known.includes(message) ? 409 : 503, {
                error: known.includes(message) ? message : 'UNAVAILABLE',
            })
        }
    })
    app.requestTimeout = 15000
    app.headersTimeout = 10000
    app.maxConnections = 32
    return app
}
