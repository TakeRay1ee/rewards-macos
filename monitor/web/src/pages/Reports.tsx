import { useEffect, useMemo, useState } from 'react'
import { Card, Stat, fmtNum, fmtTime, shortEmail } from '../components'
import type { Ledger, Snapshot } from '../types'

type Preset = 'today' | '7d' | '30d' | 'thisMonth' | 'lastMonth' | 'custom'

const PRESETS: Array<{ id: Preset; label: string }> = [
    { id: 'today', label: '今日' },
    { id: '7d', label: '近 7 天' },
    { id: '30d', label: '近 30 天' },
    { id: 'thisMonth', label: '本月' },
    { id: 'lastMonth', label: '上月' },
    { id: 'custom', label: '自定义' }
]

function shiftDate(date: string, days: number) {
    const value = new Date(`${date}T00:00:00Z`)
    if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== date) return ''
    value.setUTCDate(value.getUTCDate() + days)
    return value.toISOString().slice(0, 10)
}

function rangeOf(preset: Preset, today: string): { from: string; to: string } {
    switch (preset) {
        case 'today':
            return { from: today, to: today }
        case '7d':
            return { from: shiftDate(today, -6), to: today }
        case '30d':
            return { from: shiftDate(today, -29), to: today }
        case 'thisMonth':
            return { from: today.slice(0, 8) + '01', to: today }
        case 'lastMonth': {
            const last = shiftDate(today.slice(0, 8) + '01', -1)
            return { from: last.slice(0, 8) + '01', to: last }
        }
        default:
            return { from: today, to: today }
    }
}

function daysBetween(from: string, to: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return 0
    if (!shiftDate(from, 0) || !shiftDate(to, 0)) return 0
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1
    return span > 0 ? span : 0
}

function trendAxis(totals: Array<number | null>) {
    const observed = totals.filter((value): value is number => value != null && Number.isFinite(value))
    if (!observed.length) return { min: 0, max: 1, ticks: [] as number[], observed: false }
    const low = Math.min(0, ...observed)
    const high = Math.max(0, ...observed)
    if (low === 0 && high === 0) return { min: 0, max: 1, ticks: [0], observed: true }
    const targetStep = (high - low) / 4
    const magnitude = 10 ** Math.floor(Math.log10(targetStep))
    const ratio = targetStep / magnitude
    const factor = [1, 2, 2.5, 5, 10].reduce((nearest, value) =>
        Math.abs(value - ratio) < Math.abs(nearest - ratio) ? value : nearest
    )
    const step = factor * magnitude
    const min = Number((Math.floor(low / step) * step).toPrecision(12))
    const max = Number((Math.ceil(high / step) * step).toPrecision(12))
    const intervals = Math.round((max - min) / step)
    const ticks = Array.from({ length: intervals + 1 }, (_, index) => Number((max - index * step).toPrecision(12)))
    return { min, max, ticks, observed: true }
}

