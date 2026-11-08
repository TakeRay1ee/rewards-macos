// 调度器：配置并发并调用原 Control API；GUI/看门狗/launchd复用此入口。
//
// 并发数的推导链条（这是全系统唯一的并发开关）：
//   1. N = 当前 .env 里被识别到的账号数（跳号无妨）
//   2. 单账号实测内存占用 footprintMb 来自 data/calibration.json（由监控服务实测写入）
//      没有实测值时才退回保守估计，并在报告里标注"未实测"
//   3. 可分配 = 本机可用内存 - 预留（默认 1.5GB，留给系统/GUI/监控）
//   4. REWARDS_CONCURRENCY 设置精确并发上限（例如 3），优先于旧强制配置。
//      显式配置不被内存估算悄悄降级；未配置时才按预算推导。
//
// 用法：
//   node monitor/server/scheduler.mjs run --reason daily
//   node monitor/server/scheduler.mjs run --accounts 1,3 --dry-run
//   node monitor/server/scheduler.mjs status

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { CONTROL_API, PATHS, BUDGET, ensureDirs } from './config.mjs'
import { readMemory, readProcesses } from './metrics.mjs'
import { acquireSchedulerLock, releaseSchedulerLock } from './schedulerLock.mjs'

function arg(name, fallback = null) {
    const i = process.argv.indexOf(`--${name}`)
    if (i === -1) return fallback
    const next = process.argv[i + 1]
    return next && !next.startsWith('--') ? next : true
}

function nowIso() {
    return new Date().toISOString()
}

function writeJsonAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
}

function appendJsonl(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(data) + '\n')
}

async function apiFetch(pathname, { method = 'GET', body = null, timeout = 15000 } = {}) {
    const headers = {}
    if (CONTROL_API.token) headers.Authorization = `Bearer ${CONTROL_API.token}`
    if (body) headers['Content-Type'] = 'application/json'
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeout)
    try {
        const res = await fetch(`${CONTROL_API.base}${pathname}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: ac.signal
        })
        const text = await res.text()
        let json = null
        try {
            json = JSON.parse(text)
        } catch {
            /* 非 JSON 响应 */
        }
        return { ok: res.ok, status: res.status, json, text }
    } finally {
        clearTimeout(timer)
    }
}

function readCalibration() {
    try {
        const raw = JSON.parse(fs.readFileSync(PATHS.calibration, 'utf8'))
        if (raw && Number.isFinite(raw.footprintMb) && raw.footprintMb > 100) {
            return {
                footprintMb: raw.footprintMb,
                measured: true,
                measuredAt: raw.measuredAt ?? null,
                samples: raw.samples ?? null,
                mode: raw.mode ?? null
            }
        }
    } catch {
        /* 无实测文件 */
    }
    return { footprintMb: BUDGET.defaultFootprintMb, measured: false, measuredAt: null, samples: null, mode: null }
}

/** 读 config.json，写入新的 clusters / accountDelay，保留其它字段并留一份备份 */
function applyConcurrencyConfig({ clusters, delayMin, delayMax }) {
    const raw = fs.readFileSync(PATHS.config, 'utf8')
    const before = JSON.parse(raw)
    const after = JSON.parse(raw)

    after.clusters = clusters
    after.accountDelay = { min: delayMin, max: delayMax }

    const backupDir = path.join(PATHS.data, 'config-backups')
    fs.mkdirSync(backupDir, { recursive: true })
    const stamp = nowIso().replace(/[:.]/g, '-')
    fs.writeFileSync(path.join(backupDir, `config-${stamp}.json`), JSON.stringify(before, null, 4))

    const tmp = `${PATHS.config}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(after, null, 4))
    fs.renameSync(tmp, PATHS.config)

    return {
        before: { clusters: before.clusters, accountDelay: before.accountDelay },
        after: { clusters: after.clusters, accountDelay: after.accountDelay }
    }
}

