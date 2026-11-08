import { useMemo, useState } from 'react'
import { WaitChip, AccountStatusPill, fmtClock, fmtDuration, fmtNum, fmtTime } from '../components'
import type { AccountStatus, Snapshot } from '../types'
import { STATUS_LABEL, STATUS_ORDER } from '../types'

type SortKey = 'default' | 'points' | 'duration' | 'email'

export function Accounts({ snap, goto }: { snap: Snapshot; goto: (route: string) => void }) {
    const [q, setQ] = useState('')
    const [status, setStatus] = useState<AccountStatus | 'all'>('all')
    const [onlyAbnormal, setOnlyAbnormal] = useState(false)
    const [sort, setSort] = useState<SortKey>('default')

    const rows = useMemo(() => {
        let list = [...snap.accounts]
        if (q.trim()) {
            const needle = q.trim().toLowerCase()
            list = list.filter(a => a.email.toLowerCase().includes(needle))
        }
        if (status !== 'all') list = list.filter(a => a.status === status)
        if (onlyAbnormal)
            list = list.filter(a => a.status === 'failed' || a.status === 'unknown' || a.status === 'stopped')
        if (sort === 'points') list.sort((a, b) => (b.collectedThisRun ?? -1) - (a.collectedThisRun ?? -1))
        if (sort === 'duration') list.sort((a, b) => (b.durationSec ?? -1) - (a.durationSec ?? -1))
        if (sort === 'email') list.sort((a, b) => a.email.localeCompare(b.email))
        return list
    }, [snap.accounts, q, status, onlyAbnormal, sort])

    const counts = useMemo(() => {
        const m: Record<string, number> = {}
        for (const a of snap.accounts) m[a.status] = (m[a.status] ?? 0) + 1
        return m
    }, [snap.accounts])

    return (
        <>
            <div className="page-head">
                <div>
                    <h2>多账号实时监控</h2>
                    <p>共 {snap.accounts.length} 个账号，本轮进度与今日结果分别保留。</p>
                </div>
            </div>

            <div className="toolbar">
                <input
                    className="input"
                    placeholder="搜索账号邮箱"
                    aria-label="搜索账号邮箱"
                    value={q}
                    onChange={e => setQ(e.target.value)}
                    style={{ width: 220 }}
                />
                <select
                    className="select"
                    aria-label="按账号状态筛选"
                    value={status}
                    onChange={e => setStatus(e.target.value as AccountStatus | 'all')}
                >
                    <option value="all">全部状态（{snap.accounts.length}）</option>
                    {STATUS_ORDER.map(s => (
                        <option key={s} value={s}>
                            {STATUS_LABEL[s]}（{counts[s] ?? 0}）
                        </option>
                    ))}
                </select>
                <select
                    className="select"
                    aria-label="账号排序"
                    value={sort}
                    onChange={e => setSort(e.target.value as SortKey)}
                >
                    <option value="default">默认顺序</option>
                    <option value="points">按本轮积分</option>
                    <option value="duration">按运行时间</option>
                    <option value="email">按邮箱</option>
                </select>
                <button
                    aria-pressed={onlyAbnormal}
                    className={`btn${onlyAbnormal ? ' active' : ''}`}
                    onClick={() => setOnlyAbnormal(v => !v)}
                    title="只看执行失败、已停止、状态未知的账号"
                >
                    只看异常
                </button>
                <div className="spacer" />
                <span className="muted" style={{ fontSize: 11.5 }}>
                    自动刷新中 · 显示 {rows.length} 条
                </span>
            </div>

            {rows.length === 0 ? (
                <div className="card empty">没有符合条件的账号</div>
            ) : (
                <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 260px)' }}>
                    <table>
                        <thead>
                            <tr>
                                <th style={{ width: 38 }}>#</th>
                                <th>账号邮箱</th>
                                <th>状态</th>
                                <th>当前任务</th>
                                <th style={{ width: 74 }}>工作进程</th>
                                <th style={{ width: 100 }}>开始时间</th>
                                <th className="num" style={{ width: 88 }}>
                                    已运行
                                </th>
                                <th className="num" style={{ width: 78 }}>
                                    本轮积分
                                </th>
                                <th className="num">今日积分</th>
                                <th className="num" style={{ width: 78 }}>
                                    当前余额
                                </th>
                                <th style={{ width: 96 }}>最近结果</th>
                                <th>最近错误</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(a => (
                                <tr key={a.email}>
                                    <td className="muted">{a.index}</td>
                                    <td className="email-cell">
                                        <button
                                            className="link"
                                            onClick={() => goto(`/accounts/${encodeURIComponent(a.email)}`)}
                                        >
                                            {a.email}
                                        </button>
                                    </td>
                                    <td>
                                        <AccountStatusPill account={a} />
                                        {a.includedInCurrentRun === false ? (
                                            <div className="muted" style={{ marginTop: 5, fontSize: 11 }}>
                                                未参与本轮
                                            </div>
                                        ) : null}
                                    </td>
                                    <td className="task-cell secondary">
                                        {a.attributionReliable === false ? (
                                            <span className="muted" title={a.attributionNote ?? ''}>
                                                归属不可用（旧批次日志）
                                            </span>
                                        ) : a.wait ? (
                                            <WaitChip wait={a.wait} />
                                        ) : a.currentTask ? (
                                            <span title={a.currentTask.message}>
                                                <span className="tag">{a.currentTask.title ?? 'LOG'}</span>{' '}
                                                {a.currentTask.message.slice(0, 62)}
                                            </span>
                                        ) : (
                                            <span className="muted">—</span>
                                        )}
                                    </td>
                                    <td className="mono muted">{a.workerPid ?? '未知'}</td>
                                    <td className="mono">{a.startedAt ? fmtClock(a.startedAt) : '—'}</td>
                                    <td className="num">{fmtDuration(a.durationSec)}</td>
                                    <td className="num">{fmtNum(a.collectedThisRun)}</td>
                                    <td className="num">{fmtNum(snap.ledger?.todayTotals[a.email])}</td>
                                    <td className="num">{fmtNum(a.balance)}</td>
                                    <td title={a.lastRunAt ? fmtTime(a.lastRunAt) : undefined}>
                                        {a.lastSuccess === true ? (
                                            <span style={{ color: 'var(--ok)' }}>成功</span>
                                        ) : a.lastSuccess === false ? (
                                            <span style={{ color: 'var(--danger)' }}>失败</span>
                                        ) : (
                                            <span className="muted">—</span>
                                        )}
                                    </td>
                                    <td className="err-cell">
                                        {a.error || a.lastError ? (
                                            <span className="err-text" title={a.error ?? a.lastError ?? ''}>
                                                {(a.error ?? a.lastError ?? '').slice(0, 60)}
                                            </span>
                                        ) : (
                                            <span className="muted">—</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    )
}
