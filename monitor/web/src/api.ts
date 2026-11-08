// 与监控后端的数据连接。
// 只用 EventSource 订阅只读快照；断线自动重连，重连状态单独暴露给界面。
// 前端不持有 Control API 的 token，也从不直接访问 3010 端口。

import { useEffect, useRef, useState } from 'react'
import type { Snapshot } from './types'

export type ConnState = 'connecting' | 'live' | 'stale' | 'offline'

export function useSnapshot() {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
    const [conn, setConn] = useState<ConnState>('connecting')
    const [lastUpdate, setLastUpdate] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const retryRef = useRef<number>(0)

    useEffect(() => {
        let cancelled = false
        let es: EventSource | null = null
        let staleTimer: number

        const markStale = () => {
            // 6 秒没有任何推送就认为数据不再新鲜
            staleTimer = window.setTimeout(() => {
                if (!cancelled) setConn(prev => (prev === 'live' ? 'stale' : prev))
            }, 6000)
        }

        const connect = () => {
            if (cancelled) return
            setConn(retryRef.current > 0 ? 'connecting' : 'connecting')
            es = new EventSource('/api/stream')

            es.onopen = () => {
                if (cancelled) return
                retryRef.current = 0
                setConn('live')
                setError(null)
            }

            es.onmessage = ev => {
                if (cancelled) return
                try {
                    const data = JSON.parse(ev.data) as Snapshot
                    setSnapshot(data)
                    setLastUpdate(data.generatedAt)
                    setConn('live')
                    setError(null)
                    window.clearTimeout(staleTimer)
                    markStale()
                } catch {
                    setError('快照解析失败')
                }
            }

            es.onerror = () => {
                if (cancelled) return
                setConn('offline')
                setError('与本地监控服务的连接中断')
                es?.close()
                retryRef.current += 1
                const delay = Math.min(10000, 1000 * retryRef.current)
                window.setTimeout(connect, delay)
            }
        }

        connect()

        return () => {
            cancelled = true
            window.clearTimeout(staleTimer)
            es?.close()
        }
    }, [])

    return { snapshot, conn, lastUpdate, error }
}

export async function fetchAccountDetail(email: string) {
    const res = await fetch(`/api/accounts/${encodeURIComponent(email)}`)
    if (!res.ok) throw new Error(`读取账号详情失败：${res.status}`)
    return res.json()
}