export function planConcurrency({ accounts, byMemory, concurrency, forceClusters }) {
    const count = Math.max(0, Number.isSafeInteger(accounts) ? accounts : 0)
    let clusters = Math.max(1, Math.min(count || 1, byMemory || 1))
    let forcedBy = null
    let limitedBy = clusters >= count && count > 0 ? 'accounts' : 'memory'
    if (concurrency != null && String(concurrency).trim() !== '') {
        const wanted = Number(concurrency)
        if (!Number.isSafeInteger(wanted) || wanted < 1) throw new RangeError('REWARDS_CONCURRENCY 必须是正整数')
        clusters = Math.min(count || 1, wanted)
        forcedBy = `env:concurrency:${wanted}`
        limitedBy = count <= wanted ? 'accounts' : 'concurrency'
    } else {
        const forceRaw = String(forceClusters ?? '')
            .trim()
            .toLowerCase()
        if (forceRaw === 'all') {
            clusters = Math.max(1, count)
            forcedBy = 'env:all'
        } else if (forceRaw) {
            const wanted = Number(forceRaw)
            if (!Number.isSafeInteger(wanted) || wanted < 1)
                throw new RangeError('REWARDS_FORCE_CLUSTERS 必须是 all 或正整数')
            clusters = Math.min(count || 1, wanted)
            forcedBy = `env:${wanted}`
        }
        if (forcedBy) limitedBy = 'forced'
    }
    return { clusters, forcedBy, limitedBy, serializedAccounts: clusters < count }
}

async function computePlan() {
    const statusRes = await apiFetch('/status')
    const accountsRes = await apiFetch('/accounts')
    if (!accountsRes.ok) {
        throw new Error(`无法读取 /accounts：${accountsRes.status} ${accountsRes.text?.slice(0, 200) ?? ''}`)
    }
    const accounts = accountsRes.json?.accounts ?? []
    const N = accounts.length

    const [memory, processes] = await Promise.all([readMemory(), readProcesses()])
    const cal = readCalibration()
    const reserveBytes = BUDGET.reserveGb * 1024 * 1024 * 1024
    const usableBytes = Math.max(0, (memory.availableBytes ?? 0) - reserveBytes)
    const byMemory = Math.floor(usableBytes / (cal.footprintMb * 1024 * 1024))
    const concurrency = planConcurrency({
        accounts: N,
        byMemory,
        concurrency: process.env.REWARDS_CONCURRENCY,
        forceClusters: process.env.REWARDS_FORCE_CLUSTERS
    })

    return {
        at: nowIso(),
        accounts: N,
        accountList: accounts.map(a => ({ index: a.index, email: a.email })),
        apiState: statusRes.json?.state ?? 'unknown',
        memory: {
            availableMb: Math.round((memory.availableBytes ?? 0) / 1048576),
            totalMb: Math.round((memory.totalBytes ?? 0) / 1048576),
            source: memory.source
        },
        footprintMb: cal.footprintMb,
        footprintMeasured: cal.measured,
        footprintMeasuredAt: cal.measuredAt,
        footprintMode: cal.mode,
        reserveMb: BUDGET.reserveGb * 1024,
        usableMb: Math.round(usableBytes / 1048576),
        byMemory,
        ...concurrency,
        runningNow: processes.workers?.length ?? 0
    }
}

async function refreshApiEnv() {
    const st = await apiFetch('/status', { timeout: 5000 }).catch(() => null)
    if (!st || !st.ok) return { ok: false, detail: 'Control API 不可达，跳过刷新' }
    if (st.json?.state && st.json.state !== 'idle') {
        return { ok: false, detail: `批次运行中（state=${st.json.state}），跳过刷新` }
    }

    const label = `gui/${typeof process.getuid === 'function' ? process.getuid() : 501}/local.rewards.api`
    const kicked = await new Promise(resolve => {
        execFile('/bin/launchctl', ['kickstart', '-k', label], { timeout: 15000 }, error => resolve(!error))
    })
    if (!kicked) return { ok: false, detail: 'launchctl kickstart 失败（也许服务未被 launchd 托管）' }

    for (let i = 0; i < 40; i += 1) {
        await new Promise(r => setTimeout(r, 500))
        const h = await apiFetch('/health', { timeout: 2000 }).catch(() => null)
        if (h?.ok) return { ok: true, detail: '已重启并重新读取 .env' }
    }
    return { ok: false, detail: '重启后 20 秒内未就绪' }
}

