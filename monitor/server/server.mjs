// 监控聚合、受限控制路由与停滞恢复；实际活动始终由原 Control API 执行。

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { MONITOR, PATHS, CONTROL_API, BUDGET, ensureDirs } from './config.mjs'
import { controlApi } from './controlClient.mjs'
import { RunTracker } from './runTracker.mjs'
import { readRunMetas } from './runHistory.mjs'
import { readSystemSnapshot } from './metrics.mjs'
import { ensureControlToken, controlTokenPath, verifyToken, runAction, readAuditTail, listActions } from './control.mjs'
import { readSessionState } from './sessions.mjs'
import { readRecoveryPlan, writeRecoveryPlan, recoverStalledRun, refreshRecoveryPlan } from './recovery.mjs'
import {
    buildLedger,
    readBalanceSnapshots,
    writeBalanceSnapshots,
    backfillBalancesFromEvents
} from './pointsLedger.mjs'
import {
    WATCHDOG,
    evaluateStall,
    recordIncident,
    readIncidentTail,
    canRetry,
    noteRetry,
    spawnRetryAfterStall
} from './watchdog.mjs'

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8'
}

const WEB_DIST = path.join(PATHS.root, 'monitor', 'web', 'dist')

function json(res, status, body) {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(payload)
    })
    res.end(payload)
}

function readSchedulerState() {
    const out = { lastRun: null, calibration: null, budget: null, logTail: [] }
    try {
        out.lastRun = JSON.parse(fs.readFileSync(PATHS.lastRun, 'utf8'))
    } catch {
        /* 尚未运行过调度器 */
    }
    try {
        out.calibration = JSON.parse(fs.readFileSync(PATHS.calibration, 'utf8'))
    } catch {
        /* 尚无实测 */
    }
    try {
        const lines = fs.readFileSync(PATHS.schedulerLog, 'utf8').split('\n').filter(Boolean)
        out.logTail = lines
            .slice(-20)
            .map(l => {
                try {
                    return JSON.parse(l)
                } catch {
                    return null
                }
            })
            .filter(Boolean)
    } catch {
        /* 无调度日志 */
    }
    out.recovery = readRecoveryPlan(path.join(PATHS.data, 'recovery.json'))
    try {
        out.guard = JSON.parse(fs.readFileSync(path.join(PATHS.data, 'daily-guard.json'), 'utf8'))
    } catch {
        /* 尚无守卫记录 */
    }
    out.budget = { reserveGb: BUDGET.reserveGb, defaultFootprintMb: BUDGET.defaultFootprintMb }
    return out
}

class MonitorService {
    constructor() {
        this.tracker = new RunTracker({
            control: controlApi,
            configuredAccounts: [],
            logCap: MONITOR.logMemoryCap,
            runsDir: PATHS.runs
        })
        this.snapshot = null
        this.clients = new Set()
        this.lastAccountsPayload = null
        this.lastPoints = null
        this.lastErrors = null
        this.lastHistory = null
        this.lastSystem = null
        this.calibrationSamples = []
        this.ledger = null
        this.watchdogBusy = false
        this.balanceFile = path.join(PATHS.data, 'balances.json')
        this.balanceSnapshots = {}
        // 启动时用历史事件回填一次，补上快照功能上线前的观测值
        try {
            const merged = backfillBalancesFromEvents({
                runsDir: PATHS.runs,
                snapshots: readBalanceSnapshots(this.balanceFile)
            })
            this.balanceSnapshots = merged
            writeBalanceSnapshots(this.balanceFile, merged)
        } catch {
            /* 回填失败不影响启动 */
        }
        this.startedAt = new Date().toISOString()
    }

    async start() {
        // 先拿账号表再开始轮询：否则首次回放时账号表为空，历史日志会全部无法归属
        try {
            const accounts = await controlApi.accounts()
            if (accounts?.accounts) {
                this.lastAccountsPayload = accounts
                this.tracker.setConfiguredAccounts(accounts.accounts)
            }
        } catch {
            /* API 未就绪时靠 loopSlow 兜底 */
        }
        this.loopStatus()
        this.loopLogs()
        this.loopSlow()
        this.loopSystem()
        this.loopBroadcast()
        this.loopWatchdog()
    }

    /** 停滞看门狗：冻结未完成集合，并用批次身份保护停止与恢复。 */
    async loopWatchdog() {
        const tick = async () => {
            try {
                await this.checkStall()
            } catch {
                /* 忽略单次失败 */
            }
            setTimeout(tick, WATCHDOG.checkMs)
        }
        await tick()
    }

