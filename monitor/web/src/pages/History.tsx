import { useEffect, useMemo, useState } from 'react'
import { Card, Stat, fmtNum, fmtTime } from '../components'
import type { Snapshot } from '../types'

interface Batch {
    runId?: string
    startedAt?: string | null
    endedAt?: string | null
    accountsTotal?: number | null
    logEvents?: number | null
    exit?: { code: number | null; signal: string | null; at?: string } | null
    totals?: { collected: number; oldTotal: number; newTotal: number } | null
    accounts?: Array<{
        email: string
        success: boolean | null
        collected?: number | null
        collectedObserved?: boolean
        error?: string | null
    }>
}

export function History({ snap }: { snap: Snapshot }) {
    const [local, setLocal] = useState<Batch[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [expanded, setExpanded] = useState<string | null>(null)
    useEffect(() => {
        const controller = new AbortController()
        fetch('/api/runs', { signal: controller.signal })
            .then(response =>
                response.ok ? response.json() : Promise.reject(new Error(`读取失败 ${response.status}`))
            )
            .then(data => {
                if (!controller.signal.aborted) {
                    setLocal(data.runs ?? [])
                    setError(null)
                }
            })
            .catch(cause => {
                if (!controller.signal.aborted) setError(cause.message)
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false)
            })
        return () => controller.abort()
    }, [snap.run.runId, snap.run.endedAt, snap.run.logEventCount])
    const batches = useMemo(() => {
        const merged: Batch[] = [...local]
        for (const run of snap.history) {
            const index = merged.findIndex(batch => {
                if (batch.runId && batch.runId === run.runId) return true
                if (!batch.startedAt || batch.startedAt !== run.startedAt) return false
                const legacyId = batch.startedAt.replace(/[:.]/g, '-')
                return !batch.runId || !run.runId || batch.runId === legacyId || run.runId === legacyId
            })
            const previous = merged[index]
            const accounts = new Map((previous?.accounts ?? []).map(account => [account.email, account]))
            for (const account of run.accounts ?? []) {
                const saved = accounts.get(account.email)
                // Older APIs omitted the observation flag and defaulted unknown
                // earnings to zero. Nonzero earnings or a confirmed completion
                // still provide evidence; new APIs explicitly mark observed zero.
                const observed =
                    account.collectedObserved ??
                    (account.collected != null && (account.collected !== 0 || account.success === true))
                accounts.set(account.email, {
                    ...saved,
                    ...account,
                    success: account.success ?? saved?.success ?? null,
                    collected: observed ? account.collected : (saved?.collected ?? null),
                    error: account.success === true ? (account.error ?? null) : (account.error ?? saved?.error ?? null)
                })
            }
            const exit =
                run.exit && (run.exit.code != null || run.exit.signal != null) ? run.exit : (previous?.exit ?? run.exit)
            const batch: Batch = {
                ...previous,
                ...run,
                startedAt: run.startedAt ?? previous?.startedAt,
                endedAt: run.endedAt ?? previous?.endedAt,
                exit: exit
                    ? {
                          code: exit.code,
                          signal: exit.signal,
                          at: exit.at ?? previous?.exit?.at
                      }
                    : null,
                totals: run.totals ?? run.run?.totals ?? previous?.totals,
                accountsTotal: run.run?.accountsTotal ?? previous?.accountsTotal,
                accounts: [...accounts.values()]
            }
            if (index < 0) merged.push(batch)
            else merged[index] = batch
        }
        return merged.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
    }, [local, snap.history])
    const successful = batches.filter(
        batch => batch.exit?.code === 0 && !batch.accounts?.some(account => account.success === false)
    ).length
    const failed = batches.filter(
        batch =>
            batch.accounts?.some(account => account.success === false) ||
            (batch.exit?.code != null && batch.exit.code !== 0)
    ).length
    return (
        <>
            <div className="page-head">
                <div>
                    <h2>运行历史</h2>
                    <p>每一轮执行都有迹可循，重启后依然保留。</p>
                </div>
                <span className="muted" style={{ fontSize: 11 }}>
                    {loading ? '正在同步…' : `${batches.length} 个批次`}
                </span>
            </div>
            <div className="grid stats" style={{ marginBottom: 22 }}>
                <Stat label="记录批次" value={batches.length} hint="合并运行与本地记录，自动去重" />
                <Stat label="成功完成" value={successful} hint="已确认退出成功的批次" />
                <Stat label="执行异常" value={failed} hint="含任务失败或异常退出" />
            </div>
            <Card title="全部批次">
                {error ? (
                    <div className="banner warn" role="status">
                        本地历史暂未同步：{error}。下表仍保留可用的运行记录。
                    </div>
                ) : null}
                {batches.length === 0 ? (
                    <div className="empty">
                        {loading ? '正在读取运行记录…' : '还没有历史批次'}
                        <p>首次执行完成后，结果会显示在这里。</p>
                    </div>
                ) : (
                    <div className="table-wrap" style={{ border: 'none' }}>
                        <table>
                            <thead>
                                <tr>
                                    <th>开始时间</th>
                                    <th>结束时间</th>
                                    <th className="num">账号</th>
                                    <th className="num">获得积分</th>
                                    <th>结果</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {batches.map((batch, index) => {
                                    const key = batch.runId ?? batch.startedAt ?? String(index)
                                    const failedAccounts =
                                        batch.accounts?.filter(account => account.success === false).length ?? 0
                                    return (
                                        <tr key={key}>
                                            <td className="mono">{fmtTime(batch.startedAt)}</td>
                                            <td className="mono">{fmtTime(batch.endedAt)}</td>
                                            <td className="num">
                                                {batch.accountsTotal ?? batch.accounts?.length ?? '—'}
                                            </td>
                                            <td className="num">{fmtNum(batch.totals?.collected)}</td>
                                            <td>
                                                {failedAccounts ? (
                                                    <span className="pill failed">
                                                        <i />
                                                        {failedAccounts} 个失败
                                                    </span>
                                                ) : batch.exit?.code === 0 ? (
                                                    <span className="pill completed">
                                                        <i />
                                                        成功
                                                    </span>
                                                ) : batch.exit?.signal ? (
                                                    <span className="pill stopped">
                                                        <i />
                                                        已停止
                                                    </span>
                                                ) : batch.exit?.code != null ? (
                                                    <span className="pill failed">
                                                        <i />
                                                        异常退出
                                                    </span>
                                                ) : (
                                                    <span className="pill unknown">
                                                        <i />
                                                        {batch.endedAt ? '结果未知' : '进行中'}
                                                    </span>
                                                )}
                                            </td>
                                            <td>
                                                <button
                                                    className="link"
                                                    onClick={() => setExpanded(expanded === key ? null : key)}
                                                    aria-expanded={expanded === key}
                                                >
                                                    详情 {expanded === key ? '−' : '+'}
                                                </button>
                                                {expanded === key ? (
                                                    <div className="batch-detail">
                                                        <p className="mono">批次 {batch.runId ?? '—'}</p>
                                                        <p>
                                                            退出码 {batch.exit?.code ?? '—'} · 信号{' '}
                                                            {batch.exit?.signal ?? '—'} · 退出时间{' '}
                                                            {fmtTime(batch.exit?.at)}
                                                        </p>
                                                        <p>
                                                            日志 {batch.logEvents ?? '—'} 条 ·{' '}
                                                            {batch.totals
                                                                ? `余额 ${batch.totals.oldTotal} → ${batch.totals.newTotal}`
                                                                : '余额尚未汇总'}
                                                        </p>
                                                        {batch.accounts?.map(account => (
                                                            <p key={account.email}>
                                                                {account.email} ·{' '}
                                                                {account.success === true
                                                                    ? '成功'
                                                                    : account.success === false
                                                                      ? '失败'
                                                                      : '未确认'}{' '}
                                                                · {fmtNum(account.collected)} 分
                                                                {account.error ? ` · ${account.error}` : ''}
                                                            </p>
                                                        ))}
                                                    </div>
                                                ) : null}
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>
        </>
    )
}
