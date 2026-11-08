const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { chromium } = require('patchright')
const root = path.resolve(__dirname, '../..')
const today = new Date().toLocaleDateString('en-CA')
const email = 'ui@example.invalid'
const row = {
    index: 100,
    email,
    status: 'running',
    statusKnown: true,
    activities: {},
    attributionReliable: true,
    collectedThisRun: 10,
    currentTask: null,
    wait: null,
    geoLocale: 'CN',
    langCode: 'zh-CN'
}
function ledger(value) {
    return {
        generatedAt: new Date().toISOString(),
        source: 'synthetic-ledger',
        days: [
            { date: today, accounts: { [email]: { collected: value, balance: 100 + value, runs: 1 } }, total: value }
        ],
        today,
        todayTotals: { [email]: value },
        balances: { [email]: { value: 100 + value, at: new Date().toISOString() } },
        weekTotals: { [email]: value },
        runCount: 1
    }
}
function log(id, message) {
    return {
        id,
        runId: 'synthetic-run',
        email,
        user: email,
        ts: new Date().toISOString(),
        receivedAt: new Date(Date.now() + id).toISOString(),
        level: 'info',
        title: 'TEST',
        message,
        platform: 'MAIN',
        source: 'stdout',
        parsed: true,
        raw: message
    }
}
test('reports update within the same runCount and account details merge live logs', async t => {
    let currentLedger = ledger(10)
    const snapshot = {
        generatedAt: new Date().toISOString(),
        controlApi: { online: true, base: 'http://127.0.0.1', tokenConfigured: true },
        run: { runId: 'synthetic-run', state: 'running', logStreamAvailable: true },
        overview: {
            accountsTotal: 1,
            running: 1,
            waiting: 0,
            completed: 0,
            failed: 0,
            stopped: 0,
            notRun: 0,
            unknown: 0
        },
        accounts: [row],
        points: null,
        errors: null,
        history: [],
        historySource: 'synthetic',
        ledger: currentLedger,
        system: null,
        scheduler: { lastRun: null, logTail: [], calibration: null, budget: {} },
        logs: [log(1, 'first synthetic log')],
        logStats: { buffered: 1, cap: 500, lastLogId: 1 }
    }
    const streams = new Set()
    let reportFetches = 0
    const server = http.createServer((req, res) => {
        if (req.url === '/api/stream') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
            res.write(`data: ${JSON.stringify(snapshot)}\n\n`)
            streams.add(res)
            req.on('close', () => streams.delete(res))
            return
        }
        if (req.url.startsWith('/api/points/daily')) {
            reportFetches++
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(currentLedger))
            return
        }
        if (req.url.startsWith('/api/accounts/')) {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ account: row, logs: snapshot.logs, history: [] }))
            return
        }
        const name = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]
        const file = path.join(root, 'monitor/web/dist', name)
        if (!fs.existsSync(file)) {
            res.writeHead(404)
            res.end()
            return
        }
        res.setHeader(
            'Content-Type',
            file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'
        )
        res.end(fs.readFileSync(file))
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    t.after(() => {
        for (const s of streams) s.destroy()
        server.close()
    })
    const browser = await chromium.launch({ headless: true })
    t.after(() => browser.close())
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    const push = () => {
        snapshot.generatedAt = new Date().toISOString()
        for (const s of streams) s.write(`data: ${JSON.stringify(snapshot)}\n\n`)
    }
    await page.goto(`http://127.0.0.1:${server.address().port}/#/reports`)
    await page.getByRole('heading', { name: '积分报表', exact: true }).waitFor()
    await page.getByRole('cell', { name: '+10', exact: true }).waitFor()
    currentLedger = ledger(42)
    snapshot.ledger = currentLedger
    push()
    await page.getByRole('cell', { name: '+42', exact: true }).waitFor()
    assert.ok(reportFetches >= 2)
    await page.goto(`http://127.0.0.1:${server.address().port}/#/accounts/${encodeURIComponent(email)}`)
    await page.locator('.logline .m').filter({ hasText: 'first synthetic log' }).waitFor()
    snapshot.logs.push(log(2, 'second live synthetic log'))
    push()
    await page.locator('.logline .m').filter({ hasText: 'second live synthetic log' }).waitFor()
    assert.equal(await page.locator('.logline .m').filter({ hasText: 'first synthetic log' }).count(), 1)
    await page.reload()
    await page.locator('.logline .m').filter({ hasText: 'second live synthetic log' }).waitFor()
    assert.deepEqual(errors, [])
})