    async checkStall() {
        if (this.watchdogBusy) return
        const file = path.join(PATHS.data, 'recovery.json')
        const saved = readRecoveryPlan(file)
        if (saved?.state === 'scheduled') {
            const state = await controlApi.status()
            let records = []
            try {
                records = fs
                    .readFileSync(PATHS.schedulerLog, 'utf8')
                    .split('\n')
                    .filter(Boolean)
                    .flatMap(line => {
                        try {
                            return [JSON.parse(line)]
                        } catch {
                            return []
                        }
                    })
            } catch {
                /* 尚无回执 */
            }
            const updated = await refreshRecoveryPlan({
                plan: saved,
                records,
                status: state,
                isAlive: pid => {
                    try {
                        process.kill(pid, 0)
                        return true
                    } catch {
                        return false
                    }
                },
                retry: spawnRetryAfterStall
            })
            if (updated !== saved) writeRecoveryPlan(file, updated)
            return
        }
        const pending = saved && !['started', 'requires_attention'].includes(saved.state) ? saved : null
        if (saved?.runId === this.tracker.status?.runId && ['started', 'requires_attention'].includes(saved.state))
            return
        const accounts = this.tracker.deriveAccounts(this.lastAccountsPayload)
        if (!pending && this.tracker.status?.logStreamAvailable === false) return
        const hit = pending ? null : evaluateStall({ state: this.tracker.status?.state, accounts })
        if (!hit && !pending) return
        const runId = pending?.runId ?? this.tracker.status?.runId
        if (!runId) {
            recordIncident({
                at: new Date().toISOString(),
                kind: 'recovery-blocked',
                reason: '上游缺少稳定 runId，未停止未知批次'
            })
            return
        }
        this.watchdogBusy = true
        try {
            if (hit)
                recordIncident({
                    at: new Date().toISOString(),
                    kind: 'stall',
                    runId,
                    email: hit.email,
                    gapMinutes: Math.round(hit.gapMs / 60000),
                    action: 'recover-unfinished-accounts'
                })
            const plan = await recoverStalledRun({
                runId,
                accounts,
                existingPlan: pending,
                save: value => writeRecoveryPlan(file, value),
                stop: async expectedRunId => {
                    const state = await controlApi.status()
                    if (state.runId !== expectedRunId) return { ok: false, error: '批次已改变，未发送停止' }
                    if (state.state === 'idle') return { ok: true }
                    const result = await runAction('force-stop-run', {
                        confirmed: true,
                        params: { expectedRunId },
                        source: 'watchdog'
                    })
                    return {
                        ok: result.ok && result.body?.accepted === true,
                        error: result.body?.error ?? result.body?.detail
                    }
                },
                readStatus: () => controlApi.status(),
                retry: (indexes, requestId) => spawnRetryAfterStall(indexes, requestId),
                canRetry,
                noteRetry
            })
            recordIncident({
                at: new Date().toISOString(),
                kind: `recovery-${plan.state}`,
                runId,
                accounts: plan.retried ?? plan.accounts,
                reason: plan.reason,
                pid: plan.retryPid
            })
        } finally {
            this.watchdogBusy = false
        }
    }

    async loopStatus() {
        const tick = async () => {
            try {
                await this.tracker.pollStatus()
            } catch {
                /* 错误已在 tracker 内记录 */
            }
            setTimeout(tick, MONITOR.pollStatusMs)
        }
        await tick()
    }

    async loopLogs() {
        const tick = async () => {
            try {
                await this.tracker.pollLogs()
            } catch {
                /* 忽略单次失败，下一轮重试 */
            }
            setTimeout(tick, MONITOR.pollLogsMs)
        }
        await tick()
    }

    async loopSlow() {
        const tick = async () => {
            try {
                if (this.tracker.apiOnline) {
                    const [accounts, points, errors, history] = await Promise.all([
                        controlApi.accounts().catch(() => null),
                        controlApi.points().catch(() => null),
                        controlApi.errors({ limit: 100 }).catch(() => null),
                        controlApi.history({ limit: 50 }).catch(() => null)
                    ])
                    if (accounts) {
                        this.lastAccountsPayload = accounts
                        this.tracker.setConfiguredAccounts(accounts.accounts ?? [])
                    }
                    if (points) this.lastPoints = points
                    if (errors) this.lastErrors = errors
                    if (history) this.lastHistory = history
                    this.persistBalances()
                }
                // Durable observations and the Shanghai day boundary remain
                // available even while the control API is offline.
                this.ledger = buildLedger({
                    runsDir: PATHS.runs,
                    emails: (this.lastAccountsPayload?.accounts ?? []).map(a => a.email),
                    days: 30,
                    balanceSnapshots: this.balanceSnapshots
                })
            } catch {
                /* 下一轮重试 */
            }
            setTimeout(tick, 4000)
        }
        await tick()
    }

