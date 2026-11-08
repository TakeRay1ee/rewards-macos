// Deliberately synthetic data for isolated UI checks and documentation images.
function createSnapshot(now = new Date()) {
    const iso = delta => new Date(now.getTime() + delta).toISOString()
    const today = now.toLocaleDateString('en-CA')
    const names = ['lin', 'mia', 'chen', 'wu', 'li']
    const statuses = ['running', 'completed', 'waiting', 'failed', 'not_run']
    const gains = [30, 90, null, null, null]
    const accounts = names.map((name, i) => ({
        index: [1, 2, 3, 7, 10][i],
        email: `${name}@example.invalid`,
        status: statuses[i],
        currentRunStatus: statuses[i],
        includedInCurrentRun: i < 4,
        statusScope: i < 4 ? 'current-run' : 'none',
        statusAt: i === 1 || i === 3 ? iso(-60000) : null,
        todayStatus: i === 1 ? 'completed' : i === 3 ? 'failed' : null,
        statusKnown: true,
        currentTask:
            i === 0
                ? {
                      title: 'SEARCH',
                      message: '桌面搜索进行中，等待积分更新',
                      at: iso(-15000),
                      platform: 'DESKTOP',
                      level: 'info'
                  }
                : i === 3
                  ? {
                        title: 'LOGIN',
                        message: '连接超时，稍后可重试',
                        at: iso(-120000),
                        platform: 'MOBILE',
                        level: 'error'
                    }
                  : null,
        workerPid: i < 3 ? 43101 + i : null,
        wait:
            i === 0
                ? {
                      kind: 'countdown',
                      label: '搜索间隔',
                      startedAt: iso(-10000),
                      endsAt: iso(35000),
                      totalSec: 45,
                      minSec: null,
                      maxSec: null
                  }
                : null,
        activities:
            i < 2
                ? {
                      'DAILY-CHECK-IN': { count: 1, platform: 'MOBILE', lastAt: iso(-360000) },
                      'DAILY-SET': { count: 3, platform: 'MOBILE', lastAt: iso(-240000) },
                      SEARCH: { count: 12, platform: 'DESKTOP', lastAt: iso(-15000) }
                  }
                : {},
        attributionReliable: true,
        attributionNote: null,
        startedAt: i < 2 || i === 3 ? iso(-480000) : null,
        durationSec: i === 1 ? 412 : i === 0 ? 480 : null,
        collectedThisRun: gains[i],
        balance: [8420, 12780, 6510, null, 9340][i],
        initialPoints: [8390, 12690, 6510, null, 9340][i],
        earnable: { mobile: null, browser: 90, app: 30 },
        searchSummary: i === 1 ? { mobile: 0, desktop: 60, bonus: 0, total: 60 } : null,
        lastSuccess: i === 3 ? false : true,
        lastRunAt: iso(-86400000),
        lastCollected: [90, 90, 120, 75, 90][i],
        lastError: null,
        error: i === 3 ? '连接超时，稍后可重试' : null,
        hasTotp: i === 0,
        geoLocale: 'CN',
        langCode: 'zh-CN',
        durationSource: 'api',
        dataSource: 'synthetic-fixture'
    }))
    const days = Array.from({ length: 7 }, (_, i) => {
        const date = new Date(now)
        date.setDate(date.getDate() - i)
        const cells = Object.fromEntries(
            accounts.map((a, j) => [
                a.email,
                {
                    collected: i === 0 ? gains[j] : [75, 90, 110, 95, 80, 100][(i + j) % 6],
                    balance: a.balance,
                    runs: i === 0 ? 1 : 2,
                    observedAt: iso(-i * 86400000)
                }
            ])
        )
        return {
            date: date.toLocaleDateString('en-CA'),
            accounts: cells,
            total: Object.values(cells).reduce((n, c) => n + (c.collected ?? 0), 0)
        }
    })
    const ledger = {
        generatedAt: iso(0),
        days,
        today,
        timeZone: 'Asia/Shanghai',
        todayTotals: Object.fromEntries(accounts.map((a, i) => [a.email, gains[i]])),
        balances: Object.fromEntries(
            accounts.map(a => [a.email, { value: a.balance, at: iso(-15000), runId: 'demo-run', source: 'run-meta' }])
        ),
        weekTotals: Object.fromEntries(
            accounts.map(a => [a.email, days.reduce((n, d) => n + (d.accounts[a.email].collected ?? 0), 0)])
        ),
        runCount: 12,
        source: 'synthetic-fixture',
        note: 'Documentation fixture only'
    }
    const logs = Array.from({ length: 16 }, (_, i) => ({
        id: i + 1,
        runId: 'demo-run',
        email: accounts[i % 2].email,
        user: accounts[i % 2].email,
        ts: iso(-i * 18000),
        receivedAt: iso(-i * 18000),
        level: i === 7 ? 'warn' : 'info',
        title: ['DAILY-SET', 'SEARCH', 'ACCOUNT-END', 'DAILY-CHECK-IN'][i % 4],
        message: ['每日活动已完成，积分已更新', '搜索请求已完成，等待下一次检查', '账号任务执行完成', '今日签到完成'][
            i % 4
        ],
        platform: i % 2 ? 'DESKTOP' : 'MOBILE',
        source: 'stdout',
        parsed: true,
        raw: 'Synthetic log'
    }))
    const history = Array.from({ length: 4 }, (_, i) => ({
        runId: `demo-history-${i}`,
        startedAt: iso(-(i + 1) * 86400000),
        endedAt: iso(-(i + 1) * 86400000 + 480000),
        exit: { code: i === 2 ? 1 : 0, signal: null, at: iso(-(i + 1) * 86400000 + 480000) },
        accounts: accounts.slice(0, 4).map(a => ({
            email: a.email,
            collected: 90,
            success: i === 2 ? a.index !== 7 : true,
            error: i === 2 && a.index === 7 ? '连接超时' : null
        })),
        totals: { accountsProcessed: 4, collected: 360, oldTotal: 33000, newTotal: 33360, runtimeMinutes: 8 }
    }))
    const plan = {
        accounts: 5,
        clusters: 3,
        byMemory: 5,
        footprintMb: 680,
        footprintMeasured: true,
        memory: { availableMb: 6144, totalMb: 16384, source: 'vm_stat' },
        reserveMb: 1536,
        usableMb: 4608,
        limitedBy: 'memory'
    }
    const lastRun = {
        at: iso(-480000),
        reason: 'daily',
        result: 'started',
        detail: null,
        plan,
        pid: 43100,
        startedAt: iso(-480000)
    }
    return {
        generatedAt: iso(0),
        controlApi: {
            base: 'http://127.0.0.1:3010',
            online: true,
            error: null,
            tokenConfigured: true,
            dataSource: 'synthetic-fixture'
        },
        run: {
            runId: 'demo-run',
            startedAt: iso(-480000),
            endedAt: null,
            exit: null,
            state: 'running',
            pid: 43100,
            logStreamAvailable: true,
            selectedAccounts: accounts.slice(0, 4).map(({ index, email }) => ({ index, email })),
            clusters: 3,
            version: '4.4.0',
            accountsTotal: 4,
            accountsSeen: 3,
            totals: null,
            finished: false,
            upstreamCurrentAccount: accounts[0].email,
            upstreamCurrentAccountReliable: true,
            logEventCount: 342,
            ambiguousAttributions: 0,
            exitInfo: null
        },
        overview: {
            accountsTotal: 5,
            running: 1,
            waiting: 1,
            completed: 1,
            todayCompleted: 1,
            failed: 1,
            stopped: 0,
            notRun: 1,
            unknown: 0,
            countsKnown: true,
            collectedThisRun: 120,
            activeWorkerProcesses: 3,
            browserInstances: 2,
            clusters: 3
        },
        accounts,
        points: {
            state: 'running',
            running: true,
            collected: 120,
            totals: null,
            accountsTotal: 4,
            accountsSeen: 3,
            updatedAt: iso(0),
            finished: false,
            accounts: accounts.slice(0, 4).map(a => ({
                email: a.email,
                collected: a.collectedThisRun,
                balance: a.balance,
                initialPoints: a.initialPoints,
                success: a.status === 'completed' ? true : a.status === 'failed' ? false : null,
                error: a.error,
                done: ['completed', 'failed'].includes(a.status)
            })),
            note: null
        },
        logs,
        errors: { errors: [], accountErrors: [], count: 0 },
        history,
        historySource: 'synthetic-fixture',
        ledger,
        system: {
            at: iso(0),
            host: {
                platform: 'darwin',
                arch: 'arm64',
                release: '25.1.0',
                nodeVersion: 'v26.13.0',
                uptimeSec: 129600,
                hostname: 'Demo Mac'
            },
            cpu: { cores: 8, loadAvg: [1.2, 1.4, 1.1], usagePercent: 18.4, source: 'os.cpus' },
            memory: {
                totalBytes: 16 * 1024 ** 3,
                availableBytes: 6 * 1024 ** 3,
                wiredBytes: 2 * 1024 ** 3,
                source: 'vm_stat',
                formula: 'free + inactive + purgeable + speculative'
            },
            processes: {
                workers: [
                    { pid: 43101, ppid: 43100, rssMb: 118, cpuPercent: 4.2, etime: '08:00' },
                    { pid: 43102, ppid: 43100, rssMb: 104, cpuPercent: 2.1, etime: '06:50' }
                ],
                browserInstances: 2,
                browserProcessCount: 12,
                browserRssMb: 980,
                workerRssMb: 222,
                api: { pid: 43001, rssMb: 48 },
                monitor: { pid: 43002, rssMb: 54 },
                totalProcessCount: 16,
                source: 'synthetic-fixture'
            }
        },
        scheduler: {
            recovery: null,
            guard: null,
            lastRun,
            calibration: { footprintMb: 680, measuredAt: iso(-86400000), samples: 8 },
            budget: { reserveGb: 1.5, defaultFootprintMb: 700 },
            logTail: [lastRun]
        },
        logStats: { buffered: 342, cap: 5000, lastLogId: 342, persisted: 342, runId: 'demo-run' }
    }
}
module.exports = { createSnapshot }