export function Reports({ snap }: { snap: Snapshot }) {
    const [preset, setPreset] = useState<Preset>('7d')
    const calendarToday = snap.ledger?.today ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
    const defaultRange = rangeOf('7d', calendarToday)
    const [from, setFrom] = useState(defaultRange.from)
    const [to, setTo] = useState(defaultRange.to)
    const [ledger, setLedger] = useState<Ledger | null>(snap.ledger)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const spanDays = daysBetween(from, to)
    const validRange = spanDays > 0 && spanDays <= 366
    useEffect(() => {
        if (preset !== 'custom') {
            const range = rangeOf(preset, calendarToday)
            setFrom(range.from)
            setTo(range.to)
        }
    }, [calendarToday, preset])

    // The existing ledger heartbeat also refreshes custom windows outside the
    // snapshot's short range, including delayed facts with unchanged runCount.
    const ledgerRevision = JSON.stringify(
        snap.ledger
            ? {
                  generatedAt: snap.ledger.generatedAt,
                  days: snap.ledger.days,
                  balances: snap.ledger.balances,
                  runCount: snap.ledger.runCount
              }
            : null
    )
    // 按所选自然日查询，旧请求不能覆盖后来的响应。
    useEffect(() => {
        if (!validRange) return
        const controller = new AbortController()
        const fresh = snap.ledger
        if (fresh?.range && fresh.range.from <= from && fresh.range.to >= to) setLedger(fresh)
        setLoading(true)
        setError(null)
        fetch(`/api/points/daily?from=${from}&to=${to}`, { signal: controller.signal })
            .then(r => (r.ok ? r.json() : Promise.reject(new Error(`读取失败 ${r.status}`))))
            .then(d => {
                if (d && !controller.signal.aborted) setLedger(d)
            })
            .catch(cause => {
                if (!controller.signal.aborted) setError(cause.message)
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false)
            })
        return () => controller.abort()
    }, [ledgerRevision, from, to, validRange])

    const applyPreset = (p: Preset) => {
        setPreset(p)
        if (p !== 'custom') {
            const r = rangeOf(p, calendarToday)
            setFrom(r.from)
            setTo(r.to)
        }
    }

    const accounts = snap.accounts
    const rows = useMemo(() => {
        if (!validRange) return []
        const recorded = new Map((ledger?.days ?? []).map(row => [row.date, row]))
        return Array.from({ length: spanDays }, (_, index) => {
            const date = shiftDate(to, -index)
            return recorded.get(date) ?? { date, accounts: {}, total: null }
        })
    }, [ledger, from, to, spanDays, validRange])

    const stats = useMemo(() => {
        const perAccount = accounts.map(a => {
            let sum = 0
            let observedDays = 0
            for (const r of rows) {
                const v = r.accounts[a.email]?.collected
                if (typeof v === 'number' && Number.isFinite(v)) {
                    sum += v
                    observedDays += 1
                }
            }
            return { email: a.email, index: a.index, sum, observedDays }
        })
        const total = perAccount.reduce((s, x) => s + x.sum, 0)
        const dayTotals = rows.map(row => {
            const values = accounts
                .map(account => row.accounts[account.email]?.collected)
                .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
            return {
                date: row.date,
                total: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
                observedAccounts: values.length
            }
        })
        const observedTotals = dayTotals.filter((day): day is typeof day & { total: number } => day.total !== null)
        const best = observedTotals.reduce(
            (m, d) => (m == null || d.total > m.total ? d : m),
            null as null | { date: string; total: number }
        )
        const observedDays = observedTotals.length
        return { perAccount, total, best, observedDays, spanDays, dayTotals }
    }, [rows, accounts, from, to])

    const axis = useMemo(() => trendAxis(stats.dayTotals.map(day => day.total)), [stats.dayTotals])
    const scale = axis.max - axis.min
    const ceiling = axis.max
    const zeroPosition = (ceiling / scale) * 100
    const rangeError = !validRange ? '请选择有效日期，开始日期不晚于结束日期，范围最多 366 天。' : null

    return (
        <>
            <div className="page-head">
                <div>
                    <h2>积分报表</h2>
                    <p>
                        按 {ledger?.timeZone ?? 'Asia/Shanghai'} 自然日查看已观测收益。
                        {loading ? ' · 刷新中…' : ''}
                    </p>
                </div>
            </div>

            <div className="toolbar">
                {PRESETS.map(p => (
                    <button
                        key={p.id}
                        aria-pressed={preset === p.id}
                        className={`btn${preset === p.id ? ' active' : ''}`}
                        onClick={() => applyPreset(p.id)}
                    >
                        {p.label}
                    </button>
                ))}
                <div className="date-range">
                    <input
                        className="input"
                        type="date"
                        aria-label="开始日期"
                        value={from}
                        onChange={e => {
                            setFrom(e.target.value)
                            setPreset('custom')
                        }}
                        style={{ width: 148 }}
                    />
                    <span className="muted">至</span>
                    <input
                        className="input"
                        type="date"
                        aria-label="结束日期"
                        value={to}
                        onChange={e => {
                            setTo(e.target.value)
                            setPreset('custom')
                        }}
                        style={{ width: 148 }}
                    />
                </div>
                <div className="spacer" />
                <span className="muted" style={{ fontSize: 11.5 }}>
                    {from} ~ {to} · 共 {stats.spanDays} 天
                </span>
            </div>

            {rangeError || error ? (
                <div className="banner warn" role="status">
                    {rangeError ?? `报表暂未同步：${error}。保留已读取的记录。`}
                </div>
            ) : null}
            <div className="grid stats" style={{ marginBottom: 14 }}>
                <Stat
                    label="区间合计"
                    value={fmtNum(stats.observedDays ? stats.total : null)}
                    hint={`${accounts.length} 个账号`}
                />
                <Stat
                    label="有记录天数"
                    value={`${stats.observedDays} / ${stats.spanDays}`}
                    hint={
                        stats.spanDays
                            ? stats.observedDays
                                ? `有记录日均 ${(stats.total / stats.observedDays).toFixed(1)}`
                                : '日均 —'
                            : '—'
                    }
                />
                <Stat
                    label="最高单日"
                    value={stats.best ? fmtNum(stats.best.total) : '—'}
                    hint={stats.best ? stats.best.date : '暂无数据'}
                />
                <Stat
                    label="全部记录批次"
                    value={fmtNum(ledger?.runCount ?? null)}
                    small
                    hint={ledger ? `更新于 ${fmtTime(ledger.generatedAt)}` : '—'}
                />
            </div>

            <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.15fr)' }}>
                <Card title="每日趋势">
                    {stats.dayTotals.length === 0 ? (
                        <div className="empty">请选择有效的日期区间</div>
                    ) : (
                        <div
                            className="trend-chart"
                            role="img"
                            aria-label={`每日收益趋势，按日期连续展示，缺失记录显示横线；${axis.observed ? '纵轴随当前区间收益自动缩放' : '当前区间暂无收益观测'}`}
                            data-axis-min={axis.observed ? axis.min : undefined}
                            data-axis-max={axis.observed ? axis.max : undefined}
                        >
                            <div className="trend-axis" aria-hidden="true">
                                {axis.ticks.length ? (
                                    axis.ticks.map(value => (
                                        <span
                                            className="trend-tick"
                                            key={value}
                                            style={{ top: `${((ceiling - value) / scale) * 100}%` }}
                                        >
                                            {value}
                                        </span>
                                    ))
                                ) : (
                                    <span className="trend-axis-empty">—</span>
                                )}
                            </div>
                            <div className="trend-scroll" tabIndex={0} aria-label="按日期横向查看趋势">
                                <div
                                    className="trend-days"
                                    style={{
                                        gridTemplateColumns: `repeat(${stats.dayTotals.length}, minmax(44px, 1fr))`,
                                        minWidth: stats.dayTotals.length * 44
                                    }}
                                >
                                    {[...stats.dayTotals].reverse().map(day => {
                                        const amount = day.total
                                        const height = amount == null ? 0 : (Math.abs(amount) / scale) * 100
                                        const top =
                                            amount == null || amount <= 0
                                                ? zeroPosition
                                                : ((ceiling - amount) / scale) * 100
                                        return (
                                            <div
                                                className="trend-day"
                                                key={day.date}
                                                data-date={day.date}
                                                data-value={amount ?? 'unknown'}
                                                title={`${day.date}：${amount == null ? '未观测' : `${amount} 分`}；${day.observedAccounts}/${accounts.length} 个账号有记录`}
                                            >
                                                <span className="trend-value">{amount ?? '—'}</span>
                                                <div className="trend-slot">
                                                    {axis.ticks
                                                        .filter(value => value !== 0)
                                                        .map(value => (
                                                            <span
                                                                className="trend-gridline"
                                                                key={value}
                                                                style={{ top: `${((ceiling - value) / scale) * 100}%` }}
                                                            />
                                                        ))}
                                                    <span
                                                        className="trend-baseline"
                                                        style={{ top: `${zeroPosition}%` }}
                                                    />
                                                    {amount == null ? (
                                                        <span
                                                            className="trend-missing"
                                                            style={{ top: `${zeroPosition}%` }}
                                                        >
                                                            —
                                                        </span>
                                                    ) : (
                                                        <i
                                                            className={`trend-bar${amount === 0 ? ' is-zero' : amount < 0 ? ' is-negative' : ''}`}
                                                            style={{
                                                                top: `${top}%`,
                                                                height: amount === 0 ? 2 : `${height}%`
                                                            }}
                                                        />
                                                    )}
                                                </div>
                                                <span className="trend-date">
                                                    {day.date.slice(5).replace('-', '/')}
                                                </span>
                                            </div>
                                        )
                                    })}
                                </div>
                            </div>
                        </div>
                    )}
                    <p className="trend-note">
                        纵轴随当前区间的已观测收益自动缩放。日期从左到右连续排列；0 表示已确认零收益，—
                        表示没有观测。部分账号缺失时，合计仅含已有记录。
                    </p>
                    <p className="trend-note">
                        按批次结束日归档，进行中按开始日；跨日批次不推算逐日到账。{loading ? '正在同步…' : ''}
                    </p>
                </Card>

                <Card title="各账号区间对比">
                    {accounts.length === 0 ? (
                        <div className="empty">暂无账号</div>
                    ) : (
                        <div className="table-wrap" style={{ border: 'none' }}>
                            <table>
                                <thead>
                                    <tr>
                                        <th>账号</th>
                                        <th className="num">区间合计</th>
                                        <th className="num">日均</th>
                                        <th className="num">占比</th>
                                        <th className="num">当前余额</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {stats.perAccount.map(a => {
                                        const share =
                                            stats.total > 0 && a.observedDays ? (a.sum / stats.total) * 100 : null
                                        const bal = ledger?.balances?.[a.email]?.value ?? null
                                        return (
                                            <tr key={a.email}>
                                                <td className="email-cell" title={a.email}>
                                                    #{a.index} {shortEmail(a.email)}
                                                </td>
                                                <td className="num">{fmtNum(a.observedDays ? a.sum : null)}</td>
                                                <td className="num">
                                                    {a.observedDays ? (a.sum / a.observedDays).toFixed(1) : '—'}
                                                </td>
                                                <td className="num">{share == null ? '—' : `${share.toFixed(1)}%`}</td>
                                                <td className="num">{bal == null ? '—' : fmtNum(bal)}</td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </Card>
            </div>

            <div style={{ marginTop: 14 }}>
                <Card title="每日明细">
                    {rows.length === 0 ? (
                        <div className="empty">
                            该区间还没有记录
                            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                                每轮结束会写入当日各账号获得积分；未观测到的账号留空，不做补零
                            </div>
                        </div>
                    ) : (
                        <div className="table-wrap" style={{ border: 'none', maxHeight: 520 }}>
                            <table>
                                <thead>
                                    <tr>
                                        <th>日期</th>
                                        {accounts.map(a => (
                                            <th key={a.email} className="num" title={a.email}>
                                                #{a.index} {shortEmail(a.email)}
                                            </th>
                                        ))}
                                        <th className="num">当日合计</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map((r, index) => (
                                        <tr key={r.date}>
                                            <td className="mono">{r.date}</td>
                                            {accounts.map(a => {
                                                const cell = r.accounts[a.email]
                                                const v = cell?.collected
                                                return (
                                                    <td className="num" key={a.email}>
                                                        {v == null ? (
                                                            <span className="muted">—</span>
                                                        ) : (
                                                            <span
                                                                title={
                                                                    cell?.balance != null
                                                                        ? `当日末余额 ${cell.balance}`
                                                                        : undefined
                                                                }
                                                            >
                                                                {v > 0 ? `+${v}` : v}
                                                            </span>
                                                        )}
                                                    </td>
                                                )
                                            })}
                                            <td className="num">
                                                <b>{stats.dayTotals[index].total ?? '—'}</b>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </Card>
            </div>
        </>
    )
}
