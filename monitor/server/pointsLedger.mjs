// 积分台账：把每轮 meta.json 里的账号级积分汇总成"按天 × 按账号"的账本。
//
// Control API 保留运行身份和已观测日志；监控另把完整事件投影为
// monitor/data/runs/<批次>/meta.json，供跨批次、跨重启的按日查询。
// 此处只聚合已观测事实，不从进程启动或缺失记录推定积分。
//
// 口径说明：
//   collected  = 该轮已观测收益（账号终态或实时投影）
//   balance    = 该轮结束时的余额（finalPoints）
//   某天某账号的余额取当天最后一次观测值；当天没有观测则沿用之前最新的，并标注观测日期
// 缺失一律留 null，不用 0 或估算值填充。

import fs from 'node:fs'
import path from 'node:path'

import { calendarDate, shiftCalendarDate, REWARDS_TIME_ZONE } from './calendar.mjs'
import { readRunMetas } from './runHistory.mjs'

export function readBalanceSnapshots(file) {
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
        return raw && typeof raw === 'object' ? raw : {}
    } catch {
        return {}
    }
}

export function writeBalanceSnapshots(file, map) {
    const tmp = `${file}.tmp`
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2))
    fs.renameSync(tmp, file)
}

function validDate(value) {
    return shiftCalendarDate(value, 0) != null
}

export function buildLedger({ runsDir, emails = [], days = 30, from, to, balanceSnapshots = {}, now = new Date() }) {
    const metas = readRunMetas(runsDir)
    const wanted = new Set(emails)

    /** date -> email -> { collected, balance, runs, observedAt } */
    const byDate = new Map()
    /** email -> { value, at, runId } 最新一次观测到的余额 */
    const latestBalance = new Map()

    for (const meta of metas) {
        const date = calendarDate(meta.endedAt ?? meta.startedAt)
        if (!date) continue
        if (!byDate.has(date)) byDate.set(date, new Map())
        const dayMap = byDate.get(date)

        for (const acc of meta.accounts ?? []) {
            const email = acc.email
            if (!email) continue
            if (wanted.size && !wanted.has(email)) continue

            const entry = dayMap.get(email) ?? { collected: null, balance: null, runs: 0, observedAt: null }
            if (Number.isFinite(acc.collected)) entry.collected = (entry.collected ?? 0) + acc.collected
            entry.runs += 1
            if (Number.isFinite(acc.finalPoints)) {
                entry.balance = acc.finalPoints
                entry.observedAt = meta.endedAt ?? meta.startedAt ?? null
                const prev = latestBalance.get(email)
                const at = entry.observedAt ?? ''
                if (!prev || at >= (prev.at ?? '')) {
                    latestBalance.set(email, {
                        value: acc.finalPoints,
                        at: entry.observedAt,
                        runId: meta.runId ?? null
                    })
                }
            }
            dayMap.set(email, entry)
        }
    }

    const today = calendarDate(now)
    const lastDate = validDate(to) ? to : today
    const firstDate = validDate(from)
        ? from
        : shiftCalendarDate(lastDate, -(Math.max(1, Math.min(366, Math.floor(days))) - 1))
    const window = [...byDate.keys()]
        .filter(date => date >= firstDate && date <= lastDate)
        .sort()
        .reverse()

    const rows = window.map(date => {
        const dayMap = byDate.get(date)
        const accounts = {}
        let total = null
        for (const email of wanted.size ? [...wanted] : [...dayMap.keys()]) {
            const hit = dayMap.get(email)
            accounts[email] = hit
                ? { collected: hit.collected, balance: hit.balance, runs: hit.runs, observedAt: hit.observedAt }
                : { collected: null, balance: null, runs: 0, observedAt: null }
            if (hit && Number.isFinite(hit.collected)) total = (total ?? 0) + hit.collected
        }
        return { date, accounts, total }
    })

    const todayMap = byDate.get(today)

    // 余额合并：批次 meta 与运行中快照各有一条，取观测时间更新的那条。
    // 这样即使批次被中途停止（没有 ACCOUNT-END），也仍有余额可看。
    const balances = {}
    const keys = new Set([...(wanted.size ? wanted : []), ...latestBalance.keys(), ...Object.keys(balanceSnapshots)])
    for (const email of keys) {
        const fromMeta = latestBalance.get(email) ?? null
        const fromSnap = balanceSnapshots[email] ?? null
        const metaAt = fromMeta?.at ?? ''
        const snapAt = fromSnap?.at ?? ''
        if (fromSnap && snapAt >= metaAt) {
            balances[email] = {
                value: fromSnap.value ?? null,
                at: fromSnap.at ?? null,
                runId: fromSnap.runId ?? null,
                source: 'run-live'
            }
        } else if (fromMeta) {
            balances[email] = { value: fromMeta.value, at: fromMeta.at, runId: fromMeta.runId, source: 'run-meta' }
        } else {
            balances[email] = { value: null, at: null, runId: null, source: 'none' }
        }
    }

    // 近 7 天累计（用于"每日积分上新"的短期视图）
    const weekStart = shiftCalendarDate(today, -6)
    const last7 = [...byDate].filter(([date]) => date >= weekStart && date <= today)
    const weekTotals = {}
    for (const email of wanted.size ? [...wanted] : Object.keys(balances)) {
        weekTotals[email] = last7.reduce((sum, [, accounts]) => {
            const v = accounts.get(email)?.collected
            return Number.isFinite(v) ? (sum ?? 0) + v : sum
        }, null)
    }

    return {
        generatedAt: now.toISOString(),
        days: rows,
        today,
        timeZone: REWARDS_TIME_ZONE,
        range: { from: firstDate, to: lastDate },
        todayTotals: todayMap ? Object.fromEntries([...todayMap].map(([email, cell]) => [email, cell.collected])) : {},
        balances,
        weekTotals,
        runCount: metas.length,
        rangeRunCount: metas.filter(meta => {
            const date = calendarDate(meta.endedAt ?? meta.startedAt)
            return date && date >= firstDate && date <= lastDate
        }).length,
        source: 'monitor/data/runs/*/meta.json',
        note: '按批次结束日（进行中按开始日）归档已观测收益；跨日批次不推算逐条到账日期，未观测日留空'
    }
}

