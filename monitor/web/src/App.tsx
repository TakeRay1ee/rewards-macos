import { useEffect, useMemo, useState } from 'react'
import { Banner, ConnBadge, Icon } from './components'
import { useSnapshot } from './api'
import { Overview } from './pages/Overview'
import { Accounts } from './pages/Accounts'
import { AccountDetail } from './pages/AccountDetail'
import { Logs } from './pages/Logs'
import { History } from './pages/History'
import { Control } from './pages/Control'
import { Reports } from './pages/Reports'

const NAV = [
    { path: '/', label: '总览', icon: 'overview' },
    { path: '/accounts', label: '账号', icon: 'accounts' },
    { path: '/reports', label: '积分报表', icon: 'chart' },
    { path: '/logs', label: '日志', icon: 'logs' },
    { path: '/history', label: '运行历史', icon: 'history' },
    { path: '/control', label: '运行管理', icon: 'settings' }
] as const

function canonicalRoute(route: string) {
    if (route === '/points') return '/reports'
    if (route === '/system') return '/control/system'
    return route
}

function useHashRoute() {
    const [hash, setHash] = useState(() => canonicalRoute(window.location.hash.slice(1) || '/'))
    useEffect(() => {
        const onHash = () => setHash(canonicalRoute(window.location.hash.slice(1) || '/'))
        window.addEventListener('hashchange', onHash)
        return () => window.removeEventListener('hashchange', onHash)
    }, [])
    const goto = (route: string) => {
        window.location.hash = route
    }
    return { hash, goto }
}

function useTheme() {
    const [theme, setTheme] = useState<'light' | 'dark'>(() => {
        const saved = window.localStorage.getItem('rewards-theme')
        return saved === 'light' || saved === 'dark'
            ? saved
            : window.matchMedia('(prefers-color-scheme: dark)').matches
              ? 'dark'
              : 'light'
    })
    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme)
        window.localStorage.setItem('rewards-theme', theme)
    }, [theme])
    return { theme, toggle: () => setTheme(t => (t === 'light' ? 'dark' : 'light')) }
}

export default function App() {
    const { snapshot, conn, lastUpdate, error } = useSnapshot()
    const { hash, goto } = useHashRoute()
    const { theme, toggle } = useTheme()
    const activeNav = useMemo(() => NAV.find(n => n.path !== '/' && hash.startsWith(n.path)) ?? NAV[0], [hash])
    const detailEmail = useMemo(() => {
        const match = hash.match(/^\/accounts\/(.+)$/)
        try {
            return match ? decodeURIComponent(match[1]) : null
        } catch {
            return null
        }
    }, [hash])

    return (
        <div className="app">
            <a
                className="skip-link"
                href="#main-content"
                onClick={event => {
                    event.preventDefault()
                    document.getElementById('main-content')?.focus()
                }}
            >
                跳到主要内容
            </a>
            <aside className="sidebar">
                <div className="brand">
                    <span className="brand-mark">R</span>
                    <div>
                        <h1>Rewards</h1>
                        <span>本地工作台</span>
                    </div>
                </div>
                <div className="nav-caption">工作空间</div>
                <nav className="primary-nav" aria-label="主要导航">
                    {NAV.map(item => (
                        <button
                            key={item.path}
                            className={`nav-item${activeNav.path === item.path ? ' active' : ''}`}
                            onClick={() => goto(item.path)}
                            aria-current={activeNav.path === item.path ? 'page' : undefined}
                        >
                            <Icon name={item.icon} />
                            <span>{item.label}</span>
                            {item.path === '/accounts' && snapshot ? (
                                <span className="nav-count">{snapshot.accounts.length}</span>
                            ) : null}
                        </button>
                    ))}
                </nav>
                <div className="sidebar-footer">
                    <span className="local-indicator">
                        <i />
                        在这台 Mac 上运行
                    </span>
                    <p>账号独立执行，进度实时同步。</p>
                    <span className="sidebar-note">Microsoft Rewards 社区工具</span>
                </div>
            </aside>
            <div className="workspace">
                <header className="topbar">
                    <div className="breadcrumb">
                        工作空间
                        <Icon name="chevron" />
                        <strong>{detailEmail ? '账号详情' : activeNav.label}</strong>
                    </div>
                    <div className="topbar-actions">
                        <span className="last-updated">
                            {lastUpdate
                                ? `${new Date(lastUpdate).toLocaleTimeString('zh-CN', { hour12: false })} 更新`
                                : '等待首次同步'}
                        </span>
                        <ConnBadge state={conn} />
                        <button
                            className="icon-button"
                            onClick={toggle}
                            aria-label={theme === 'light' ? '切换深色' : '切换浅色'}
                            title={theme === 'light' ? '切换深色' : '切换浅色'}
                        >
                            <Icon name={theme === 'light' ? 'moon' : 'sun'} />
                        </button>
                    </div>
                </header>
                <main className="main" id="main-content" tabIndex={-1}>
                    {conn === 'offline' ? (
                        <Banner kind="danger">
                            与本地监控服务的连接已断开，界面数据停止更新。服务恢复后会自动重连。
                            {error ? `（${error}）` : ''}
                        </Banner>
                    ) : conn === 'stale' ? (
                        <Banner kind="warn">超过 6 秒没有收到新数据，当前展示最后一次成功同步的结果。</Banner>
                    ) : null}
                    {snapshot && !snapshot.controlApi.online ? (
                        <Banner kind="warn">
                            上游 Control API 不可达（{snapshot.controlApi.error ?? '未知原因'}
                            ）。当前账号数据可能不是最新状态。
                        </Banner>
                    ) : null}
                    {snapshot?.run.logStreamAvailable === false && snapshot.run.state !== 'idle' ? (
                        <Banner kind="warn">
                            已恢复进程控制，原日志流暂时无法接回。当前为最后观测值，自动停滞判断已暂停。
                        </Banner>
                    ) : null}
                    {snapshot?.scheduler.recovery?.state === 'requires_attention' ? (
                        <Banner kind="warn">
                            恢复需要处理：{snapshot.scheduler.recovery.reason ?? '仍有未完成账号'}
                        </Banner>
                    ) : null}
                    {snapshot?.scheduler.guard?.action === 'requires_attention' ? (
                        <Banner kind="warn">每日补跑需要处理：{snapshot.scheduler.guard.reason}</Banner>
                    ) : null}
                    {!snapshot ? (
                        <div className="card empty loading-state">
                            <span className="loading-ring" />
                            <h2>正在连接工作台</h2>
                            <p>读取账号、积分与最近运行状态…</p>
                        </div>
                    ) : detailEmail ? (
                        <AccountDetail snap={snapshot} email={detailEmail} goto={goto} />
                    ) : activeNav.path === '/accounts' ? (
                        <Accounts snap={snapshot} goto={goto} />
                    ) : activeNav.path === '/reports' ? (
                        <Reports snap={snapshot} />
                    ) : activeNav.path === '/logs' ? (
                        <Logs snap={snapshot} conn={conn} />
                    ) : activeNav.path === '/history' ? (
                        <History snap={snapshot} />
                    ) : activeNav.path === '/control' ? (
                        <Control
                            snap={snapshot}
                            view={hash === '/control/system' ? 'system' : 'control'}
                            onViewChange={view => goto(view === 'system' ? '/control/system' : '/control')}
                        />
                    ) : (
                        <Overview snap={snapshot} goto={goto} />
                    )}
                    <footer className="workspace-footer">
                        <span>Rewards · 本地运行</span>
                        <span>未观测到的数据以 — 显示</span>
                    </footer>
                </main>
            </div>
        </div>
    )
}
