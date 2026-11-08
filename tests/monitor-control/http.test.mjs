import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const wait = ms => new Promise(r => setTimeout(r, ms))
async function freePort() {
    const s = http.createServer()
    await new Promise(r => s.listen(0, '127.0.0.1', r))
    const port = s.address().port
    await new Promise(r => s.close(r))
    return port
}
test('invalid control JSON returns 400 and the monitor keeps serving health', async t => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-monitor-http-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
    for (const rel of ['monitor/server', 'scripts/api', 'scripts/package.json', 'package.json'])
        fs.cpSync(path.join(root, rel), path.join(tmp, rel), { recursive: true })
    const priorDay = path.join(tmp, 'monitor/data/runs/synthetic-midnight')
    fs.mkdirSync(priorDay, { recursive: true })
    fs.writeFileSync(
        path.join(priorDay, 'meta.json'),
        JSON.stringify({
            runId: 'synthetic-midnight',
            startedAt: '2026-11-08T08:00:00.000Z',
            endedAt: '2026-11-08T09:00:00.000Z',
            accountsTotal: 1,
            accounts: [{ email: 'midnight@example.invalid', collected: 123, success: true }]
        })
    )
    const clockFile = path.join(tmp, 'clock.txt')
    const preloadFile = path.join(tmp, 'test-clock.cjs')
    fs.writeFileSync(clockFile, '2026-11-08T15:59:00.000Z')
    fs.writeFileSync(
        preloadFile,
        `
        const fs = require('node:fs')
        const RealDate = Date
        globalThis.Date = class extends RealDate {
            constructor(...args) { super(...(args.length ? args : [globalThis.Date.now()])) }
            static now() { return RealDate.parse(fs.readFileSync(process.env.TEST_CLOCK_FILE, 'utf8').trim()) }
        }
    `
    )
    let offline = false
    const api = http.createServer((req, res) => {
        if (offline) {
            res.writeHead(503)
            res.end('Synthetic offline API')
            return
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(
            JSON.stringify(
                req.url === '/accounts'
                    ? { accounts: [{ index: 1, email: 'midnight@example.invalid' }] }
                    : req.url === '/status'
                      ? { state: 'idle', run: null }
                      : req.url.startsWith('/logs')
                        ? { logs: [], latestLogId: 0 }
                        : req.url === '/points'
                          ? { collected: 0, runId: null, accounts: [] }
                          : {}
            )
        )
    })
    await new Promise(r => api.listen(0, '127.0.0.1', r))
    t.after(() => api.close())
    const port = await freePort(),
        env = {
            ...process.env,
            API_HOST: '127.0.0.1',
            API_PORT: String(api.address().port),
            MONITOR_PORT: String(port),
            API_TOKEN: 'synthetic',
            TEST_CLOCK_FILE: clockFile
        }
    for (const k of Object.keys(env)) if (/^ACCOUNT_\d+_/.test(k)) delete env[k]
    const child = spawn(process.execPath, ['--require', preloadFile, 'monitor/server/index.mjs'], {
        cwd: tmp,
        env,
        stdio: 'pipe'
    })
    let output = ''
    child.stderr.on('data', b => (output += b))
    child.stdout.on('data', () => {})
    t.after(async () => {
        child.kill('SIGKILL')
        await new Promise(r => (child.exitCode !== null || child.signalCode ? r() : child.once('exit', r)))
    })
    const base = `http://127.0.0.1:${port}`
    for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw Error(output)
        if (
            await fetch(base + '/api/health')
                .then(r => r.ok)
                .catch(() => false)
        )
            break
        await wait(30)
    }
    assert.equal(
        await new Promise((resolve, reject) => {
            const request = http.get(
                base + '/api/control/token',
                { headers: { Host: 'outside.example.test' } },
                response => {
                    response.resume()
                    resolve(response.statusCode)
                }
            )
            request.on('error', reject)
        }),
        403
    )
    assert.equal(
        (await fetch(base + '/api/control/token', { headers: { Origin: 'https://outside.example.test' } })).status,
        403
    )
    const token = fs.readFileSync(path.join(tmp, 'monitor/data/control-token.txt'), 'utf8').trim()
    for (const body of ['null', '[]', '"value"', '7', 'false']) {
        const r = await fetch(base + '/api/control/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Control-Token': token },
            body
        })
        assert.equal(r.status, 400)
        assert.equal((await fetch(base + '/api/health')).status, 200)
    }
    for (const query of [
        'from=2026-02-30&to=2026-03-02',
        'from=2026-03-02&to=2026-03-01',
        'from=2025-01-01&to=2026-03-02',
        'from=2025-01-01'
    ]) {
        assert.equal((await fetch(base + '/api/points/daily?' + query)).status, 400)
    }
    const archived = path.join(tmp, 'monitor/data/runs/synthetic-archive')
    fs.mkdirSync(archived, { recursive: true })
    fs.writeFileSync(
        path.join(archived, 'meta.json'),
        JSON.stringify({
            startedAt: '2025-01-01T12:00:00+08:00',
            accounts: [{ email: 'midnight@example.invalid', collected: 23 }]
        })
    )
    const report = await (await fetch(base + '/api/points/daily?from=2025-01-01&to=2025-01-07')).json()
    assert.deepEqual(report.range, { from: '2025-01-01', to: '2025-01-07' })
    assert.equal(report.days[0].total, 23, 'custom dates older than 180 days must not be silently dropped')
    assert.equal(report.timeZone, 'Asia/Shanghai')
    const waitSnapshot = async predicate => {
        for (let attempt = 0; attempt < 180; attempt++) {
            const snapshot = await (await fetch(base + '/api/snapshot')).json()
            if (predicate(snapshot)) return snapshot
            await wait(50)
        }
        throw new Error('Synthetic monitor snapshot did not converge')
    }
    const restored = await waitSnapshot(
        snapshot =>
            snapshot.ledger?.todayTotals?.['midnight@example.invalid'] === 123 &&
            snapshot.overview.collectedThisRun === 123 &&
            snapshot.points?.collected === 123
    )
    assert.equal(restored.points.collected, 123, 'empty API state must not replace durable batch earnings with zero')
    offline = true
    fs.writeFileSync(clockFile, '2026-11-08T16:01:00.000Z')
    const midnight = await waitSnapshot(
        snapshot => snapshot.controlApi.online === false && snapshot.ledger?.today === '2026-11-09'
    )
    assert.deepEqual(midnight.ledger.todayTotals, {}, 'offline midnight must not retain yesterday earnings as today')
    assert.equal(midnight.ledger.days.find(day => day.date === '2026-11-08').total, 123)
    const stream = http.get(base + '/api/stream')
    await new Promise(resolve => stream.once('response', response => response.once('data', resolve)))
    child.kill('SIGTERM')
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), wait(1500)])
    stream.destroy()
    assert.equal(child.exitCode, 0, 'open SSE clients must not prevent a graceful monitor shutdown')
})
