import { Card, WaitChip, Stat, AccountStatusPill, Icon, fmtNum, fmtTime } from '../components'
import type { Snapshot } from '../types'

export function Overview({ snap, goto }: { snap: Snapshot; goto: (route: string) => void }) {
    const overview = snap.overview
    const run = snap.run
    const running = run.state !== 'idle'
    const attentionAccounts = snap.accounts.filter(
        account => account.status === 'failed' || account.status === 'unknown' || account.error
    )
    const todayValues = Object.values(snap.ledger?.todayTotals ?? {}).filter(
        (value): value is number => typeof value === 'number' && Number.isFinite(value)
    )
    const today = todayValues.length ? todayValues.reduce((sum, value) => sum + value, 0) : null
    return (
        <>
            <div className="page-head">
                <div>
                    <div className="page-eyebrow">Your local workspace</div>
                    <h2>总览仪表盘</h2>
                    <p>所有账号的运行进度与积分，一处掌握。</p>
                </div>
                <button className="btn" onClick={() => goto('/control')}>
                    <Icon name="settings" />
                    运行管理
                </button>
            </div>
            <div className="overview-status">
                <Icon name={running ? 'chart' : 'overview'} />
                <span>
                    {running
                        ? `${overview.running} 个账号正在执行，进度将自动更新。`
                        : '当前没有运行中的批次，工作台已就绪。'}
                </span>
                <span className={`pill ${running ? 'running' : 'completed'}`}>
                    <i />
                    {running ? '正在运行' : '空闲待命'}
                </span>
            </div>
            <div className="grid stats">
                <Stat
                    label="账号总数"
                    value={overview.accountsTotal}
                    hint={`${overview.running} 运行 · ${overview.waiting} 等待`}
                />
                <Stat label="今日获得" value={fmtNum(today)} hint="各账号今日已观测收益" />
                <Stat
                    label="今日完成"
                    value={`${overview.todayCompleted ?? snap.accounts.filter(account => account.todayStatus === 'completed').length} / ${overview.accountsTotal}`}
                    hint={`本轮完成 ${overview.completed} / ${run.accountsTotal ?? overview.accountsTotal}${running ? ' · 进行中' : ''}`}
                />
                <Stat label="需要关注" value={attentionAccounts.length} hint="失败、异常或状态待确认的账号" />
            </div>
            <div className="grid overview-grid">
                <Card
                    title="账号概况"
                    right={
                        <button className="link" onClick={() => goto('/accounts')}>
                            查看全部账号 →
                        </button>
                    }
                >
                    {snap.accounts.length === 0 ? (
                        <div className="empty">
                            还没有配置账号<p>添加账号后，运行状态会显示在这里。</p>
                        </div>
                    ) : (
                        <div className="table-wrap" style={{ border: 'none' }}>
                            <table>
                                <thead>
                                    <tr>
                                        <th>账号</th>
                                        <th>状态</th>
                                        <th className="num">本轮</th>
                                        <th className="num">今日</th>
                                        <th className="num">余额</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {snap.accounts.slice(0, 8).map(account => (
                                        <tr key={account.email}>
                                            <td className="email-cell">
                                                <button
                                                    className="link"
                                                    onClick={() =>
                                                        goto(`/accounts/${encodeURIComponent(account.email)}`)
                                                    }
                                                >
                                                    {account.email}
                                                </button>
                                            </td>
                                            <td>
                                                <AccountStatusPill account={account} />
                                                {account.wait ? (
                                                    <div style={{ marginTop: 6 }}>
                                                        <WaitChip wait={account.wait} compact />
                                                    </div>
                                                ) : null}
                                            </td>
                                            <td className="num">{fmtNum(account.collectedThisRun)}</td>
                                            <td className="num">{fmtNum(snap.ledger?.todayTotals?.[account.email])}</td>
                                            <td className="num">
                                                {fmtNum(snap.ledger?.balances?.[account.email]?.value)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </Card>
                <Card
                    title="最近运行"
                    right={
                        <button className="link" onClick={() => goto('/history')}>
                            历史 →
                        </button>
                    }
                >
                    <div className="summary-list">
                        <div>
                            <span>开始时间</span>
                            <strong>{fmtTime(run.startedAt)}</strong>
                        </div>
                        <div>
                            <span>结束时间</span>
                            <strong>{run.endedAt ? fmtTime(run.endedAt) : running ? '进行中' : '—'}</strong>
                        </div>
                        <div>
                            <span>本轮获得</span>
                            <strong>{fmtNum(overview.collectedThisRun)} 分</strong>
                        </div>
                        <div>
                            <span>完成账号</span>
                            <strong>{overview.completed} 个</strong>
                        </div>
                        <div>
                            <span>执行失败</span>
                            <strong style={{ color: overview.failed ? 'var(--danger)' : undefined }}>
                                {overview.failed} 个
                            </strong>
                        </div>
                    </div>
                    <details className="disclosure">
                        <summary>查看运行详情</summary>
                        <dl className="kv">
                            <dt>批次 ID</dt>
                            <dd className="mono">{run.runId ?? '—'}</dd>
                            <dt>并行配置</dt>
                            <dd>{run.clusters ?? '—'}</dd>
                            <dt>退出信息</dt>
                            <dd>{run.exit?.code != null ? `退出码 ${run.exit.code}` : (run.exit?.signal ?? '—')}</dd>
                            <dt>日志事件</dt>
                            <dd>{run.logEventCount ?? 0} 条</dd>
                        </dl>
                    </details>
                </Card>
            </div>
            <div className="grid overview-grid">
                <Card
                    title="最近动态"
                    right={
                        <button className="link" onClick={() => goto('/logs')}>
                            查看日志 →
                        </button>
                    }
                >
                    {snap.logs.length ? (
                        <div className="activity-list">
                            {snap.logs
                                .slice(-4)
                                .reverse()
                                .map(entry => (
                                    <div className="activity-row" key={`${entry.runId}-${entry.id}`}>
                                        <span className={`activity-dot ${entry.level}`} />
                                        <div>
                                            <p>{entry.message}</p>
                                            <span>
                                                {entry.email ?? '运行服务'} · {fmtTime(entry.receivedAt ?? entry.ts)}
                                            </span>
                                        </div>
                                    </div>
                                ))}
                        </div>
                    ) : (
                        <div className="empty">暂时没有运行动态</div>
                    )}
                </Card>
                <Card title="需要关注" right={<span className="tag">{attentionAccounts.length}</span>}>
                    {attentionAccounts.length ? (
                        <div className="summary-list">
                            {attentionAccounts.slice(0, 4).map(account => (
                                <div key={account.email} style={{ display: 'block' }}>
                                    <button
                                        className="link"
                                        onClick={() => goto(`/accounts/${encodeURIComponent(account.email)}`)}
                                    >
                                        {account.email}
                                    </button>
                                    <p
                                        className={
                                            account.status === 'unknown' && !account.error ? 'muted' : 'err-text'
                                        }
                                        style={{ margin: '5px 0 0' }}
                                    >
                                        {account.error ||
                                            (account.status === 'unknown'
                                                ? '状态待确认，请查看账号详情。'
                                                : '执行失败，请查看账号详情。')}
                                    </p>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="all-clear">
                            <span className="all-clear-mark">✓</span>
                            <strong>没有待处理的异常</strong>
                            <p>账号失败、出现异常或状态待确认时会显示在这里。</p>
                        </div>
                    )}
                </Card>
            </div>
        </>
    )
}
