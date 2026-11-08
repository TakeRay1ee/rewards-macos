const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const assert = require('node:assert/strict')
const project = path.resolve(__dirname, '../..')
const os = require('node:os')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-full-stack-'))
for (const rel of [
    'monitor/server',
    'scripts/api',
    'scripts/env.js',
    'scripts/package.json',
    'package.json',
    'config.example.json',
    'monitor/web/dist'
])
    fs.cpSync(path.join(project, rel), path.join(temporary, rel), { recursive: true })
const out = temporary
const root = temporary
const { chromium } = require(path.join(project, 'node_modules/patchright'))
const results = [],
    children = []
let browser
const pause = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, ms = 15000) {
    const end = Date.now() + ms
    let last
    while (Date.now() < end) {
        try {
            const r = await fn()
            if (r) return r
        } catch (e) {
            last = e
        }
        await pause(100)
    }
    throw last || Error('condition timed out')
}
async function port() {
    return new Promise(r => {
        const s = net.createServer()
        s.listen(0, '127.0.0.1', () => {
            const p = s.address().port
            s.close(() => r(p))
        })
    })
}
function child(file, env) {
    const c = spawn(process.execPath, [file], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    c.output = ''
    c.stdout.on('data', b => (c.output += b))
    c.stderr.on('data', b => (c.output += b))
    children.push(c)
    return c
}
async function stop(c) {
    if (c.exitCode !== null || c.signalCode) return
    c.kill('SIGTERM')
    await pause(500)
    if (c.exitCode === null && !c.signalCode) c.kill('SIGKILL')
    await pause(100)
}
function record(name, detail) {
    results.push({ name, ...detail })
    console.log(JSON.stringify(results.at(-1)))
}
;(async () => {
    const apiPort = await port(),
        monPort = await port()
    const env = {
        ...process.env,
        API_PORT: String(apiPort),
        API_HOST: '127.0.0.1',
        MONITOR_PORT: String(monPort),
        API_TOKEN: 'audit-synthetic-token-only',
        MONITOR_POLL_STATUS_MS: '100',
        MONITOR_POLL_LOGS_MS: '100',
        WATCHDOG_STALL_MS: '3600000'
    }
    for (const k of Object.keys(env)) if (/^ACCOUNT_\d+_/.test(k)) delete env[k]
    for (let i = 1; i <= 2; i++) {
        env[`ACCOUNT_${i}_EMAIL`] = `audit${i}@example.invalid`
        env[`ACCOUNT_${i}_PASSWORD`] = 'synthetic-unused'
    }
    fs.copyFileSync(path.join(root, 'config.example.json'), path.join(root, 'config.json'))
    const mock = path.join(root, 'mock-worker.cjs')
    fs.writeFileSync(
        mock,
        `const l=(u,t,m,lv='INFO')=>console.log('[2026-11-08 12:00:00] ['+u+'] ['+lv+'] MAIN ['+t+'] '+m);l('main','RUN-START','启动微软奖励脚本 | v4.3.3 | 账户数: 2 | 集群数: 2');for(let i=1;i<=2;i++)l('audit'+i+'@example.invalid','ACCOUNT-START','开始处理账户: audit'+i+'@example.invalid | geoLocale: CN | locale: zh-CN');setTimeout(()=>{l('audit1@example.invalid','ACCOUNT-END','账户完成: audit1@example.invalid | 获得积分=10 | 原余额=100 | 现余额=110 | 持续秒数=1');l('audit2@example.invalid','ACCOUNT-ERROR','audit2@example.invalid | 错误=synthetic failure','ERROR');},4000);setTimeout(()=>{l('main','RUN-END','账户处理结束，存在失败活动 | 处理账户数=2 | 获得积分=10 | 原余额=200 | 现余额=210 | 运行分钟数=0.1');process.exit(1)},7000);`
    )
    env.API_RUN_COMMAND = process.execPath
    env.API_RUN_ARGS = JSON.stringify([mock])
    const api = `http://127.0.0.1:${apiPort}`,
        mon = `http://127.0.0.1:${monPort}`
    const req = async (p, options = {}) =>
        fetch(api + p, {
            ...options,
            headers: {
                Authorization: `Bearer ${env.API_TOKEN}`,
                'Content-Type': 'application/json',
                ...options.headers
            }
        })
    let ap = child('scripts/api/server.js', env)
    await until(async () => (await req('/health')).ok)
    let mo = child('monitor/server/index.mjs', env)
    await until(async () => (await fetch(mon + '/api/health')).ok)
    const unauth = await fetch(api + '/status')
    assert.equal(unauth.status, 401)
    record('control-api-auth', { status: unauth.status })
    const start = await req('/start', { method: 'POST', body: '{}' })
    assert.equal(start.status, 202)
    const duplicate = await req('/start', { method: 'POST', body: '{}' })
    assert.equal(duplicate.status, 409)
    record('start-and-duplicate', {
        start: start.status,
        duplicate: duplicate.status,
        worker: 'synthetic stdout child; no Microsoft requests'
    })
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(mon)
    await until(async () => (await page.locator('body').innerText()).includes('总览仪表盘'))
    await page.locator('button.nav-item').filter({ hasText: '账号' }).click()
    await until(async () => (await page.locator('body').innerText()).includes('audit1'))
    const before = await until(async () => {
        const s = await (await fetch(mon + '/api/snapshot')).json()
        return s.controlApi.online && s.accounts.length === 2 && s
    })
    assert.equal(before.accounts.length, 2)
    assert.equal(before.controlApi.online, true)
    fs.mkdirSync(path.join(out, 'gui'), { recursive: true })
    await page.screenshot({ path: path.join(out, 'gui/accounts-running.png'), fullPage: true })
    await until(async () => {
        const j = await (await fetch(mon + '/api/snapshot')).json()
        return j.accounts.some(a => a.status === 'completed') && j.accounts.some(a => a.status === 'failed') && j
    })
    const after = await (await fetch(mon + '/api/snapshot')).json()
    assert.ok(after.logs.length > before.logs.length)
    assert.ok(!JSON.stringify(after).includes('synthetic-unused'))
    record('sse-account-isolation-and-progress', {
        browser: browser.version(),
        beforeLogs: before.logs.length,
        afterLogs: after.logs.length,
        accounts: after.accounts.map(a => ({ email: a.email, status: a.status, collected: a.collectedThisRun })),
        passwordAbsent: true
    })
    await page.screenshot({ path: path.join(out, 'gui/accounts-terminal.png'), fullPage: true })
    const pages = []
    for (const label of ['总览', '积分报表', '日志', '运行历史', '运行管理']) {
        await page.locator('button.nav-item').filter({ hasText: label }).click()
        await pause(250)
        pages.push({ label, mainCharacters: (await page.locator('main').innerText()).length })
    }
    await page.reload()
    await until(async () => (await page.locator('body').innerText()).includes('运行管理'))
    record('routes-and-refresh', { pages, pageErrors: errors })
    assert.equal(errors.length, 0)
    await stop(ap)
    await until(async () => (await page.locator('body').innerText()).includes('上游 Control API 不可达'))
    record('upstream-disconnect', { bannerObserved: true })
    child('scripts/api/server.js', env)
    await until(async () => !(await page.locator('body').innerText()).includes('上游 Control API 不可达'))
    record('upstream-reconnect', { recovered: true })
    await stop(mo)
    await until(async () => (await page.locator('body').innerText()).includes('与本地监控服务的连接已断开'))
    record('monitor-disconnect', { bannerObserved: true })
    mo = child('monitor/server/index.mjs', env)
    await until(async () => !(await page.locator('body').innerText()).includes('与本地监控服务的连接已断开'))
    record('monitor-reconnect', { recovered: true })
    const dup = child('monitor/server/index.mjs', env)
    await until(() => dup.exitCode !== null)
    record('duplicate-port', { exit: dup.exitCode, addressInUse: dup.output.includes('已被占用') })
    assert.equal(dup.exitCode, 1)
    const syntheticToken = fs.readFileSync(path.join(root, 'monitor/data/control-token.txt'), 'utf8').trim()
    const invalid = await fetch(mon + '/api/control/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Control-Token': syntheticToken },
        body: 'null'
    }).catch(() => null)
    assert.equal(invalid?.status, 400)
    assert.equal((await fetch(mon + '/api/health')).status, 200)
    record('invalid-control-body-keeps-service-alive', { alive: mo.exitCode === null })
    fs.writeFileSync(
        path.join(out, 'gui-api-smoke.json'),
        JSON.stringify({ verdict: 'passed', results }, null, 2) + '\n'
    )
})()
    .catch(e => {
        record('harness-error', { message: e.message, stack: e.stack })
        process.exitCode = 1
        fs.writeFileSync(
            path.join(out, 'gui-api-smoke.json'),
            JSON.stringify({ verdict: 'harness incomplete', results }, null, 2) + '\n'
        )
    })
    .finally(async () => {
        if (browser) await browser.close()
        for (const c of children) await stop(c)
        fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    })
