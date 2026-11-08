// 与监控后端 /api/snapshot 对应的数据结构。
// 这里刻意保留 null 语义：null 表示"上游无法确定"，不能当成 0 或空字符串处理。

export type AccountStatus =
    'not_run' | 'waiting' | 'starting' | 'running' | 'completed' | 'failed' | 'stopped' | 'unknown'

export interface TaskStep {
    title: string | null
    message: string
    at: string
    platform: string | null
    level: string
}

export interface WaitInfo {
    kind: 'countdown' | 'range'
    label: string
    startedAt: string
    endsAt: string
    totalSec: number | null
    minSec: number | null
    maxSec: number | null
}

export interface AccountRow {
    index: number
    email: string
    status: AccountStatus
    currentRunStatus?: AccountStatus
    includedInCurrentRun?: boolean | null
    statusScope?: 'current-run' | 'today' | 'none'
    statusAt?: string | null
    todayStatus?: 'completed' | 'failed' | 'unknown' | null
    todayResult?: {
        status: 'completed' | 'failed'
        at: string
        runId: string | null
        collected: number | null
        error: string | null
    } | null
    statusKnown: boolean
    currentTask: TaskStep | null
    workerPid: number | null
    wait: WaitInfo | null
    activities: Record<string, { count: number; platform: string | null; lastAt: string | null }>
    attributionReliable: boolean
    attributionNote: string | null
    startedAt: string | null
    durationSec: number | null
    collectedThisRun: number | null
    balance: number | null
    initialPoints: number | null
    earnable: { mobile: number | null; browser: number | null; app: number | null } | null
    searchSummary: { mobile: number; desktop: number; bonus: number; total: number } | null
    lastSuccess: boolean | null
    lastRunAt: string | null
    lastCollected: number | null
    lastError: string | null
    error: string | null
    hasTotp: boolean | null
    geoLocale: string | null
    langCode: string | null
    durationSource: string | null
    dataSource: string
}

export interface LogEntry {
    runId?: string | null
    id: number
    ts: string | null
    level: 'debug' | 'info' | 'warn' | 'error'
    user: string | null
    email: string | null
    platform: string | null
    title: string | null
    message: string
    source: string
    parsed: boolean
    raw: string
    receivedAt?: string
}

export interface RunView {
    runId: string | null
    startedAt: string | null
    endedAt: string | null
    exit: { code: number | null; signal: string | null; at: string } | null
    state: string
    pid: number | null
    logStreamAvailable?: boolean
    selectedAccounts?: Array<{ index: number; email: string }> | null
    clusters: number | null
    version: string | null
    accountsTotal: number | null
    accountsSeen: number | null
    totals: {
        accountsProcessed: number
        collected: number
        oldTotal: number
        newTotal: number
        runtimeMinutes: number
    } | null
    finished: boolean | null
    upstreamCurrentAccount: string | null
    upstreamCurrentAccountReliable: boolean
    logEventCount: number
    ambiguousAttributions: number | null
    exitInfo: { code: number | null; signal: string | null; at: string; error?: string } | null
}

export interface Snapshot {
    generatedAt: string
    controlApi: {
        base: string
        online: boolean
        error: string | null
        tokenConfigured: boolean
        dataSource: string
    }
    run: RunView
    overview: {
        accountsTotal: number
        running: number
        waiting: number
        completed: number
        failed: number
        stopped: number
        notRun: number
        unknown: number
        countsKnown: boolean
        todayCompleted?: number
        collectedThisRun: number | null
        activeWorkerProcesses: number | null
        browserInstances: number | null
        clusters: number | null
    }
    accounts: AccountRow[]
    points: {
        state: string
        running: boolean
        collected: number | null
        totals: RunView['totals']
        accountsTotal: number | null
        accountsSeen: number | null
        updatedAt: string | null
        finished: boolean | null
        accounts: Array<{
            email: string
            collected: number | null
            balance: number | null
            initialPoints: number | null
            success: boolean | null
            error: string | null
            done: boolean
        }>
        note: string | null
    } | null
    logs: LogEntry[]
    errors: {
        errors: LogEntry[]
        accountErrors: Array<{ email: string; error: string }>
        count: number
    } | null
    ledger: Ledger | null
    history: HistoryRun[]
    historySource: string
    system: SystemSnapshot | null
    scheduler: {
        recovery?: { state: string; reason?: string | null } | null
        guard?: { action: string; reason?: string } | null
        lastRun: SchedulerRecord | null
        calibration: { footprintMb: number; measuredAt: string; samples: number } | null
        budget: { reserveGb: number; defaultFootprintMb: number } | null
        logTail: SchedulerRecord[]
    }
    logStats: {
        buffered: number
        cap: number
        lastLogId: number
        persisted: number
        runId: string | null
    }
}

export interface LedgerCell {
    collected: number | null
    balance: number | null
    runs: number
    observedAt: string | null
}

export interface LedgerRow {
    date: string
    accounts: Record<string, LedgerCell>
    total: number | null
}

export interface LedgerBalance {
    value: number | null
    at: string | null
    runId: string | null
    source: string
}

export interface Ledger {
    generatedAt: string
    days: LedgerRow[]
    today: string
    timeZone?: string
    range?: { from: string; to: string }
    rangeRunCount?: number
    todayTotals: Record<string, number | null>
    balances: Record<string, LedgerBalance>
    weekTotals: Record<string, number | null>
    runCount: number
    source: string
    note: string
}

export interface HistoryRun {
    runId?: string
    startedAt?: string
    endedAt?: string
    exit?: { code: number | null; signal: string | null; at: string }
    run?: {
        accountsTotal: number | null
        collected: number
        totals: RunView['totals']
    }
    totals?: RunView['totals']
    accounts?: Array<{
        email: string
        success: boolean | null
        collected: number | null
        collectedObserved?: boolean
        terminalAt?: string | null
        error: string | null
    }>
}

export interface SchedulerRecord {
    at: string
    reason: string
    result: string
    detail: string | null
    plan?: {
        accounts: number
        clusters: number
        byMemory: number
        footprintMb: number
        footprintMeasured: boolean
        memory: { availableMb: number; totalMb: number; source: string }
        reserveMb: number
        usableMb: number
        limitedBy: string
    }
    pid?: number | null
    startedAt?: string | null
}

export interface SystemSnapshot {
    at: string
    host: {
        platform: string
        arch: string
        release: string
        nodeVersion: string
        uptimeSec: number
        hostname: string
    }
    cpu: {
        cores: number
        loadAvg: number[]
        usagePercent: number | null
        source: string
    }
    memory: {
        totalBytes: number
        availableBytes: number
        wiredBytes?: number
        compressedBytes?: number
        source: string
        formula?: string
        note?: string
    }
    processes: {
        workers: Array<{ pid: number; ppid: number; rssMb: number; cpuPercent: number; etime: string }>
        browserInstances: number
        browserProcessCount: number
        browserRssMb: number
        workerRssMb: number
        api: { pid: number; rssMb: number } | null
        monitor: { pid: number; rssMb: number } | null
        totalProcessCount: number
        source: string
    }
}

export const STATUS_LABEL: Record<AccountStatus, string> = {
    not_run: '未执行',
    waiting: '等待中',
    starting: '启动中',
    running: '运行中',
    completed: '已完成',
    failed: '执行失败',
    stopped: '已停止',
    unknown: '未知'
}

export const STATUS_ORDER: AccountStatus[] = [
    'running',
    'starting',
    'waiting',
    'completed',
    'failed',
    'stopped',
    'not_run',
    'unknown'
]
