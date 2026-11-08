import { useEffect, useMemo, useState } from 'react'
import { Card, WaitChip, LogLine, StatusPill, AccountStatusPill, fmtDuration, fmtNum, fmtTime } from '../components'
import type { AccountRow, LogEntry } from '../types'
import type { Snapshot } from '../types'

interface DetailResponse {
    account: AccountRow
    logs: LogEntry[]
    history: Array<{
        startedAt: string
        endedAt: string
        accounts?: Array<{ email: string; success: boolean | null; collected: number | null; error: string | null }>
    }>
}

export function AccountDetail({ snap, email, goto }: { snap: Snapshot; email: string; goto: (r: string) => void }) {
    const [detail, setDetail] = useState<DetailResponse | null>(null)
    const [error, setError] = useState<string | null>(null)

    // 首次拉历史；后续合并当前批次的实时日志。
    const live = snap.accounts.find(a => a.email === email) ?? detail?.account ?? null

    useEffect(() => {
        let cancelled = false
        setDetail(null)
        setError(null)
        fetch(`/api/accounts/${encodeURIComponent(email)}`)
            .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
            .then(d => {
                if (!cancelled) setDetail(d)
            })
            .catch(e => {
                if (!cancelled) setError(e.message)
            })
        return () => {
            cancelled = true
        }
    }, [email])

    const logs = useMemo(() => {
        const entries = [
            ...(detail?.account.email === email ? detail.logs : []),
            ...snap.logs.filter(entry => entry.email === email)
        ]
        const unique = new Map(
            entries.map(entry => [
                `${entry.runId ?? snap.run.runId ?? ''}:${entry.id}:${entry.receivedAt ?? ''}`,
                entry
            ])
        )
        return [...unique.values()]
            .sort(
                (a, b) =>
                    String(a.receivedAt ?? a.ts ?? '').localeCompare(String(b.receivedAt ?? b.ts ?? '')) || a.id - b.id
            )
            .slice(-120)
            .reverse()
    }, [detail, email, snap.logs, snap.run.runId])

    if (!live) {
        return (
            <>
                <div className="page-head">
                    <h2>账号详情</h2>
                </div>
                <div className="card empty">{error ? `读取失败：${error}` : '正在读取账号信息…'}</div>
                <button className="btn" onClick={() => goto('/accounts')} style={{ marginTop: 12 }}>
                    返回账号列表
                </button>
            </>
        )
    }

    return (
        <>
            <div className="page-head">
                <div>
                    <h2 style={{ fontFamily: 'var(--font-mono)', fontSize: 17 }}>{live.email}</h2>
                    <p>
                        账号槽位 #{live.index} · {live.geoLocale ?? '地区未知'} / {live.langCode ?? '语言未知'}
                        {live.hasTotp ? ' · 已配置 TOTP' : ''}
                    </p>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <AccountStatusPill account={live} />
                    <button className="btn" onClick={() => goto('/accounts')}>
                        返回列表
                    </button>
                </div>
            </div>

            <div className="detail-grid">
                <Card title="当前执行">
                    <dl className="kv">
                        <dt>状态</dt>
                        <dd>
                            <StatusPill
                                status={live.currentRunStatus ?? live.status}
                                label={
                                    live.includedInCurrentRun === false
                                        ? '未参与本轮'
                                        : live.statusScope === 'today' && live.currentRunStatus === 'not_run'
                                          ? '本轮无执行记录'
                                          : undefined
                                }
                            />
                            {!live.statusKnown ? <span className="muted"> · 上游数据不足，无法确定</span> : null}
                        </dd>
                        <dt>今日结果</dt>
                        <dd>
                            {live.todayStatus === 'completed'
                                ? '今日已完成'
                                : live.todayStatus === 'failed'
                                  ? '今日失败'
                                  : live.todayStatus === 'unknown'
                                    ? '状态待确认'
                                    : '尚无确认结果'}
                        </dd>
                        <dt>归属</dt>
                        <dd>
                            {live.attributionReliable === false ? (
                                <span style={{ color: 'var(--warn)' }}>{live.attributionNote}</span>
                            ) : (
                                <span className="muted">按完整邮箱精确归属</span>
                            )}
                        </dd>
                        <dt>当前步骤</dt>
                        <dd>
                            {live.currentTask ? (
                                <>
                                    <span className="tag">{live.currentTask.title ?? 'LOG'}</span>
                                    <div className="secondary" style={{ marginTop: 4 }}>
                                        {live.currentTask.message}
                                    </div>
                                    <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                                        更新于 {fmtTime(live.currentTask.at)}
                                        {live.currentTask.platform ? ` · ${live.currentTask.platform}` : ''}
                                    </div>
                                    {live.wait ? (
                                        <div style={{ marginTop: 8 }}>
                                            <WaitChip wait={live.wait} />
                                        </div>
                                    ) : null}
                                </>
                            ) : (
                                <span className="muted">—</span>
                            )}
                        </dd>
                        <dt>工作进程</dt>
                        <dd className="mono">{live.workerPid ?? '未知（并行运行时无法可靠归属）'}</dd>
                        <dt>开始时间</dt>
                        <dd>{fmtTime(live.startedAt)}</dd>
                        <dt>已运行</dt>
                        <dd>
                            {fmtDuration(live.durationSec)}
                            {live.durationSource === 'computed' ? (
                                <span className="muted"> · 本地计算</span>
                            ) : live.durationSource === 'api' ? (
                                <span className="muted"> · 上游上报</span>
                            ) : null}
                        </dd>
                    </dl>
                </Card>

                <Card title="任务执行情况（本轮）">
                    {(() => {
                        const acts = live.activities ?? {}
                        const keys = Object.keys(acts)
                        if (keys.length === 0) {
                            return <div className="empty">本轮暂无任务事件</div>
                        }
                        const label: Record<string, string> = {
                            'DAILY-CHECK-IN': '签到',
                            'DAILY-SET': '每日集',
                            'MORE-PROMOTIONS': '更多推广',
                            'APP-PROMOTIONS': '应用推广',
                            'READ-TO-EARN': '读文赚分',
                            PUNCHCARD: '打卡',
                            'URL-REWARD': '链接奖励',
                            'SEARCH-BING': '必应搜索',
                            'VISUAL-SEARCH': '视觉搜索',
                            'ACTIVATE-SEARCH-PERK': '搜索加成',
                            'ENABLE-STREAK-PROTECTION': '连击保护',
                            'CLAIM-BONUS-POINTS': '领取奖励分'
                        }
                        return (
                            <div className="table-wrap" style={{ border: 'none' }}>
                                <table>
                                    <thead>
                                        <tr>
                                            <th>任务</th>
                                            <th>平台</th>
                                            <th className="num">次数</th>
                                            <th>最近</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {keys.map(k => (
                                            <tr key={k}>
                                                <td>{label[k] ?? k}</td>
                                                <td className="muted">
                                                    {acts[k].platform === 'MOBILE'
                                                        ? '移动端'
                                                        : acts[k].platform === 'DESKTOP'
                                                          ? '桌面端'
                                                          : '主流程'}
                                                </td>
                                                <td className="num">{acts[k].count}</td>
                                                <td className="mono muted" style={{ fontSize: 11 }}>
                                                    {acts[k].lastAt ? fmtTime(acts[k].lastAt) : '—'}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )
                    })()}
                    <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                        按本轮日志记录活动次数与最近执行时间，次数不代表积分到账。
                    </div>
                </Card>

                <Card title="积分">
                    <dl className="kv">
                        <dt>本轮获得</dt>
                        <dd>{fmtNum(live.collectedThisRun)}</dd>
                        <dt>当前余额</dt>
                        <dd>{fmtNum(live.balance)}</dd>
                        <dt>本轮起始</dt>
                        <dd>{fmtNum(live.initialPoints)}</dd>
                        <dt>可获取额度</dt>
                        <dd>
                            {live.earnable
                                ? `移动 ${fmtNum(live.earnable.mobile)} · 桌面 ${fmtNum(live.earnable.browser)} · 应用 ${fmtNum(live.earnable.app)}`
                                : '—'}
                        </dd>
                        <dt>搜索统计</dt>
                        <dd>
                            {live.searchSummary
                                ? `移动 ${live.searchSummary.mobile} · 桌面 ${live.searchSummary.desktop} · 奖励 ${live.searchSummary.bonus} · 合计 ${live.searchSummary.total}`
                                : '—'}
                        </dd>
                        <dt>上次结果</dt>
                        <dd>
                            {live.lastSuccess === true ? '成功' : live.lastSuccess === false ? '失败' : '—'}
                            {live.lastRunAt ? <span className="muted"> · {fmtTime(live.lastRunAt)}</span> : null}
                        </dd>
                        <dt>今日最近完成</dt>
                        <dd>
                            {live.todayResult
                                ? `${fmtTime(live.todayResult.at)} · ${fmtNum(live.todayResult.collected)} 分`
                                : '—'}
                        </dd>
                    </dl>
                </Card>

                <Card title="最近错误">
                    {live.error || live.lastError ? (
                        <div className="err-text" style={{ lineHeight: 1.6 }}>
                            {live.error ?? live.lastError}
                        </div>
                    ) : (
                        <div className="muted">该账号当前没有错误记录</div>
                    )}
                </Card>

                <Card title="登录会话">
                    <dl className="kv">
                        <dt>会话目录</dt>
                        <dd className="secondary">由运行配置指定</dd>
                        <dt>说明</dt>
                        <dd className="secondary">
                            会话由上游 SessionStore 按账号+平台保存在 SQLite，监控端只读，不解析其中的 Cookie
                            内容。实际目录遵循 config.sessionPath。
                        </dd>
                    </dl>
                </Card>
            </div>

            <div style={{ marginTop: 14 }}>
                <Card title={`该账号日志（最近 ${logs.length} 条）`}>
                    {logs.length === 0 ? (
                        <div className="empty">暂无该账号的日志</div>
                    ) : (
                        <div className="logs" style={{ maxHeight: 380 }}>
                            {logs.map(e => (
                                <LogLine key={`${e.id}-${e.receivedAt ?? ''}`} e={e} />
                            ))}
                        </div>
                    )}
                </Card>
            </div>
        </>
    )
}
