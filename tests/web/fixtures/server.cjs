const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { createSnapshot } = require('./snapshot.cjs')
async function startPreviewServer(snapshot = createSnapshot()) {
    const root = path.resolve(__dirname, '../../..'),
        streams = new Set()
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost')
        const json = body => {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(body))
        }
        if (url.pathname === '/api/stream') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' })
            res.write(`data: ${JSON.stringify(snapshot)}\n\n`)
            streams.add(res)
            req.on('close', () => streams.delete(res))
            return
        }
        if (url.pathname === '/api/points/daily') return json(snapshot.ledger)
        if (url.pathname.startsWith('/api/accounts/')) {
            const email = decodeURIComponent(url.pathname.slice('/api/accounts/'.length))
            return json({
                account: snapshot.accounts.find(a => a.email === email),
                logs: snapshot.logs.filter(a => a.email === email),
                history: snapshot.history
            })
        }
        if (url.pathname === '/api/runs') return json({ runs: snapshot.history, count: snapshot.history.length })
        if (url.pathname === '/api/control/info') return json({ actions: [], audit: [] })
        if (url.pathname === '/api/sessions/state')
            return json({
                available: true,
                reason: null,
                rows: snapshot.accounts.map(a => ({
                    email: a.email,
                    platforms: {
                        desktop: { updatedAt: snapshot.generatedAt, cookieCount: 5, hasStorageState: true },
                        mobile: { updatedAt: snapshot.generatedAt, cookieCount: 4, hasStorageState: true }
                    }
                }))
            })
        if (url.pathname === '/api/config/summary')
            return json({
                modifiedAt: snapshot.generatedAt,
                clusters: 3,
                concurrency: 3,
                daily: { hour: 0, minute: 0, timeZone: 'Asia/Shanghai' },
                headless: true,
                accountDelay: { min: '20s', max: '40s' },
                queryEngines: ['china', 'local'],
                workers: { doDailySet: true, doDailyCheckIn: true, doReadToEarn: true, doDesktopSearch: true }
            })
        if (url.pathname.startsWith('/api/')) {
            res.writeHead(405)
            res.end('Synthetic read-only preview')
            return
        }
        const file = path.resolve(root, 'monitor/web/dist', '.' + url.pathname.replace(/\/$/, '/index.html'))
        if (!file.startsWith(path.join(root, 'monitor/web/dist') + path.sep) || !fs.existsSync(file)) {
            res.writeHead(404)
            res.end()
            return
        }
        res.setHeader(
            'Content-Type',
            file.endsWith('.js')
                ? 'text/javascript'
                : file.endsWith('.css')
                  ? 'text/css'
                  : file.endsWith('.svg')
                    ? 'image/svg+xml'
                    : 'text/html'
        )
        res.end(fs.readFileSync(file))
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    return {
        base: `http://127.0.0.1:${server.address().port}`,
        snapshot,
        publish: () => {
            for (const stream of streams) stream.write(`data: ${JSON.stringify(snapshot)}\n\n`)
        },
        close: async () => {
            for (const s of streams) s.destroy()
            await new Promise(r => server.close(r))
        }
    }
}
module.exports = { startPreviewServer }