/**
 * 从历史事件流里回填余额。
 * 快照功能上线之前的批次没有 meta.finalPoints，但事件流里留有
 * `currentBalance=N` 的痕迹，可以按时间取最后一次观测值补回来。
 * 只补"比现有记录更新"的，不覆盖更新的数据。
 */
export function backfillBalancesFromEvents({ runsDir, snapshots = {} }) {
    if (!fs.existsSync(runsDir)) return snapshots
    const out = { ...snapshots }
    const dirs = fs.readdirSync(runsDir).sort()
    for (const name of dirs) {
        const file = path.join(runsDir, name, 'events.jsonl')
        if (!fs.existsSync(file)) continue
        let text
        try {
            text = fs.readFileSync(file, 'utf8')
        } catch {
            continue
        }
        for (const line of text.split('\n')) {
            if (!line || line.indexOf('currentBalance=') === -1) continue
            let ev
            try {
                ev = JSON.parse(line)
            } catch {
                continue
            }
            const email = ev.email
            if (!email) continue
            const msg = String(ev.message ?? '')
            const matches = [...msg.matchAll(/currentBalance=(\d+)/g)]
            if (!matches.length) continue
            const value = Number(matches[matches.length - 1][1])
            if (!Number.isFinite(value)) continue
            const at = ev.receivedAt ?? ev.ts ?? null
            const prev = out[email]
            if (!prev || String(at ?? '') >= String(prev.at ?? '')) {
                out[email] = { value, at, runId: ev.runId ?? name, source: 'event-backfill' }
            }
        }
    }
    return out
}
