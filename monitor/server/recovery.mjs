// 批次恢复的公开决策接口。启动、停止与成功分别记录，恢复只针对未完成账号。
import fs from 'node:fs'
import path from 'node:path'
import { accountResultAt } from './runHistory.mjs'
export { readRunMetas } from './runHistory.mjs'

export function writeRecoveryPlan(file, plan) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(plan, null, 2))
    fs.renameSync(tmp, file)
}

export function readRecoveryPlan(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
        return null
    }
}

export async function recoverStalledRun({
    runId,
    accounts,
    existingPlan = null,
    save,
    stop,
    readStatus,
    retry,
    canRetry,
    noteRetry,
    wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
    stopTimeoutMs = 20000
}) {
    const plan = existingPlan ?? {
        runId,
        requestId: `recovery-${runId}`,
        createdAt: new Date().toISOString(),
        state: 'pending',
        accounts: accounts
            .filter(a => {
                const status = a.currentRunStatus ?? a.status
                return a.includedInCurrentRun !== false && status !== 'completed' && status !== 'not_run'
            })
            .map(a => ({ index: a.index, email: a.email }))
    }
    if (['scheduled', 'requires_attention'].includes(plan.state)) return plan
    const persist = state => {
        Object.assign(plan, state, { updatedAt: new Date().toISOString() })
        save(plan)
        return plan
    }
    if (!plan.runId || !plan.accounts.length)
        return persist({ state: 'requires_attention', reason: '缺少批次身份或未完成账号，无法自动恢复' })
    if (plan.state !== 'stopped') {
        persist({ state: 'pending' })
        const stopped = await stop(plan.runId)
        if (!stopped.ok)
            return persist({ state: 'requires_attention', reason: stopped.error ?? '停止未成功，不安排重试' })
        const deadline = Date.now() + stopTimeoutMs
        for (;;) {
            const status = await readStatus()
            if (status.runId && status.runId !== plan.runId)
                return persist({ state: 'requires_attention', reason: '当前批次已改变，未启动重试' })
            if (status.state === 'idle') break
            if (Date.now() >= deadline)
                return persist({ state: 'requires_attention', reason: '等待原批次停止超时，未启动重试' })
            await wait(250)
        }
        persist({ state: 'stopped' })
    }
    const eligible = plan.accounts.filter(a => canRetry(a.email))
    const blocked = plan.accounts.filter(a => !eligible.includes(a))
    if (!eligible.length)
        return persist({ state: 'requires_attention', reason: '未完成账号的当日重试次数已耗尽', blocked })
    // 同一请求键让重启后重复派发仍由调度器去重。
    const pid = await retry(
        eligible.map(a => a.index),
        plan.requestId
    )
    for (const a of eligible) noteRetry(a.email, plan.requestId)
    return persist({
        state: 'scheduled',
        dispatchAttempts: 1,
        retryPid: pid,
        retried: eligible,
        blocked,
        reason: blocked.length ? '部分账号重试耗尽，需人工处理' : null
    })
}

export async function refreshRecoveryPlan({ plan, records, status, isAlive, retry }) {
    if (plan.state !== 'scheduled') return plan
    if (status.requestId === plan.requestId)
        return { ...plan, state: 'started', retryRunId: status.runId, reason: '补跑批次已由 API 确认启动' }
    const receipt = [...records].reverse().find(record => record.requestId === plan.requestId)
    if (receipt && ['started', 'deduplicated'].includes(receipt.result))
        return { ...plan, state: 'started', retryRunId: receipt.runId, reason: '补跑批次已由调度器确认启动' }
    if (receipt && ['failed', 'skipped'].includes(receipt.result))
        return { ...plan, state: 'requires_attention', reason: `补跑调度未启动：${receipt.detail ?? receipt.result}` }
    if (isAlive(plan.retryPid)) return plan
    if ((plan.dispatchAttempts ?? 1) >= 3)
        return { ...plan, state: 'requires_attention', reason: '补跑调度多次退出且没有启动回执' }
    const retryPid = await retry(
        plan.retried.map(a => a.index),
        plan.requestId
    )
    return {
        ...plan,
        retryPid,
        dispatchAttempts: (plan.dispatchAttempts ?? 1) + 1,
        updatedAt: new Date().toISOString()
    }
}

export function planDailyRecovery({
    now = new Date(),
    scheduledAt,
    accounts,
    records,
    metas,
    apiHistory = [],
    maxAttempts = 3
}) {
    if (now < scheduledAt) return { action: 'skip', indexes: [], reason: '未到今日计划时间' }
    const inWindow = value => {
        const at = Date.parse(value ?? '')
        return Number.isFinite(at) && at >= scheduledAt.getTime() && at <= now.getTime()
    }
    const attempts = records.filter(r => ['daily', 'daily-catchup'].includes(r.reason) && inWindow(r.at))
    const completed = new Set(
        [...metas, ...apiHistory].flatMap(m =>
            (Array.isArray(m.accounts) ? m.accounts : [])
                .filter(a => a?.success === true && inWindow(accountResultAt(m, a)))
                .map(a => a.email)
        )
    )
    const pending = accounts.filter(a => !completed.has(a.email))
    const indexes = pending.map(a => a.index)
    if (!pending.length)
        return {
            action: 'skip',
            indexes,
            reason: accounts.length ? '今日所有账号均有成功终态' : '未配置账号',
            attempts: attempts.length
        }
    if (attempts.some(r => r.result === 'started' && !r.runId)) {
        return {
            action: 'requires_attention',
            indexes,
            reason: '旧版启动记录缺少runId且没有完整成功终态，需确认旧批次后恢复',
            attempts: attempts.length
        }
    }
    if (attempts.length >= maxAttempts)
        return {
            action: 'requires_attention',
            indexes,
            reason: '今日补跑次数已达上限，仍有未完成账号',
            attempts: attempts.length
        }
    return { action: 'start', indexes, reason: '仅恢复今日尚未成功的账号', attempts: attempts.length }
}
