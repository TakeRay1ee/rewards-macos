import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { AccountRow, AccountStatus, LogEntry } from './types'
import { STATUS_LABEL } from './types'

/** 短标签：保留前缀 + 域名首段，用于区分同前缀不同域名的账号（如 a@gmail / a@outlook） */
export function shortEmail(email: string | null | undefined): string {
    if (!email) return '—'
    const at = email.indexOf('@')
    if (at < 0) return email
    const local = email.slice(0, at)
    const domain = email.slice(at + 1)
    const head = domain.split('.')[0]
    return head ? `${local}@${head}` : local
}

export function fmtTime(iso: string | null | undefined): string {
    if (!iso) return '—'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    return d.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
}

export function fmtClock(iso: string | null | undefined): string {
    if (!iso) return '—'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    return d.toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
}

export function fmtDuration(sec: number | null | undefined): string {
    if (sec == null || !Number.isFinite(sec)) return '—'
    const s = Math.max(0, Math.round(sec))
    if (s < 60) return `${s} 秒`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m} 分 ${s % 60} 秒`
    return `${Math.floor(m / 60)} 时 ${m % 60} 分`
}

export function fmtNum(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return '—'
    return String(v)
}

export function fmtMb(bytes: number | null | undefined): string {
    if (bytes == null) return '—'
    return `${(bytes / 1048576).toFixed(0)} MB`
}

export function fmtGb(bytes: number | null | undefined): string {
    if (bytes == null) return '—'
    return `${(bytes / 1073741824).toFixed(1)} GB`
}

export function StatusPill({ status, title, label }: { status: AccountStatus; title?: string; label?: string }) {
    return (
        <span className={`pill ${status}`} title={title}>
            <i />
            {label ?? STATUS_LABEL[status]}
        </span>
    )
}

export function AccountStatusPill({ account }: { account: AccountRow }) {
    const dailyCompleted = account.todayStatus === 'completed' && account.status === 'completed'
    const dailyCompletedWithUnknownRun =
        account.todayStatus === 'completed' &&
        account.currentRunStatus === 'unknown' &&
        account.includedInCurrentRun == null
    const label = dailyCompletedWithUnknownRun
        ? '今日已完成 · 本轮待确认'
        : dailyCompleted
          ? '今日已完成'
          : account.statusScope === 'today'
            ? account.status === 'completed'
                ? '今日已完成'
                : account.status === 'failed'
                  ? '今日失败'
                  : '今日状态待确认'
            : undefined
    const title = dailyCompletedWithUnknownRun
        ? '今天已有确认完成记录，当前批次参与情况仍无法确定'
        : dailyCompleted && account.currentRunStatus === 'completed'
          ? `今日结果确认于 ${fmtTime(account.todayResult?.at ?? account.statusAt)}；本轮已完成`
          : account.statusScope === 'today'
            ? `今日结果确认于 ${fmtTime(account.statusAt)}；${account.includedInCurrentRun === false ? '未参与最近批次' : '本轮暂无该账号执行记录'}`
            : account.statusKnown
              ? '最近批次状态'
              : '观测不足，无法确定'
    return <StatusPill status={account.status} title={title} label={label} />
}

export function Stat({
    label,
    value,
    hint,
    small
}: {
    label: string
    value: ReactNode
    hint?: ReactNode
    small?: boolean
}) {
    return (
        <div className="stat">
            <div className="label">{label}</div>
            <div className={`value${small ? ' small' : ''}`}>{value}</div>
            {hint ? <div className="hint">{hint}</div> : null}
        </div>
    )
}

export function Card({
    title,
    children,
    right,
    className
}: {
    title?: string
    children: ReactNode
    right?: ReactNode
    className?: string
}) {
    return (
        <section className={`card card-pad ${className ?? ''}`}>
            {title ? (
                <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <h3 className="card-title">{title}</h3>
                    {right}
                </header>
            ) : null}
            {children}
        </section>
    )
}

export function Icon({ name }: { name: string }) {
    const paths: Record<string, ReactNode> = {
        overview: (
            <>
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </>
        ),
        accounts: (
            <>
                <circle cx="9" cy="8" r="3" />
                <path d="M3 20v-2a6 6 0 0 1 12 0v2M17 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5" />
            </>
        ),
        chart: (
            <>
                <path d="M4 3v17h17M8 15v-4M13 15V7M18 15V4" />
            </>
        ),
        logs: (
            <>
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="m7 9 3 3-3 3M13 15h4" />
            </>
        ),
        history: (
            <>
                <path d="M3 11a9 9 0 1 1 3 8M3 4v7h7M12 7v5l3 2" />
            </>
        ),
        settings: (
            <>
                <path d="M4 7h16M4 17h16" />
                <circle cx="9" cy="7" r="3" />
                <circle cx="16" cy="17" r="3" />
            </>
        ),
        chevron: <path d="m9 5 7 7-7 7" />,
        moon: <path d="M20.4 13.5A8.7 8.7 0 0 1 10.5 3.6 8.7 8.7 0 1 0 20.4 13.5Z" />,
        sun: (
            <>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" />
            </>
        )
    }
    return (
        <svg
            className="icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.65"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            {paths[name] ?? paths.overview}
        </svg>
    )
}

export function Banner({ kind, children }: { kind: 'danger' | 'warn'; children: ReactNode }) {
    return (
        <div className={`banner ${kind}`} role="status">
            {children}
        </div>
    )
}

export function ConnBadge({ state }: { state: 'connecting' | 'live' | 'stale' | 'offline' }) {
    const text =
        state === 'live'
            ? '实时同步'
            : state === 'stale'
              ? '数据延迟'
              : state === 'offline'
                ? '连接断开，重试中'
                : '正在连接'
    return (
        <span className={`conn ${state}`} role="status">
            <i />
            {text}
        </span>
    )
}

/** 日志行：时间/级别/账号/内容，账号列用真实邮箱局部名，不做顺序推断 */
export function LogLine({ e }: { e: LogEntry }) {
    const time = e.ts ? e.ts.slice(11, 19) : e.receivedAt ? fmtClock(e.receivedAt) : '—'
    const who = e.email ? shortEmail(e.email) : (e.user ?? '')
    return (
        <div className="logline">
            <span className="t">{time}</span>
            <span className={`lv ${e.level}`}>{e.level.toUpperCase()}</span>
            <span className="u" title={e.email ?? e.user ?? undefined}>
                {who}
            </span>
            <span className="m">
                {e.title ? <span className="title">[{e.title}]</span> : null}
                {e.message}
            </span>
        </div>
    )
}

/** 简易柱状图：只用于一眼看趋势，数值同时以文字标注，避免误读 */
export function MiniBars({
    data,
    height = 96
}: {
    data: Array<{ label: string; value: number; title?: string }>
    height?: number
}) {
    const max = Math.max(1, ...data.map(d => d.value))
    return (
        <div className="chart" style={{ height }}>
            {data.map((d, i) => (
                <div className="col" key={`${d.label}-${i}`} title={d.title ?? `${d.label}: ${d.value}`}>
                    <b>{d.value > 0 ? d.value : ''}</b>
                    <i style={{ height: Math.max(2, (d.value / max) * (height - 34)) }} />
                </div>
            ))}
        </div>
    )
}

/** 自动滚动到底部，可被用户手动暂停 */
export function useAutoScroll(dep: unknown) {
    const ref = useRef<HTMLDivElement>(null)
    const [paused, setPaused] = useState(false)
    const [atBottom, setAtBottom] = useState(true)

    useEffect(() => {
        const el = ref.current
        if (!el) return
        const onScroll = () => {
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
            setAtBottom(bottom)
            if (!bottom) setPaused(true)
        }
        el.addEventListener('scroll', onScroll, { passive: true })
        return () => el.removeEventListener('scroll', onScroll)
    }, [])

    useEffect(() => {
        if (paused) return
        const el = ref.current
        if (el) el.scrollTop = el.scrollHeight
    }, [dep, paused])

    const jumpToBottom = () => {
        const el = ref.current
        if (el) el.scrollTop = el.scrollHeight
        setPaused(false)
    }

    return { ref, paused, setPaused, atBottom, jumpToBottom }
}

/** 实时等待指示：确定秒数走倒计时，区间值显示已等时长与预计区间 */
export function WaitChip({
    wait,
    compact
}: {
    wait: {
        kind: 'countdown' | 'range'
        label: string
        endsAt: string
        totalSec?: number | null
        minSec?: number | null
        maxSec?: number | null
    }
    compact?: boolean
}) {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const id = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(id)
    }, [wait.endsAt])

    const end = Date.parse(wait.endsAt)
    const remain = Number.isFinite(end) ? Math.max(0, Math.round((end - now) / 1000)) : 0
    const mm = Math.floor(remain / 60)
    const ss = remain % 60
    const text = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`

    if (wait.kind === 'range') {
        const total = wait.maxSec ?? 0
        const elapsed = Math.max(0, total - remain)
        const em = Math.floor(elapsed / 60)
        const es = elapsed % 60
        const minLabel = wait.minSec ? `${Math.round(wait.minSec / 60)}–${Math.round(total / 60)} 分` : '—'
        const overdue = remain <= 0
        return (
            <span className="wait-chip" title={`${wait.label}：已等 ${em} 分 ${es} 秒，预计 ${minLabel}`}>
                <span className="wait-label">{wait.label}</span>
                <span className="wait-time">
                    {String(em).padStart(2, '0')}:{String(es).padStart(2, '0')}
                </span>
                <span className="wait-sub">{overdue ? '超过预计，可能卡住' : `预计 ${minLabel}`}</span>
            </span>
        )
    }

    const pct = wait.totalSec && wait.totalSec > 0 ? Math.min(100, Math.max(0, (remain / wait.totalSec) * 100)) : 0
    if (remain <= 0) {
        return (
            <span className="muted" style={{ fontSize: 11.5 }}>
                等待结束，即将继续…
            </span>
        )
    }

    return (
        <span className="wait-chip" title={`${wait.label} 剩余 ${remain} 秒`}>
            <span className="wait-label">{wait.label}</span>
            <span className="wait-time">{text}</span>
            {!compact ? (
                <span className="wait-bar">
                    <i style={{ width: `${pct}%` }} />
                </span>
            ) : null}
        </span>
    )
}