    async loopSystem() {
        const tick = async () => {
            try {
                this.lastSystem = await readSystemSnapshot()
                this.maybeCalibrate()
            } catch {
                /* 下一轮重试 */
            }
            setTimeout(tick, 5000)
        }
        await tick()
    }

    /** 把运行中观测到的余额落盘，保证被中途停止的批次也有余额可追溯 */
    persistBalances() {
        if (!this.balanceSnapshots) this.balanceSnapshots = readBalanceSnapshots(this.balanceFile)
        const state = this.tracker.runState
        const runId = this.tracker.runId
        let changed = false
        for (const [email, acc] of Object.entries(state?.accounts ?? {})) {
            const value = acc?.live?.balance
            if (!Number.isFinite(value)) continue
            const at = acc?.live?.lastUpdateTs ?? new Date().toISOString()
            const prev = this.balanceSnapshots[email]
            if (!prev || prev.value !== value || prev.at !== at) {
                this.balanceSnapshots[email] = { value, at, runId }
                changed = true
            }
        }
        if (changed) {
            try {
                writeBalanceSnapshots(this.balanceFile, this.balanceSnapshots)
            } catch {
                /* 落盘失败不影响页面 */
            }
        }
    }

    /** 运行中实测每账号内存占用。只有连续多次采样稳定才落盘，避免误记。 */
    maybeCalibrate() {
        const sys = this.lastSystem
        if (!sys || !this.tracker.status || this.tracker.status.state === 'idle') return
        const running = (this.lastAccountsPayload?.accounts ?? []).length
        const workers = sys.processes?.workers?.length ?? 0
        const instances = sys.processes?.browserInstances ?? 0
        if (!running || instances < 1 || workers < 1) return

        const activeBrowserAccounts = Math.max(1, Math.min(instances, workers))
        const totalMb = (sys.processes.browserRssMb ?? 0) + (sys.processes.workerRssMb ?? 0)
        const perAccount = Math.round(totalMb / activeBrowserAccounts)
        if (perAccount < 100 || perAccount > 8000) return

        this.calibrationSamples.push(perAccount)
        if (this.calibrationSamples.length > 12) this.calibrationSamples.shift()
        if (this.calibrationSamples.length < 5) return

        const sorted = [...this.calibrationSamples].sort((a, b) => a - b)
        const median = sorted[Math.floor(sorted.length / 2)]
        const spread = sorted[sorted.length - 1] - sorted[0]
        if (spread / median > 0.6) return // 波动过大，不采信

        try {
            const previous = JSON.parse(fs.readFileSync(PATHS.calibration, 'utf8'))
            if (previous?.footprintMb && Math.abs(previous.footprintMb - median) < 40) return
        } catch {
            /* 首次写入 */
        }

        const payload = {
            footprintMb: median,
            measuredAt: new Date().toISOString(),
            samples: this.calibrationSamples.length,
            spreadMb: spread,
            mode: this.tracker.runState?.clusters > 0 ? 'cluster' : 'single',
            detail: {
                browserRssMb: sys.processes.browserRssMb,
                workerRssMb: sys.processes.workerRssMb,
                browserInstances: instances,
                activeBrowserAccounts
            }
        }
        fs.mkdirSync(PATHS.data, { recursive: true })
        const tmp = `${PATHS.calibration}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2))
        fs.renameSync(tmp, PATHS.calibration)
    }

    buildSnapshot() {
        const accounts = this.tracker.deriveAccounts(this.lastAccountsPayload)
        const run = this.tracker.getRunView()
        const points = this.lastPoints
        const observedEarnings = accounts.map(account => account.collectedThisRun).filter(Number.isFinite)
        const collectedThisRun =
            run.totals?.collected ??
            (observedEarnings.length ? observedEarnings.reduce((sum, value) => sum + value, 0) : null)
        const schedulerState = readSchedulerState()

        const counts = accounts.reduce((acc, a) => {
            const status = a.currentRunStatus ?? a.status
            acc[status] = (acc[status] ?? 0) + 1
            return acc
        }, {})

        return {
            generatedAt: new Date().toISOString(),
            serviceStartedAt: this.startedAt,
            controlApi: {
                base: CONTROL_API.base,
                online: this.tracker.apiOnline,
                error: this.tracker.apiError,
                tokenConfigured: Boolean(CONTROL_API.token),
                dataSource: '上游 GET /health /status /points /accounts /logs /errors /history'
            },
            run,
            overview: {
                accountsTotal: accounts.length,
                running: (counts.running ?? 0) + (counts.starting ?? 0),
                waiting: counts.waiting ?? 0,
                completed: counts.completed ?? 0,
                failed: counts.failed ?? 0,
                stopped: counts.stopped ?? 0,
                notRun: counts.not_run ?? 0,
                unknown: counts.unknown ?? 0,
                countsKnown: accounts.filter(a => a.includedInCurrentRun !== false).every(a => a.statusKnown),
                todayCompleted: accounts.filter(a => a.todayStatus === 'completed').length,
                collectedThisRun,
                activeWorkerProcesses: this.lastSystem?.processes?.workers?.length ?? null,
                browserInstances: this.lastSystem?.processes?.browserInstances ?? null,
                clusters: this.tracker.runState?.clusters ?? null
            },
            accounts,
            points: points
                ? {
                      state: points.state,
                      running: points.running,
                      live: points.live,
                      collected: collectedThisRun,
                      totals: points.totals,
                      accountsTotal: points.accountsTotal,
                      accountsSeen: points.accountsSeen,
                      updatedAt: points.updatedAt,
                      finished: points.finished,
                      accounts: points.accounts,
                      note:
                          this.tracker.runState?.clusters > 1
                              ? '上游 /points 的 currentAccount 字段在并行运行时不可靠，本页面以账号级数据为准'
                              : null
                  }
                : null,
            logs: this.tracker.getLogsSince(0, { limit: MONITOR.snapshotLogWindow }),
            errors: this.lastErrors,
            history: this.lastHistory?.runs ?? this.tracker.runsHistory.slice(0, 20),
            historySource: this.lastHistory ? 'control-api:/history (持久记录)' : 'monitor:data/runs (本地 JSONL)',
            ledger: this.ledger,
            system: this.lastSystem,
            scheduler: schedulerState,
            logStats: {
                buffered: this.tracker.logs.length,
                cap: MONITOR.logMemoryCap,
                lastLogId: this.tracker.lastLogId,
                persisted: this.tracker.persist?.count ?? 0,
                runId: this.tracker.runId
            }
        }
    }

    loopBroadcast() {
        const tick = () => {
            this.snapshot = this.buildSnapshot()
            const payload = `data: ${JSON.stringify(this.snapshot)}\n\n`
            for (const res of this.clients) {
                try {
                    res.write(payload)
                } catch {
                    this.clients.delete(res)
                }
            }
            setTimeout(tick, 1500)
        }
        tick()
    }
}

function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname)
    if (rel === '/' || rel === '') rel = '/index.html'
    const target = path.join(WEB_DIST, rel)
    if (!target.startsWith(WEB_DIST)) {
        res.writeHead(403)
        res.end('forbidden')
        return
    }
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        const ext = path.extname(target)
        res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' })
        fs.createReadStream(target).pipe(res)
        return
    }
    const indexFile = path.join(WEB_DIST, 'index.html')
    if (fs.existsSync(indexFile)) {
        res.writeHead(200, { 'Content-Type': MIME['.html'] })
        fs.createReadStream(indexFile).pipe(res)
        return
    }
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('GUI 尚未构建。请在项目根目录执行：npm --prefix monitor/web install && npm --prefix monitor/web run build')
}

function readJsonBody(req, limitBytes = 8192) {
    return new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        req.on('data', chunk => {
            size += chunk.length
            if (size > limitBytes) {
                reject(new Error('请求体过大'))
                req.destroy()
                return
            }
            chunks.push(chunk)
        })
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8').trim()
            if (!raw) return resolve({})
            try {
                const body = JSON.parse(raw)
                if (!body || typeof body !== 'object' || Array.isArray(body)) {
                    reject(new Error('请求体必须是 JSON 对象'))
                    return
                }
                resolve(body)
            } catch {
                reject(new Error('请求体不是合法 JSON'))
            }
        })
        req.on('error', reject)
    })
}

export function createServer() {
    ensureDirs()
    ensureControlToken()
    const service = new MonitorService()
    service.start()

    const server = http.createServer((req, res) => {
        handleRequest(req, res).catch(error => {
            if (!res.headersSent) json(res, 500, { error: error?.message ?? String(error) })
            else res.destroy()
        })
    })

    async function handleRequest(req, res) {
        const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
        let host
        try {
            host = new URL(`http://${req.headers.host ?? ''}`)
        } catch {
            return json(res, 400, { error: '无效的 Host' })
        }
        if (!localHosts.has(host.hostname)) return json(res, 403, { error: '仅接受本机地址的请求' })
        const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
        const pathname = url.pathname

