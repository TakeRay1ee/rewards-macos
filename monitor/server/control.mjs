// 受控运维动作。监控服务的唯一写入口。
//
// 设计约束（按用户重新授权后的范围）：
//   - 动作全部白名单，参数经过校验，不存在任意命令执行
//   - 必须提供本地控制密钥（首次启动自动生成，权限 600）
//   - 每个动作需要 confirmed=true，动作之间 4 秒冷却
//   - 每次操作写审计日志
//   - 服务只绑定 127.0.0.1

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'

import { PATHS, CONTROL_API, ensureDirs } from './config.mjs'

const TOKEN_FILE = path.join(PATHS.data, 'control-token.txt')
const AUDIT_FILE = path.join(PATHS.data, 'control-audit.jsonl')
const COOLDOWN_MS = 4000

let lastActionAt = 0

export function ensureControlToken() {
    ensureDirs()
    try {
        const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
        if (existing.length >= 32) return existing
    } catch {
        /* 首次生成 */
    }
    const token = crypto.randomBytes(24).toString('hex')
    fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 })
    return token
}

export function controlTokenPath() {
    return TOKEN_FILE
}

export function verifyToken(input) {
    if (typeof input !== 'string' || input.length === 0) return false
    let expected
    try {
        expected = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
    } catch {
        return false
    }
    const a = Buffer.from(input)
    const b = Buffer.from(expected)
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
}

function audit(record) {
    try {
        ensureDirs()
        fs.appendFileSync(AUDIT_FILE, JSON.stringify(record) + '\n')
    } catch {
        /* 审计失败不影响主流程 */
    }
}

export function readAuditTail(n = 20) {
    try {
        const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean)
        return lines
            .slice(-n)
            .map(line => {
                try {
                    return JSON.parse(line)
                } catch {
                    return null
                }
            })
            .filter(Boolean)
    } catch {
        return []
    }
}

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : 501)

export function launchctlArgs(action, label, userId = uid()) {
    return [action, ...(action === 'kickstart' ? ['-k'] : []), `gui/${userId}/${label}`]
}

function launchctl(action, label) {
    return new Promise(resolve => {
        execFile('/bin/launchctl', launchctlArgs(action, label), { timeout: 15000 }, (error, stdout, stderr) => {
            resolve({
                ok: !error,
                detail: error ? String(stderr || error.message).slice(0, 300) : String(stdout).trim().slice(0, 200)
            })
        })
    })
}

async function upstream(pathname, { method = 'POST', body = null, timeout = 15000 } = {}) {
    const headers = { 'Content-Type': 'application/json' }
    if (CONTROL_API.token) headers.Authorization = `Bearer ${CONTROL_API.token}`
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

async function upstreamState() {
    try {
        const res = await upstream('/status', { method: 'GET', timeout: 5000 })
        return res.json?.state ?? 'unknown'
    } catch {
        return 'unreachable'
    }
}

function spawnScheduler(extraArgs, reason) {
    const scheduler = path.join(PATHS.root, 'monitor', 'server', 'scheduler.mjs')
    const child = spawn(process.execPath, [scheduler, 'run', '--reason', reason, ...extraArgs], {
        cwd: PATHS.root,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env }
    })
    child.unref()
    return child.pid
}

export function normalizeIndexes(input, configuredIndexes = null) {
    if (!Array.isArray(input) || input.length === 0) return null
    if (input.some(n => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1)) return null
    if (configuredIndexes && input.some(n => !configuredIndexes.includes(n))) return null
    return [...new Set(input)].sort((a, b) => a - b)
}

