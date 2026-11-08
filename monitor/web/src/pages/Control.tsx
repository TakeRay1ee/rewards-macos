import { useEffect, useRef, useState } from 'react'
import { Card, Stat, fmtDuration, fmtNum, fmtTime, shortEmail } from '../components'
import type { Snapshot } from '../types'
import { System } from './System'

interface AuditRow {
    at: string
    action: string
    result: string
    detail?: string
}

interface SessionRow {
    email: string
    platforms: Record<
        string,
        { bytes: number | null; updatedAt: string | null; hasStorageState?: boolean; cookieCount?: number | null }
    >
}

interface ConfigSummary {
    modifiedAt: string
    clusters: number | null
    concurrency?: number | null
    daily?: { hour: number; minute: number; timeZone: string }
    accountDelay: { min: string; max: string } | null
    headless: boolean | null
    queryEngines: string[] | null
    workers: Record<string, boolean> | null
}

const TOKEN_KEY = 'rewards-control-token'
const COOLDOWN_MS = 4000

const ACTION_LABEL: Record<string, string> = {
    'run-now': '全部账号跑一轮',
    'run-selected': '只跑选中账号',
    'stop-run': '停止当前批次',
    'force-stop-run': '强制停止',
    'restart-services': '重启服务'
}

export function Control({
    snap,
    view = 'control',
    onViewChange
}: {
    snap: Snapshot
    view?: 'control' | 'system'
    onViewChange?: (view: 'control' | 'system') => void
}) {
    const [token, setToken] = useState(() => window.localStorage.getItem(TOKEN_KEY) ?? '')
    const [saved, setSaved] = useState(() => Boolean(window.localStorage.getItem(TOKEN_KEY)))
    const [busy, setBusy] = useState<string | null>(null)
    const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
    const [audit, setAudit] = useState<AuditRow[]>([])
    const [sessions, setSessions] = useState<{ available: boolean; reason: string | null; rows: SessionRow[] } | null>(
        null
    )
    const [config, setConfig] = useState<ConfigSummary | null>(null)
    const [picked, setPicked] = useState<number[]>([])
    const [acks, setAcks] = useState<Record<string, boolean>>({})
    const [cooldown, setCooldown] = useState(0)
    const timerRef = useRef<number | undefined>(undefined)

    const running = snap.run.state !== 'idle'

    const startCooldown = (ms: number) => {
        window.clearInterval(timerRef.current)
        setCooldown(Math.max(1, Math.ceil(ms / 1000)))
        timerRef.current = window.setInterval(() => {
            setCooldown(prev => {
                if (prev <= 1) {
                    window.clearInterval(timerRef.current)
                    return 0
                }
                return prev - 1
            })
        }, 1000)
    }

    const loadInfo = () => {
        fetch('/api/control/info')
            .then(r => (r.ok ? r.json() : null))
            .then(d => {
                if (!d) return
                setAudit(d.audit ?? [])
            })
            .catch(() => {})
    }

    const loadContext = () => {
        fetch('/api/sessions/state')
            .then(r => (r.ok ? r.json() : null))
            .then(d => d && setSessions(d))
            .catch(() => {})
        fetch('/api/config/summary')
            .then(r => (r.ok ? r.json() : null))
            .then(d => d && setConfig(d))
            .catch(() => {})
    }

    useEffect(() => {
        loadInfo()
        loadContext()
        const id = window.setInterval(loadContext, 12000)
        return () => {
            window.clearInterval(id)
            window.clearInterval(timerRef.current)
        }
    }, [])

    const revealToken = async () => {
        try {
            const res = await fetch('/api/control/token')
            const body = await res.json().catch(() => ({}))
            if (!res.ok || !body.token) {
                setResult({ ok: false, text: body.error ?? `读取失败（HTTP ${res.status}）` })
                return
            }
            window.localStorage.setItem(TOKEN_KEY, body.token)
            setToken(body.token)
            setSaved(true)
            setResult({ ok: true, text: '已从本机读取并保存密钥。' })
        } catch (error) {
            setResult({ ok: false, text: `读取失败：${(error as Error).message}` })
        }
    }

    const fire = async (
        action: string,
        opts: { confirmText: string; params?: Record<string, unknown>; ackKey?: string; ackText?: string }
    ) => {
        if (!saved) {
            setResult({ ok: false, text: '请先读取或填写控制密钥。' })
            return
        }
        if (opts.ackKey && !acks[opts.ackKey]) {
            setResult({ ok: false, text: `请先勾选「${opts.ackText ?? '我已知晓风险'}」` })
            return
        }
        if (!window.confirm(opts.confirmText)) return

        setBusy(action)
        setResult(null)
        try {
            const res = await fetch('/api/control/action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Control-Token': token },
                body: JSON.stringify({ action, confirmed: true, params: opts.params ?? {} })
            })
            const body = await res.json().catch(() => ({}))
            if (res.ok && body.ok) {
                setResult({ ok: !body.noop, text: body.detail ?? '已接受' })
                if (opts.ackKey) setAcks(prev => ({ ...prev, [opts.ackKey as string]: false }))
                startCooldown(COOLDOWN_MS)
            } else {
                setResult({ ok: false, text: body.detail ?? body.error ?? `请求失败（HTTP ${res.status}）` })
            }
            window.setTimeout(loadInfo, 1200)
        } catch (error) {
            setResult({
                ok: false,
                text: `请求未完成：${(error as Error).message}。若刚点重启，这是预期现象，页面会自动恢复。`
            })
        } finally {
            window.setTimeout(() => setBusy(null), 800)
        }
    }

    const togglePick = (index: number) => {
        setPicked(prev =>
            prev.includes(index) ? prev.filter(i => i !== index) : [...prev, index].sort((a, b) => a - b)
        )
    }

    const sessionFor = (email: string) => sessions?.rows.find(r => r.email === email)
    const cooling = cooldown > 0

    return (
        <>
            <div className="page-head">
                <div>
                    <h2>运行管理</h2>
                    <p>管理运行、查看资源，所有操作都有记录可查。</p>
                </div>
            </div>

            <div className="section-tabs" role="tablist" aria-label="运行管理视图">
                <button
                    role="tab"
                    aria-selected={view === 'control'}
                    className={view === 'control' ? 'active' : ''}
                    onClick={() => onViewChange?.('control')}
                >
                    运行控制
                </button>
                <button
                    role="tab"
                    aria-selected={view === 'system'}
                    className={view === 'system' ? 'active' : ''}
                    onClick={() => onViewChange?.('system')}
                >
                    系统资源
                </button>
            </div>
            {view === 'system' ? (
                <System snap={snap} embedded />
            ) : (
                <>
                    <div className="grid stats" style={{ marginBottom: 14 }}>
                        <Stat
                            label="批次状态"
                            value={running ? '运行中' : '空闲'}
                            small
                            hint={snap.run.runId ?? '当前没有批次'}
                        />
                        <Stat
                            label="并行账户"
                            value={`${snap.overview.running} / ${snap.overview.accountsTotal}`}
                            hint={`clusters ${snap.run.clusters ?? '—'} · 浏览器 ${snap.overview.browserInstances ?? '未知'}`}
                        />
                        <Stat label="本轮积分" value={fmtNum(snap.overview.collectedThisRun)} hint="本轮已确认收益" />
                        <Stat
                            label="Control API"
                            value={snap.controlApi.online ? '在线' : '不可达'}
                            small
                            hint={
                                snap.controlApi.online
                                    ? running
                                        ? `已跑 ${fmtDuration(
                                              snap.run.startedAt
                                                  ? (Date.now() - Date.parse(snap.run.startedAt)) / 1000
                                                  : null
                                          )}`
                                        : '空闲待命'
                                    : (snap.controlApi.error ?? '无法连接 3010')
                            }
                        />
                    </div>

                    <div className="grid" style={{ gridTemplateColumns: 'minmax(0,320px) minmax(0,1fr)' }}>
                        <div className="grid" style={{ gap: 12, alignContent: 'start' }}>
                            <Card title="控制密钥">
                                {saved ? (
                                    <>
                                        <div
                                            className="banner"
                                            style={{
                                                background: 'var(--ok-soft)',
                                                borderColor: 'color-mix(in srgb, var(--ok) 30%, transparent)',
                                                color: 'var(--ok)',
                                                marginBottom: 10
                                            }}
                                        >
                                            <span>✓</span>
                                            <span>已保存在本浏览器</span>
                                        </div>
                                        <div
                                            className="muted"
                                            style={{ fontSize: 11, marginBottom: 10, wordBreak: 'break-all' }}
                                        >
                                            {token.slice(0, 6)}…{token.slice(-4)}
                                        </div>
                                        <div style={{ display: 'flex', gap: 8 }}>
                                            <button
                                                className="btn"
                                                onClick={() => {
                                                    window.localStorage.removeItem(TOKEN_KEY)
                                                    setToken('')
                                                    setSaved(false)
                                                }}
                                            >
                                                清除
                                            </button>
                                            <button className="btn" onClick={() => void revealToken()}>
                                                重新读取
                                            </button>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <button
                                            className="btn active"
                                            onClick={() => void revealToken()}
                                            style={{ marginBottom: 10 }}
                                        >
                                            一键读取本机密钥
                                        </button>
                                        <input
                                            className="input"
                                            type="password"
                                            placeholder="或手动粘贴密钥"
                                            aria-label="控制密钥"
                                            value={token}
                                            onChange={e => setToken(e.target.value)}
                                            style={{ width: '100%', marginBottom: 8 }}
                                        />
                                        <button
                                            className="btn"
                                            onClick={() => {
                                                window.localStorage.setItem(TOKEN_KEY, token.trim())
                                                setToken(token.trim())
                                                setSaved(true)
                                            }}
                                        >
                                            保存
                                        </button>
                                    </>
                                )}
                            </Card>

                            <Card title="登录会话">
                                {!sessions ? (
                                    <div className="muted">读取中…</div>
                                ) : !sessions.available ? (
                                    <div className="muted" style={{ fontSize: 12 }}>
                                        {sessions.reason}
                                    </div>
                                ) : (
                                    <div style={{ display: 'grid', gap: 10 }}>
                                        {snap.accounts.map(a => {
                                            const platforms = sessionFor(a.email)?.platforms ?? {}
                                            return (
                                                <div key={a.email}>
                                                    <div className="email-cell" style={{ marginBottom: 4 }}>
                                                        {a.email}
                                                    </div>
                                                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                                        {['mobile', 'desktop'].map(p => {
                                                            const hit = platforms[p]
                                                            return (
                                                                <span
                                                                    key={p}
                                                                    className={`pill ${hit ? 'completed' : 'not_run'}`}
                                                                    title={
                                                                        hit
                                                                            ? `${hit.cookieCount == null ? (hit.hasStorageState ? '有会话' : '无会话') : `${hit.cookieCount} 个 Cookie`} · 更新于 ${fmtTime(hit.updatedAt)}`
                                                                            : '缺少该平台会话，跑到该阶段需要人工登录'
                                                                    }
                                                                >
                                                                    <i />
                                                                    {p === 'mobile' ? '手机' : '桌面'}
                                                                    {hit ? '' : '缺失'}
                                                                </span>
                                                            )
                                                        })}
                                                    </div>
                                                </div>
                                            )
                                        })}
                                        <div className="muted" style={{ fontSize: 10.5, lineHeight: 1.6 }}>
                                            缺任一平台会话，跑到该阶段会要求邮箱验证码而失败。
                                        </div>
                                    </div>
                                )}
                            </Card>
                        </div>

                        <div className="grid" style={{ gap: 12, alignContent: 'start' }}>
                            <Card title="运行控制">
                                <div className="secondary" style={{ fontSize: 12.5, marginBottom: 10 }}>
                                    选择要跑的账号（不选＝全部）。按配置错峰拉起，最多{' '}
                                    {config?.concurrency ?? config?.clusters ?? '—'} 个账号并行执行。
                                </div>
                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                                    {snap.accounts.map(a => (
                                        <button
                                            key={a.email}
                                            className={`btn${picked.includes(a.index) ? ' active' : ''}`}
                                            onClick={() => togglePick(a.index)}
                                            title={a.email}
                                        >
                                            #{a.index} {shortEmail(a.email)}
                                        </button>
                                    ))}
                                    {picked.length > 0 ? (
                                        <button className="btn" onClick={() => setPicked([])}>
                                            清空选择
                                        </button>
                                    ) : null}
                                </div>
                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                    <button
                                        className="btn active"
                                        disabled={busy === 'run-now' || cooling || running}
                                        onClick={() => fire('run-now', { confirmText: '确认让全部账号跑一轮？' })}
                                    >
                                        {busy === 'run-now' ? '执行中…' : cooling ? `${cooldown}s` : '全部账号跑一轮'}
                                    </button>
                                    <button
                                        className="btn active"
                                        disabled={busy === 'run-selected' || cooling || running || picked.length === 0}
                                        onClick={() =>
                                            fire('run-selected', {
                                                confirmText: `确认只跑账号 ${picked.join(', ')}？`,
                                                params: { accounts: picked }
                                            })
                                        }
                                    >
                                        {busy === 'run-selected'
                                            ? '执行中…'
                                            : `只跑选中${picked.length ? `（${picked.length}）` : ''}`}
                                    </button>
                                    <button
                                        className="btn"
                                        disabled={busy === 'stop-run' || cooling || !running}
                                        onClick={() =>
                                            fire('stop-run', {
                                                confirmText: '确认停止当前批次？已完成的账号结果会保留。'
                                            })
                                        }
                                    >
                                        {busy === 'stop-run' ? '执行中…' : '停止当前批次'}
                                    </button>
                                </div>
                                {running ? (
                                    <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
                                        批次运行中，启动类按钮已禁用；需要中断请用「停止当前批次」。
                                    </div>
                                ) : null}
                            </Card>

                            <Card title="危险操作">
                                <div
                                    className="secondary"
                                    style={{ fontSize: 12.5, marginBottom: 10, lineHeight: 1.65 }}
                                >
                                    强制停止会立即结束当前批次；重启服务也会中断运行。未完成的任务可能需要重新执行。
                                </div>
                                <label
                                    style={{
                                        display: 'flex',
                                        gap: 8,
                                        alignItems: 'center',
                                        fontSize: 12,
                                        marginBottom: 10,
                                        color: 'var(--danger)'
                                    }}
                                >
                                    <input
                                        type="checkbox"
                                        checked={Boolean(acks.danger)}
                                        onChange={e => setAcks(prev => ({ ...prev, danger: e.target.checked }))}
                                    />
                                    我已知晓会打断正在运行的批次
                                </label>
                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                    <button
                                        className="btn"
                                        disabled={busy === 'force-stop-run' || cooling || !running || !acks.danger}
                                        onClick={() =>
                                            fire('force-stop-run', {
                                                confirmText: '确认强制结束当前批次？这不会保存未完成的结果。',
                                                ackKey: 'danger',
                                                ackText: '我已知晓会打断正在运行的批次'
                                            })
                                        }
                                        style={{
                                            borderColor: 'color-mix(in srgb, var(--danger) 40%, transparent)',
                                            color: 'var(--danger)'
                                        }}
                                    >
                                        {busy === 'force-stop-run' ? '执行中…' : '强制停止'}
                                    </button>
                                    <button
                                        className="btn"
                                        disabled={busy === 'restart-services' || cooling || !acks.danger}
                                        onClick={() =>
                                            fire('restart-services', {
                                                confirmText: '确认重启 Control API 与监控服务？正在跑的批次会被打断。',
                                                ackKey: 'danger',
                                                ackText: '我已知晓会打断正在运行的批次'
                                            })
                                        }
                                        style={{
                                            borderColor: 'color-mix(in srgb, var(--danger) 40%, transparent)',
                                            color: 'var(--danger)'
                                        }}
                                    >
                                        {busy === 'restart-services' ? '执行中…' : '重启服务'}
                                    </button>
                                </div>
                            </Card>

                            {result ? (
                                <div
                                    className="banner"
                                    style={{
                                        background: result.ok ? 'var(--ok-soft)' : 'var(--danger-soft)',
                                        borderColor: result.ok
                                            ? 'color-mix(in srgb, var(--ok) 30%, transparent)'
                                            : 'color-mix(in srgb, var(--danger) 30%, transparent)',
                                        color: result.ok ? 'var(--ok)' : 'var(--danger)'
                                    }}
                                >
                                    <span>{result.ok ? '✓' : '✕'}</span>
                                    <span>{result.text}</span>
                                </div>
                            ) : null}

                            <Card title="本轮运行配置">
                                {!config ? (
                                    <div className="muted">读取中…</div>
                                ) : (
                                    <dl className="kv">
                                        <dt>并行上限</dt>
                                        <dd>
                                            {config.concurrency ?? config.clusters ?? '—'}
                                            <span className="muted"> · 错峰启动后并行</span>
                                        </dd>
                                        <dt>每日计划</dt>
                                        <dd>
                                            {config.daily
                                                ? `${String(config.daily.hour).padStart(2, '0')}:${String(config.daily.minute).padStart(2, '0')} · ${config.daily.timeZone}`
                                                : '—'}
                                        </dd>
                                        <dt>启动错峰</dt>
                                        <dd>
                                            {config.accountDelay
                                                ? `${config.accountDelay.min} – ${config.accountDelay.max}`
                                                : '—'}
                                        </dd>
                                        <dt>无头模式</dt>
                                        <dd>{config.headless == null ? '—' : config.headless ? '是' : '否'}</dd>
                                        <dt>搜索源</dt>
                                        <dd>{config.queryEngines?.join(' / ') ?? '—'}</dd>
                                        <dt>任务开关</dt>
                                        <dd className="secondary" style={{ fontSize: 11.5 }}>
                                            {config.workers
                                                ? Object.entries(config.workers)
                                                      .map(([k, v]) => `${k.replace(/^do/, '')}:${v ? '开' : '关'}`)
                                                      .join(' · ')
                                                : '—'}
                                        </dd>
                                        <dt>文件更新</dt>
                                        <dd className="mono">{fmtTime(config.modifiedAt)}</dd>
                                    </dl>
                                )}
                            </Card>
                        </div>
                    </div>

                    <div style={{ marginTop: 14 }}>
                        <Card title="最近操作审计">
                            {audit.length === 0 ? (
                                <div className="empty">还没有执行过控制动作</div>
                            ) : (
                                <div className="table-wrap" style={{ border: 'none' }}>
                                    <table>
                                        <thead>
                                            <tr>
                                                <th>时间</th>
                                                <th>动作</th>
                                                <th>结果</th>
                                                <th>说明</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {audit.map((r, i) => (
                                                <tr key={`${r.at}-${i}`}>
                                                    <td className="mono">{fmtTime(r.at)}</td>
                                                    <td>{ACTION_LABEL[r.action] ?? r.action}</td>
                                                    <td>
                                                        {r.result === 'accepted' ? (
                                                            <span style={{ color: 'var(--ok)' }}>已执行</span>
                                                        ) : r.result === 'noop' ? (
                                                            <span className="muted">无操作</span>
                                                        ) : (
                                                            <span style={{ color: 'var(--danger)' }}>失败</span>
                                                        )}
                                                    </td>
                                                    <td className="secondary">{r.detail ?? '—'}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </Card>
                    </div>
                </>
            )}
        </>
    )
}