        if (pathname.startsWith('/api/control/')) {
            const origin = req.headers.origin
            if (origin) {
                let source
                try {
                    source = new URL(origin)
                } catch {
                    return json(res, 403, { error: '无效的 Origin' })
                }
                if (source.origin !== host.origin) return json(res, 403, { error: '控制入口仅接受同源页面' })
            }
            if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: '不接受跨站控制请求' })
        }

        // 控制台动作：唯一的写入口，独立鉴权 + 白名单 + 二次确认
        if (pathname === '/api/control/action') {
            if (req.method !== 'POST') {
                return json(res, 405, { error: '控制动作只接受 POST' })
            }
            if (!verifyToken(req.headers['x-control-token'])) {
                return json(res, 401, { error: '控制密钥不正确' })
            }
            let body
            try {
                body = await readJsonBody(req)
            } catch (error) {
                return json(res, 400, { error: error.message })
            }
            const result = await runAction(String(body.action ?? ''), {
                confirmed: body.confirmed === true,
                params: body.params && typeof body.params === 'object' ? body.params : {},
                source: 'gui'
            })
            return json(res, result.status, result.body)
        }

        if (pathname === '/api/control/info') {
            return json(res, 200, {
                actions: listActions(),
                tokenFile: 'monitor/data/control-token.txt',
                audit: readAuditTail(12),
                note: '监控相关接口保持只读；只有这个控制入口能执行动作'
            })
        }

        // 仅回环地址可取：本机页面点一下就能拿到密钥，省掉开终端的步骤。
        // 不返回 CORS 头，因此外部网页的 JS 读不到响应体；且只对 127.0.0.1 / ::1 放行。
        if (pathname === '/api/control/token') {
            const remote = req.socket.remoteAddress ?? ''
            const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
            if (!isLoopback) {
                return json(res, 403, { error: '只允许本机回环地址读取' })
            }
            try {
                const token = fs.readFileSync(controlTokenPath(), 'utf8').trim()
                return json(res, 200, { token })
            } catch {
                return json(res, 500, { error: '控制密钥文件缺失，请重启监控服务' })
            }
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return json(res, 405, {
                error: '监控接口只读，不接受写请求；运维操作请走 /api/control/action',
                code: 'READ_ONLY'
            })
        }

        try {
            if (pathname === '/api/health') {
                return json(res, 200, {
                    ok: true,
                    uptimeSec: Math.round((Date.now() - Date.parse(service.startedAt)) / 1000),
                    controlApiOnline: service.tracker.apiOnline,
                    poll: { status: MONITOR.pollStatusMs, logs: MONITOR.pollLogsMs }
                })
            }

            if (pathname === '/api/stream') {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache, no-transform',
                    Connection: 'keep-alive',
                    'X-Accel-Buffering': 'no'
                })
                res.write('retry: 2000\n\n')
                if (service.snapshot) res.write(`data: ${JSON.stringify(service.snapshot)}\n\n`)
                service.clients.add(res)
                const keepAlive = setInterval(() => {
                    try {
                        res.write(': ping\n\n')
                    } catch {
                        /* 连接已断 */
                    }
                }, 25000)
                req.on('close', () => {
                    clearInterval(keepAlive)
                    service.clients.delete(res)
                })
                return
            }

            if (pathname === '/api/snapshot') {
                return json(res, 200, service.snapshot ?? service.buildSnapshot())
            }

            if (pathname === '/api/accounts') {
                return json(res, 200, {
                    generatedAt: new Date().toISOString(),
                    accounts: service.tracker.deriveAccounts(service.lastAccountsPayload)
                })
            }

            if (pathname.startsWith('/api/accounts/')) {
                const email = decodeURIComponent(pathname.slice('/api/accounts/'.length))
                const all = service.tracker.deriveAccounts(service.lastAccountsPayload)
                const account = all.find(a => a.email === email)
                if (!account) return json(res, 404, { error: '未找到该账号', email })
                return json(res, 200, {
                    generatedAt: new Date().toISOString(),
                    account,
                    logs: service.tracker
                        .getLogsSince(0, { limit: MONITOR.logMemoryCap })
                        .filter(e => e.email === email)
                        .slice(-300),
                    history: (service.lastHistory?.runs ?? []).filter(r =>
                        (r.accounts ?? []).some(a => a.email === email)
                    )
                })
            }

            if (pathname === '/api/logs') {
                const afterId = Number(url.searchParams.get('afterId') ?? 0) || 0
                const limit = Math.min(2000, Number(url.searchParams.get('limit') ?? 400) || 400)
                const level = url.searchParams.get('level')
                const email = url.searchParams.get('email')
                let logs = service.tracker.getLogsSince(afterId, { limit: MONITOR.logMemoryCap })
                if (level) {
                    const rank = { debug: 0, info: 1, warn: 2, error: 3 }
                    const floor = rank[level] ?? 0
                    logs = logs.filter(e => (rank[e.level] ?? 1) >= floor)
                }
                if (email) logs = logs.filter(e => e.email === email)
                return json(res, 200, {
                    logs: logs.slice(-limit),
                    count: logs.length,
                    lastLogId: service.tracker.lastLogId,
                    runId: service.tracker.runId
                })
            }

            if (pathname === '/api/points/daily') {
                const days = Math.min(366, Math.max(1, Number(url.searchParams.get('days') ?? 30) || 30))
                const from = url.searchParams.get('from') ?? undefined
                const to = url.searchParams.get('to') ?? undefined
                if (from !== undefined || to !== undefined) {
                    const valid = value =>
                        /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') &&
                        Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
                        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
                    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1
                    if (!valid(from) || !valid(to) || span < 1 || span > 366)
                        return json(res, 400, { error: '日期范围须为有效日期、开始不晚于结束，且不超过 366 天' })
                }
                return json(
                    res,
                    200,
                    buildLedger({
                        runsDir: PATHS.runs,
                        emails: (service.lastAccountsPayload?.accounts ?? []).map(a => a.email),
                        days,
                        from,
                        to,
                        balanceSnapshots: service.balanceSnapshots
                    })
                )
            }

            if (pathname === '/api/system') {
                return json(res, 200, service.lastSystem ?? {})
            }

            if (pathname === '/api/incidents') {
                return json(res, 200, { incidents: readIncidentTail(30), config: WATCHDOG })
            }

            if (pathname === '/api/scheduler') {
                return json(res, 200, readSchedulerState())
            }

            if (pathname === '/api/sessions/state') {
                return json(res, 200, { ...(await readSessionState()), at: new Date().toISOString() })
            }

            if (pathname === '/api/config/summary') {
                // 只读摘要：回答"这一轮到底按什么配置跑的"
                try {
                    const raw = fs.readFileSync(PATHS.config, 'utf8')
                    const cfg = JSON.parse(raw)
                    const stat = fs.statSync(PATHS.config)
                    return json(res, 200, {
                        at: new Date().toISOString(),
                        modifiedAt: stat.mtime.toISOString(),
                        clusters: cfg.clusters ?? null,
                        concurrency: Number(process.env.REWARDS_CONCURRENCY) || null,
                        daily: {
                            hour: Number(process.env.REWARDS_DAILY_HOUR ?? 0),
                            minute: Number(process.env.REWARDS_DAILY_MINUTE ?? 0),
                            timeZone: 'Asia/Shanghai'
                        },
                        accountDelay: cfg.accountDelay ?? null,
                        headless: cfg.headless ?? null,
                        browserChannel: cfg.browserChannel ?? null,
                        sessionPath: cfg.sessionPath ?? null,
                        queryEngines: cfg.searchSettings?.queryEngines ?? null,
                        globalTimeout: cfg.globalTimeout ?? null,
                        workers: cfg.workers ?? null,
                        source: 'config.json'
                    })
                } catch (error) {
                    return json(res, 500, { error: `读取 config.json 失败：${error.message}` })
                }
            }

            if (pathname === '/api/run') {
                return json(res, 200, service.tracker.getRunView())
            }

            if (pathname === '/api/runs') {
                // 本地落盘批次：跨 API 重启依然可读
                const runs = readRunMetas(PATHS.runs).toReversed()
                return json(res, 200, { runs, count: runs.length })
            }

            return serveStatic(req, res, pathname)
        } catch (error) {
            return json(res, 500, { error: error?.message ?? String(error) })
        }
    }

    return { server, service }
}

export { MonitorService }