const ACTIONS = {
    // 全部账号跑一轮
    'run-now': async () => {
        const state = await upstreamState()
        if (state !== 'idle') {
            return { accepted: true, skipped: true, detail: `上游已有批次（state=${state}），本次未启动。` }
        }
        const pid = spawnScheduler([], 'manual-gui')
        return { accepted: true, detail: `已交给调度器（pid ${pid}），它会先算并发再启动。` }
    },

    // 只跑选中的账号
    'run-selected': async params => {
        const configured = await upstream('/accounts', { method: 'GET' })
        if (!configured.ok) throw new Error('无法读取已配置账号，未启动任务')
        const indexes = normalizeIndexes(
            params?.accounts,
            (configured.json?.accounts ?? []).map(a => a.index)
        )
        if (!indexes) throw new Error('账号选择必须是非空、已配置的正整数编号列表；不接受无效或不存在的编号')
        const state = await upstreamState()
        if (state !== 'idle') {
            return { accepted: true, skipped: true, detail: `上游已有批次（state=${state}），本次未启动。` }
        }
        const pid = spawnScheduler(['--accounts', indexes.join(',')], 'manual-gui-subset')
        return { accepted: true, detail: `已交给调度器（pid ${pid}），仅运行账号 ${indexes.join(', ')}。` }
    },

    // 优雅停止：SIGTERM 整个进程组，15 秒后自动升级 SIGKILL
    'stop-run': async params => {
        const res = await upstream('/stop', { body: { force: false, expectedRunId: params?.expectedRunId } })
        if (res.status === 409) return { accepted: false, noop: true, detail: '当前没有运行中的批次。' }
        if (!res.ok) throw new Error(`上游拒绝停止：${res.status} ${res.text?.slice(0, 160) ?? ''}`)
        return { accepted: true, detail: '已发送停止信号（SIGTERM），15 秒内未退出会自动强制结束。' }
    },

    // 强制停止：直接 SIGKILL 进程组
    'force-stop-run': async params => {
        const res = await upstream('/stop', { body: { force: true, expectedRunId: params?.expectedRunId } })
        if (res.status === 409) return { accepted: false, noop: true, detail: '当前没有运行中的批次。' }
        if (!res.ok) throw new Error(`上游拒绝停止：${res.status} ${res.text?.slice(0, 160) ?? ''}`)
        return { accepted: true, detail: '已强制结束（SIGKILL）。浏览器进程可能残留，必要时点「重启服务」。' }
    },

    // 重启常驻服务：先重启 API（不影响本进程），再延迟重启监控自身
    'restart-services': async () => {
        const before = await upstream('/health', { method: 'GET', timeout: 3000 }).catch(() => null)
        const api = await launchctl('kickstart', 'local.rewards.api')
        if (!api.ok) throw new Error(`Control API 重启失败：${api.detail}`)
        let ready = false
        for (let attempt = 0; attempt < 40; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 500))
            const health = await upstream('/health', { method: 'GET', timeout: 1500 }).catch(() => null)
            if (
                health?.ok &&
                health.json?.serviceStartedAt &&
                health.json.serviceStartedAt !== before?.json?.serviceStartedAt
            ) {
                ready = true
                break
            }
        }
        if (!ready) throw new Error('重启命令已发出，但未观测到新的 API 实例；监控服务保持运行')
        setTimeout(() => {
            void launchctl('kickstart', 'local.rewards.monitor').then(result => {
                if (!result.ok)
                    audit({
                        at: new Date().toISOString(),
                        action: 'restart-monitor',
                        result: 'failed',
                        detail: result.detail
                    })
            })
        }, 1200)
        return {
            accepted: true,
            detail: '已确认 Control API 新实例就绪；监控服务将在约 1 秒后重启，页面会自动重连。'
        }
    }
}

export function listActions() {
    return Object.keys(ACTIONS)
}

/** 执行一个白名单动作。返回 { ok, status, body } */
export async function runAction(name, { confirmed, params = {}, source = 'gui' } = {}) {
    const at = new Date().toISOString()

    if (!Object.prototype.hasOwnProperty.call(ACTIONS, name)) {
        return { ok: false, status: 400, body: { error: `未知动作：${name}`, allowed: listActions() } }
    }
    if (confirmed !== true) {
        return { ok: false, status: 400, body: { error: '这个操作需要二次确认（confirmed=true）' } }
    }
    const now = Date.now()
    if (now - lastActionAt < COOLDOWN_MS) {
        return {
            ok: false,
            status: 429,
            body: { error: `操作太频繁，请等待 ${Math.ceil((COOLDOWN_MS - (now - lastActionAt)) / 1000)} 秒` }
        }
    }
    lastActionAt = now

    try {
        const result = await ACTIONS[name](params)
        audit({
            at,
            action: name,
            source,
            result: result.accepted ? 'accepted' : 'noop',
            detail: result.detail,
            params
        })
        return { ok: true, status: 200, body: { ok: true, action: name, at, ...result } }
    } catch (error) {
        const detail = error?.message ?? String(error)
        audit({ at, action: name, source, result: 'failed', detail, params })
        return { ok: false, status: 400, body: { error: '动作执行失败', detail } }
    }
}
