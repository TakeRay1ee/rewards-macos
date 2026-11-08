import { useMemo, useState } from 'react'
import { Card, ConnBadge, LogLine, useAutoScroll } from '../components'
import type { Snapshot } from '../types'

type Level = 'debug' | 'info' | 'warn' | 'error'

export function Logs({ snap, conn }: { snap: Snapshot; conn: 'connecting' | 'live' | 'stale' | 'offline' }) {
    const [level, setLevel] = useState<Level | 'all'>('info')
    const [email, setEmail] = useState<string>('all')
    const [onlyMine, setOnlyMine] = useState(false)
    const [copied, setCopied] = useState(false)

    const rank: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }

    const rows = useMemo(() => {
        let list = snap.logs
        if (level !== 'all') list = list.filter(e => (rank[e.level] ?? 1) >= rank[level])
        if (email !== 'all') list = list.filter(e => e.email === email)
        if (onlyMine) list = list.filter(e => Boolean(e.email))
        return list
    }, [snap.logs, level, email, onlyMine])

    const { ref, paused, setPaused, jumpToBottom } = useAutoScroll(rows.length)

    const copy = async () => {
        const text = rows
            .map(
                e =>
                    `[${e.ts ?? e.receivedAt}] [${e.email ?? e.user ?? '-'}] [${e.level}] [${e.title ?? ''}] ${e.message}`
            )
            .join('\n')
        try {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
        } catch {
            setCopied(false)
        }
    }

    const download = () => {
        const text = rows
            .map(e => JSON.stringify({ ts: e.ts, email: e.email, level: e.level, title: e.title, message: e.message }))
            .join('\n')
        const blob = new Blob([text], { type: 'application/x-ndjson' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `rewards-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jsonl`
        a.click()
        URL.revokeObjectURL(a.href)
    }

    return (
        <>
            <div className="page-head">
                <div>
                    <h2>实时日志</h2>
                    <p>
                        当前保留 {snap.logStats.buffered} 条（上限 {snap.logStats.cap}），已落盘{' '}
                        {snap.logStats.persisted} 条 · 全局控制器日志与账号日志按真实账号标识区分
                    </p>
                </div>
                <ConnBadge state={conn} />
            </div>

            <div className="toolbar">
                <select
                    className="select"
                    aria-label="日志级别"
                    value={level}
                    onChange={e => setLevel(e.target.value as Level | 'all')}
                >
                    <option value="all">全部级别</option>
                    <option value="debug">DEBUG 及以上</option>
                    <option value="info">INFO 及以上</option>
                    <option value="warn">WARN 及以上</option>
                    <option value="error">仅 ERROR</option>
                </select>
                <select
                    className="select"
                    aria-label="筛选日志账号"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                >
                    <option value="all">全部账号</option>
                    {snap.accounts.map(a => (
                        <option key={a.email} value={a.email}>
                            {a.email}
                        </option>
                    ))}
                </select>
                <button
                    aria-pressed={onlyMine}
                    className={`btn${onlyMine ? ' active' : ''}`}
                    onClick={() => setOnlyMine(v => !v)}
                >
                    只看账号日志
                </button>
                <button
                    aria-pressed={paused}
                    className={`btn${paused ? ' active' : ''}`}
                    onClick={() => setPaused(p => !p)}
                >
                    {paused ? '已暂停滚动' : '自动滚动'}
                </button>
                {paused ? (
                    <button className="btn" onClick={jumpToBottom}>
                        跳到最新
                    </button>
                ) : null}
                <div className="spacer" />
                <button className="btn" onClick={copy}>
                    {copied ? '已复制' : '复制当前视图'}
                </button>
                <button className="btn" onClick={download}>
                    导出 JSONL
                </button>
            </div>

            <Card>
                <div className="logs" ref={ref}>
                    {rows.length === 0 ? (
                        <div className="empty">当前筛选条件下没有日志</div>
                    ) : (
                        rows.map(e => <LogLine key={`${e.id}-${e.receivedAt ?? ''}`} e={e} />)
                    )}
                </div>
            </Card>
        </>
    )
}