async function cmdRun() {
    const reason = String(arg('reason', 'manual'))
    const requestId = arg('request-id', null)
    if (requestId && !/^[A-Za-z0-9_.:-]{1,200}$/.test(String(requestId))) throw new Error('无效的请求标识')
    const dryRun = arg('dry-run', false) === true
    const accountFilter = arg('accounts', null)
    const delayMin = String(arg('delay-min', '20s'))
    const delayMax = String(arg('delay-max', '40s'))
    // 定时触发时若上一轮还没结束，不直接放弃，而是有限等待：
    // 每分钟查一次 /status，最多等 waitMin 分钟。避免"凌晨那一轮因为昨晚跑太久被跳过"。
    const waitMin = Number(arg('wait-min', 0)) || 0
    // 每轮开跑前刷新 Control API 的环境变量：
    // API 的账号列表在进程启动时就固定了（--env-file 只读一次），
    // 改了 .env 不重启就永远看不到新账号。只有确认空闲时才重启，避免打断在跑的批次。
    const refreshApi = arg('refresh-api', false) === true

    ensureDirs()
    const lock = acquireSchedulerLock(path.join(PATHS.data, '.scheduler.lock'))
    if (!lock.ok) {
        const rec = { at: nowIso(), reason, result: 'skipped', detail: lock.reason }
        appendJsonl(PATHS.schedulerLog, rec)
        writeJsonAtomic(PATHS.lastRun, rec)
        console.log(JSON.stringify(rec, null, 2))
        process.exitCode = 2
        return
    }

    try {
        if (requestId) {
            let prior = null
            try {
                prior = fs
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
                    .find(
                        record => record.requestId === requestId && ['started', 'deduplicated'].includes(record.result)
                    )
            } catch {
                /* 尚无调度记录 */
            }
            if (prior) {
                console.log(JSON.stringify({ at: nowIso(), result: 'deduplicated', requestId, runId: prior.runId }))
                return
            }
        }
        let plan = await computePlan()

        // 有限等待：上一轮还在跑就等它结束，最多等 waitMin 分钟
        let waitedMs = 0
        if (plan.apiState !== 'idle' && waitMin > 0) {
            const deadline = Date.now() + waitMin * 60000
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 60000))
                const st = await apiFetch('/status').catch(() => null)
                if (st?.json?.state === 'idle') break
            }
            waitedMs = waitMin * 60000 - Math.max(0, deadline - Date.now())
            plan = await computePlan()
            plan.waitedMinutes = Math.round(waitedMs / 60000)
        }

        // 关键顺序：必须等空闲之后再刷新 API 环境。
        // 否则上一轮还没结束时刷新会被跳过，等它跑完开新批次时用的仍是旧账号表，
        // 新增的账号不会进入本轮。刷新后重新统计，确保 N 与 clusters 基于最新 .env。
        if (refreshApi && !dryRun) {
            const refresh = await refreshApiEnv()
            plan = await computePlan()
            plan.apiRefresh = refresh
            if (typeof waitedMs === 'number' && waitedMs > 0) {
                plan.waitedMinutes = Math.round(waitedMs / 60000)
            }
        }

        if (plan.apiState !== 'idle') {
            const rec = {
                at: nowIso(),
                reason,
                result: 'skipped',
                detail: `上游已有运行中的批次（state=${plan.apiState}）`,
                plan
            }
            appendJsonl(PATHS.schedulerLog, rec)
            writeJsonAtomic(PATHS.lastRun, rec)
            console.log(JSON.stringify(rec, null, 2))
            process.exitCode = 2
            return
        }
        if (plan.accounts === 0) {
            const rec = { at: nowIso(), reason, result: 'failed', detail: '没有识别到任何账号，请检查 .env', plan }
            appendJsonl(PATHS.schedulerLog, rec)
            writeJsonAtomic(PATHS.lastRun, rec)
            console.log(JSON.stringify(rec, null, 2))
            process.exitCode = 1
            return
        }

        // 先把账号选择解析出来，再算有效并发。
        // 否则只跑 1 个账号时 clusters 仍按全部账号数记录，是错的数据。
        const body = requestId ? { requestId } : {}
        let selectedCount = plan.accounts
        if (accountFilter) {
            const values = String(accountFilter)
                .split(',')
                .map(v => v.trim())
            if (values.some(v => !/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v))))
                throw new Error('账号筛选包含无效编号')
            const wanted = [...new Set(values.map(Number))]
            const allIndexes = plan.accountList.map(a => a.index)
            const known = wanted.filter(i => allIndexes.includes(i))
            const unknown = wanted.filter(i => !allIndexes.includes(i))
            if (unknown.length) throw new Error(`账号编号不存在：${unknown.join(', ')}`)
            if (!known.length) throw new Error('账号筛选后没有剩余账号')
            selectedCount = known.length
            if (known.length === 1) body.accountIndex = known[0]
            else {
                const excluded = allIndexes.filter(i => !known.includes(i))
                if (excluded.length) body.excludedAccountIndexes = excluded
            }
        }

        const effectiveClusters = Math.max(1, Math.min(plan.clusters, selectedCount))
        plan.clustersAllAccounts = plan.clusters
        plan.clusters = effectiveClusters
        plan.selectedAccounts = selectedCount
        plan.serializedAccounts = effectiveClusters < selectedCount

        const configChange = dryRun
            ? { before: null, after: { clusters: effectiveClusters, accountDelay: { min: delayMin, max: delayMax } } }
            : applyConcurrencyConfig({ clusters: effectiveClusters, delayMin, delayMax })

        if (dryRun) {
            console.log(JSON.stringify({ dryRun: true, plan, configChange }, null, 2))
            return
        }

        const started = await apiFetch('/start', { method: 'POST', body })
        const duplicate = started.ok && started.json?.duplicate === true
        const ok = started.ok && (started.json?.started === true || duplicate)
        const rec = {
            at: nowIso(),
            reason,
            result: ok ? (duplicate ? 'deduplicated' : 'started') : 'failed',
            requestId,
            runId: started.json?.runId ?? null,
            detail: ok ? null : `上游拒绝启动：${started.status} ${started.text?.slice(0, 300) ?? ''}`,
            plan,
            configChange,
            pid: started.json?.pid ?? null,
            startedAt: started.json?.startedAt ?? null,
            requestedAccounts: accountFilter || 'all'
        }
        appendJsonl(PATHS.schedulerLog, rec)
        writeJsonAtomic(PATHS.lastRun, rec)
        console.log(JSON.stringify(rec, null, 2))
        if (!ok) process.exitCode = 1
    } catch (error) {
        const rec = { at: nowIso(), reason, result: 'failed', detail: error?.message ?? String(error) }
        appendJsonl(PATHS.schedulerLog, rec)
        writeJsonAtomic(PATHS.lastRun, rec)
        console.log(JSON.stringify(rec, null, 2))
        process.exitCode = 1
    } finally {
        releaseSchedulerLock(lock)
    }
}

async function cmdStatus() {
    let status = null
    let error = null
    try {
        const res = await apiFetch('/status')
        status = res.json
    } catch (e) {
        error = e?.message ?? String(e)
    }
    const plan = status ? await computePlan().catch(() => null) : null
    console.log(
        JSON.stringify(
            {
                api: status ? 'online' : 'offline',
                apiError: error,
                state: status?.state ?? null,
                pid: status?.pid ?? null,
                startedAt: status?.startedAt ?? null,
                plan
            },
            null,
            2
        )
    )
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const cmd = process.argv[2]
    if (cmd === 'run') await cmdRun()
    else if (cmd === 'status') await cmdStatus()
    else {
        console.error('用法：scheduler.mjs run [--reason daily] [--accounts 1,3] [--dry-run] | status')
        process.exitCode = 64
    }
}
