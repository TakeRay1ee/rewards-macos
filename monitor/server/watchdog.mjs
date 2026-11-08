// 停滞看门狗。
//
// 背景：本机多次出现"账号长时间没有任何进展"的情况，两次卡在不同位置
// （HTTP 兜底请求、浏览器创建 newPage），共同点是：
//   上游对这些调用没有硬性超时，一个卡死的 Promise 会把整轮批次永久挂住。
// 事后复现发现这些挂起是偶发的，环境本身正常，因此不能靠"修某一行"解决，
// 需要一个外部看门狗：一旦某账号在合理时间内毫无进展，就判为停滞并自愈。
//
// 判定规则（避免误判正常的主动等待）：
//   - 只看处于 running/starting 的账号
//   - 该账号当前没有已知的 wait 状态（上游自己声明在等）
//   - 距最后一条日志超过 stallMs（默认 15 分钟，大于上游最长区间等待 11 分钟）
// 触发动作：
//   - 写 incidents.jsonl
//   - 强制停止当前批次（否则整批永远不结束）
//   - 若该账号当日重试次数未超限，恢复本轮所有尚未成功的账号

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { PATHS, ensureDirs } from './config.mjs'
import { calendarDate } from './calendar.mjs'

const INCIDENT_FILE = path.join(PATHS.data, 'incidents.jsonl')
const RETRY_FILE = path.join(PATHS.data, 'stall-retries.json')

export const WATCHDOG = {
    stallMs: Number(process.env.WATCHDOG_STALL_MS || 15 * 60 * 1000),
    maxRetriesPerDay: Number(process.env.WATCHDOG_MAX_RETRIES || 2),
    checkMs: Number(process.env.WATCHDOG_CHECK_MS || 30000)
}

function readRetryState() {
    try {
        const raw = JSON.parse(fs.readFileSync(RETRY_FILE, 'utf8'))
        const today = calendarDate(new Date())
        if (raw?.date !== today) return { date: today, counts: {} }
        return raw
    } catch {
        return { date: calendarDate(new Date()), counts: {}, requests: {} }
    }
}

function writeRetryState(state) {
    try {
        fs.mkdirSync(PATHS.data, { recursive: true })
        fs.writeFileSync(RETRY_FILE, JSON.stringify(state, null, 2))
    } catch {
        /* 忽略 */
    }
}

export function recordIncident(record) {
    try {
        ensureDirs()
        fs.appendFileSync(INCIDENT_FILE, JSON.stringify(record) + '\n')
    } catch {
        /* 忽略 */
    }
}

export function readIncidentTail(n = 20) {
    try {
        const lines = fs.readFileSync(INCIDENT_FILE, 'utf8').split('\n').filter(Boolean)
        return lines
            .slice(-n)
            .map(l => {
                try {
                    return JSON.parse(l)
                } catch {
                    return null
                }
            })
            .filter(Boolean)
    } catch {
        return []
    }
}

/**
 * 评估是否需要触发看门狗。
 * @param {{state:string, accounts:Array, now?:number}} input
 * @returns {null | {email:string, index:number, gapMs:number, lastTitle:string|null}}
 */
export function evaluateStall({ state, accounts, now = Date.now() }) {
    if (!state || state === 'idle') return null
    for (const a of accounts ?? []) {
        const status = a.currentRunStatus ?? a.status
        if (a.includedInCurrentRun === false || (status !== 'running' && status !== 'starting')) continue
        if (a.wait) continue // 上游自己声明在等待，不算停滞
        // 日志归属不可靠时，我们看不到该账号真实的步骤与等待状态，
        // 任何"无进展"判断都会误杀，直接跳过。
        if (a.attributionReliable === false) continue
        // 最后事件仍停在 ACCOUNT-START，说明我们只拿到了"账号开始"这一条，
        // 后续事件可能因归属/回放原因缺失。此时无法区分"真卡住"与"看不到"，
        // 按"疑罪从无"处理，不触发自愈，避免误杀健康批次。
        if (a.currentTask?.title === 'ACCOUNT-START') continue
        const lastAt = a.currentTask?.at
        const since = lastAt ? Date.parse(lastAt) : a.startedAt ? Date.parse(a.startedAt) : null
        if (!Number.isFinite(since)) continue
        const gapMs = now - since
        if (gapMs >= WATCHDOG.stallMs) {
            return { email: a.email, index: a.index, gapMs, lastTitle: a.currentTask?.title ?? null }
        }
    }
    return null
}

export function canRetry(email) {
    const state = readRetryState()
    const used = state.counts[email] ?? 0
    return used < WATCHDOG.maxRetriesPerDay
}

export function noteRetry(email, requestId = null) {
    const state = readRetryState()
    state.requests ??= {}
    const key = requestId ? `${requestId}:${email}` : null
    if (key && state.requests[key]) return state.counts[email] ?? 0
    if (key) state.requests[key] = true
    state.counts[email] = (state.counts[email] ?? 0) + 1
    writeRetryState(state)
    return state.counts[email]
}

/** 触发自愈：强停批次 + 单账号重跑（可选） */
export async function spawnRetryAfterStall(indexes, requestId) {
    const scheduler = path.join(PATHS.root, 'monitor', 'server', 'scheduler.mjs')
    const child = spawn(
        process.execPath,
        [
            scheduler,
            'run',
            '--reason',
            'auto-retry-stall',
            '--accounts',
            indexes.join(','),
            '--wait-min',
            '10',
            '--request-id',
            requestId
        ],
        { cwd: PATHS.root, detached: true, stdio: 'ignore', env: { ...process.env } }
    )
    await new Promise((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
    })
    child.unref()
    return child.pid
}
