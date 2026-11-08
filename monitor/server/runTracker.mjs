// 运行跟踪器：把上游的日志流重放成"多账号并行"视角的状态。
//
// 为什么必须重放：上游 `logParser` 的 runState 以 `currentEmail` 为单一上下文，
// 在 clusters>1 时这个字段只记录"最后一个开始说话的账号"，无法表达 N 个账号同时运行。
// 但 `runState.accounts[email]` 是按邮箱分键的，账号级终态（ACCOUNT-END / ACCOUNT-ERROR）
// 完全可靠。所以我们复用上游解析器拿账号级事实，自己补 account 维度的"进行中/等待"判定。
//
// 直接 import 上游脚本而不是复制一份，是为了让上游修正日志格式时监控自动跟随。

import fs from 'node:fs'
import path from 'node:path'
import { accountHistory, RunHistoryStore } from './runHistory.mjs'

import {
    createRunState,
    applyLogToRunState,
    observedCollected,
    restoreRunSummary,
    summarizeRunState
} from '../../scripts/api/logParser.js'

const ACCOUNT_START_RE = /开始处理账户:\s*([^\s|]+)/

// 上游有多处"等 N 秒"的节奏控制，界面上把它们做成会走的倒计时。
// 只认明确的两种，避免把"已保存分钟数=5"之类误判成等待。
// 两类等待：
//   countdown - 上游给了确定的秒数，可以精确倒计
//   range     - 上游只给区间（如搜索 6–11 分钟），只报"已等多久 / 预计区间"
const WAIT_PATTERNS = [
    {
        kind: 'countdown',
        re: /大任务间隔等待\s*\|\s*(\d+(?:\.\d+)?)\s*秒/,
        label: '大任务间隔',
        pick: m => ({ seconds: Number(m[1]) })
    },
    {
        kind: 'countdown',
        re: /等待\s*(\d+(?:\.\d+)?)\s*秒后开始下一个账户/,
        label: '账号切换',
        pick: m => ({ seconds: Number(m[1]) })
    },
    {
        kind: 'range',
        re: /文章间等待.*?delayRange=(\d+)min-(\d+)min/,
        label: '读文间隔',
        pick: m => ({ minSec: Number(m[1]) * 60, maxSec: Number(m[2]) * 60 })
    },
    {
        kind: 'range',
        re: /delayRange=(\d+)min-(\d+)min/,
        label: '搜索间隔',
        pick: m => ({ minSec: Number(m[1]) * 60, maxSec: Number(m[2]) * 60 })
    }
]

function parseWait(message) {
    if (typeof message !== 'string') return null
    for (const { kind, re, label, pick } of WAIT_PATTERNS) {
        const m = message.match(re)
        if (m) {
            const extra = pick(m)
            const nums = Object.values(extra)
            if (nums.every(n => Number.isFinite(n) && n >= 0)) return { kind, label, ...extra }
        }
    }
    return null
}
const WORKER_TASK_RE = /worker\s+(\d+)\s*接收到\s*(\d+)\s*个账户/

const ACCOUNT_STATUS = {
    NOT_RUN: 'not_run',
    WAITING: 'waiting',
    STARTING: 'starting',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    STOPPED: 'stopped',
    UNKNOWN: 'unknown'
}

export { ACCOUNT_STATUS }

function nowIso() {
    return new Date().toISOString()
}

function runInfo(info) {
    if (!info?.startedAt) return null
    const id = info.runId ?? String(info.startedAt).replace(/[:.]/g, '-')
    return {
        ...info,
        runId: id,
        upstreamRunId: Object.hasOwn(info, 'upstreamRunId') ? info.upstreamRunId : info.runId ? info.runId : null
    }
}

function journalCheckpoint(meta, events) {
    if (Number.isSafeInteger(meta?.lastLogId)) return meta.lastLogId
    if (meta?.logEvents !== events.length || !events.every(entry => Number.isSafeInteger(entry.id))) return null
    return events.reduce((latest, entry) => Math.max(latest, entry.id), 0)
}

function accountCheckpoint(account) {
    return {
        email: account.email,
        success: account.success ?? null,
        // A stopped account may have observed earnings without ACCOUNT-END.
        collected: observedCollected(account),
        collectedSource: account.collectedPoints == null ? 'live-gained' : 'account-end',
        initialPoints: account.initialPoints ?? null,
        finalPoints: account.finalPoints ?? null,
        durationSeconds: account.durationSeconds ?? null,
        error: account.error ?? null,
        terminalAt: account.terminalAt ?? null,
        live: account.live
    }
}

function parseLogTs(ts) {
    // 上游格式：YYYY-MM-DD HH:MM:SS（本地时间，无时区标记）
    if (typeof ts !== 'string') return null
    const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
    if (!m) return null
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
    return Number.isNaN(d.getTime()) ? null : d.getTime()
}

export class RunTracker {
    constructor({ control, configuredAccounts, logCap, runsDir, now = () => new Date() }) {
        this.control = control
        this.logCap = logCap
        this.runsDir = runsDir
        this.now = now
        this.historyStore = new RunHistoryStore(runsDir)

        this.configuredAccounts = configuredAccounts
        // 身份索引：键可能是完整邮箱（新版日志），也可能只是前缀（旧版/未打补丁）。
        // 前缀对应多个账号时不做任何猜测——那正是之前串号的成因。
        this.userKeyToEmails = new Map()
        this.configuredEmails = new Set()
        this.ambiguousAttributions = 0
        // 记录"见过完整邮箱身份"的账号：只有见过，才能说该账号的日志归属可信。
        // 旧版日志只有前缀时，同前缀账号的归属是不可信的，必须显式标出来，
        // 否则界面会把 ACCOUNT-START 当成"当前步骤"长期不动，甚至让看门狗误杀。
        this.seenFullEmailIds = new Set()
        // 需要单独展示的任务清单：把"移动端到底做了哪些事"变得可见
        this.activityTitles = new Set([
            'DAILY-CHECK-IN',
            'DAILY-SET',
            'MORE-PROMOTIONS',
            'APP-PROMOTIONS',
            'READ-TO-EARN',
            'PUNCHCARD',
            'URL-REWARD',
            'SEARCH-BING',
            'VISUAL-SEARCH',
            'ACTIVATE-SEARCH-PERK',
            'ENABLE-STREAK-PROTECTION',
            'CLAIM-BONUS-POINTS'
        ])

        this.status = null
        this.apiUptime = null
        this.apiOnline = false
        this.apiError = null
        this.statusVersion = 0
        this.statusPollSequence = 0

        this.runId = null
        this.runState = createRunState()
        this.runStartedAt = null
        this.runEndedAt = null
        this.runExit = null
        this.upstreamRunId = null
        this.selectedAccounts = null

        this.logs = []
        this.lastLogId = 0
        this.perAccount = new Map() // email -> { firstStartAt, lastEvent, workerPid }
        this.workerQueue = []
        this.attached = false

        this.lastIngestAt = null
        this.persist = { runDir: null, events: null, count: 0 }
        this.runsHistory = []
        this.knownRuns = new Map()
        this.loadHistory()
        this.setConfiguredAccounts(configuredAccounts)
    }

    setConfiguredAccounts(accounts) {
        const hadNoAccounts = this.configuredEmails.size === 0
        this.configuredAccounts = accounts
        this.userKeyToEmails.clear()
        this.configuredEmails.clear()
        for (const a of accounts ?? []) {
            const email = String(a.email || '').trim()
            if (!email) continue
            this.configuredEmails.add(email)
            const localpart = email.split('@')[0]
            if (!localpart) continue
            const bucket = this.userKeyToEmails.get(localpart) ?? new Set()
            bucket.add(email)
            // 同时登记完整邮箱键，兼容新版日志
            this.userKeyToEmails.set(localpart, bucket)
            this.userKeyToEmails.set(email, new Set([email]))
        }

        // 关键：如果之前是在"账号表为空"的状态下回放了日志缓冲区，
        // 那段历史全部会归不上账号（表现为界面卡在 ACCOUNT-START）。
        // 账号表就绪后强制重新回放一次，让历史恢复正确归属。
        if (hadNoAccounts && this.configuredEmails.size > 0 && this.attached) {
            this.attached = false
        }
    }

    loadHistory() {
        try {
            this.runsHistory = this.historyStore.read().reverse()
            for (const meta of this.runsHistory) {
                const info = runInfo(meta)
                if (info) this.knownRuns?.set(info.runId, info)
            }
        } catch {
            this.runsHistory = []
        }
    }

    _accountFor(entry) {
        const user = entry?.user
        if (!user) return null

        // 新版日志直接是完整邮箱，唯一且可信。
        // 但只接受"已配置账号"：账号表尚未加载时（启动初期）先放行，
        // 加载完成后不再把陌生邮箱当成账号，避免产生幽灵账号。
        if (user.includes('@')) {
            if (this.configuredEmails.size === 0) {
                this.seenFullEmailIds.add(user)
                return user
            }
            if (this.configuredEmails.has(user)) {
                this.seenFullEmailIds.add(user)
                return user
            }
            return null
        }

        const bucket = this.userKeyToEmails.get(user)
        if (!bucket || bucket.size === 0) return null
        if (bucket.size === 1) return [...bucket][0]

        // 前缀对应多个账号：宁可标为"无法归属"，也不猜
        this.ambiguousAttributions += 1
        return null
    }

    _resetForRun(
        runId,
        startedAt,
        { upstreamRunId = null, selectedAccounts = null, endedAt = null, exit = null } = {}
    ) {
        this.runId = runId
        this.legacyRunId = this._migrateLegacyRun(runId, startedAt, upstreamRunId)
        let meta = null
        try {
            meta = JSON.parse(fs.readFileSync(path.join(this.runsDir, encodeURIComponent(runId), 'meta.json'), 'utf8'))
        } catch {
            /* New run or missing summary; the event journal remains authoritative. */
        }
        this.legacyRunId ??=
            meta?.legacyRunId ??
            (meta?.runId !== runId && meta?.runId === String(startedAt).replace(/[:.]/g, '-') ? meta.runId : null)
        this.upstreamRunId = upstreamRunId ?? meta?.upstreamRunId ?? null
        selectedAccounts ??= meta?.selectedAccounts
        this.selectedAccounts = Array.isArray(selectedAccounts)
            ? selectedAccounts.map(a => ({ index: a.index, email: a.email }))
            : null
        this.runState = createRunState({ accountEmails: [...this.configuredEmails] })
        this.runStartedAt = startedAt ?? meta?.startedAt ?? null
        this.runEndedAt = endedAt ?? meta?.endedAt ?? null
        this.runExit = exit ?? meta?.exit ?? null
        this.knownRuns.set(runId, {
            runId,
            upstreamRunId,
            startedAt: this.runStartedAt,
            endedAt: this.runEndedAt,
            exit: this.runExit,
            selectedAccounts: this.selectedAccounts
        })
        this.perAccount = new Map()
        this.workerQueue = []
        this.seenFullEmailIds.clear()
        this.ambiguousAttributions = 0
        this.logs = []
        this.seenEvents = new Set()
        const events = this._openPersistence()
        const checkpointId = Number.isSafeInteger(meta?.lastLogId) ? meta.lastLogId : null
        this.summaryCheckpointId = null
        // A summary is the checkpoint after lastLogId. Restore its journal
        // prefix and summary first, then apply only events appended later.
        // This also prevents a retained API tail from duplicating earnings
        // when the local journal has been truncated or removed.
        const beforeCheckpoint = events.filter(
            entry => checkpointId == null || !Number.isFinite(entry.id) || entry.id <= checkpointId
        )
        this._ingest(beforeCheckpoint, { persist: false, writeMeta: false })
        restoreRunSummary(this.runState, meta, { authoritative: checkpointId != null })
        this.summaryCheckpointId = checkpointId
        this.persist.count = Math.max(this.persist.count, meta?.logEvents ?? 0)
        if (checkpointId != null)
            this._ingest(
                events.filter(entry => entry.id > checkpointId),
                { persist: false, writeMeta: false }
            )
    }

    _migrateLegacyRun(runId, startedAt, upstreamRunId) {
        // Older monitors keyed journals by the start timestamp even when the
        // API already supplied a stable id. Adopt that journal before creating
        // a new directory, otherwise the ledger counts the same batch twice.
        if (!upstreamRunId || !startedAt) return null
        const legacyId = String(startedAt).replace(/[:.]/g, '-')
        if (legacyId === runId) return null
        const legacyDir = path.join(this.runsDir, encodeURIComponent(legacyId))
        const runDir = path.join(this.runsDir, encodeURIComponent(runId))
        let meta
        let events
        try {
            meta = JSON.parse(fs.readFileSync(path.join(legacyDir, 'meta.json'), 'utf8'))
            events = fs.existsSync(path.join(legacyDir, 'events.jsonl'))
                ? fs.readFileSync(path.join(legacyDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
                : []
        } catch {
            return null
        }
        if (
            meta.runId !== legacyId ||
            meta.startedAt !== startedAt ||
            (meta.upstreamRunId && meta.upstreamRunId !== upstreamRunId)
        )
            return null
        for (const line of events) {
            try {
                const entry = JSON.parse(line)
                if (entry.runId && entry.runId !== legacyId && entry.runId !== upstreamRunId) return null
            } catch {
                // A damaged line is retained on disk and skipped during replay.
            }
        }
        if (fs.existsSync(runDir)) {
            // A previous attach may already have written a bounded API tail
            // under the stable id. Reconcile the two journals, retaining the
            // original legacy files beneath that directory for recovery.
            let target
            let targetEvents
            let legacyEvents
            try {
                target = JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8'))
                targetEvents = fs.existsSync(path.join(runDir, 'events.jsonl'))
                    ? fs
                          .readFileSync(path.join(runDir, 'events.jsonl'), 'utf8')
                          .split('\n')
                          .filter(Boolean)
                          .map(JSON.parse)
                    : []
                legacyEvents = events.map(JSON.parse)
            } catch {
                return null
            }
            if (
                target.startedAt !== startedAt ||
                target.runId !== runId ||
                (target.upstreamRunId && target.upstreamRunId !== upstreamRunId) ||
                targetEvents.some(entry => entry.runId && entry.runId !== legacyId && entry.runId !== upstreamRunId)
            )
                return null
            const candidates = [
                { meta, checkpoint: journalCheckpoint(meta, legacyEvents) },
                { meta: target, checkpoint: journalCheckpoint(target, targetEvents) }
            ].sort(
                (a, b) =>
                    (b.checkpoint ?? -1) - (a.checkpoint ?? -1) || (b.meta.logEvents ?? 0) - (a.meta.logEvents ?? 0)
            )
            const targetIds = new Set(targetEvents.map(entry => entry.id))
            const legacyCheckpoint = journalCheckpoint(meta, legacyEvents)
            if (legacyCheckpoint != null && legacyEvents.some(entry => !targetIds.has(entry.id))) {
                // A summary built from the API tail can have a higher event id
                // while missing earlier earnings. Start from the original
                // checkpoint and replay the merged suffix instead.
                candidates.sort((a, b) => Number(b.meta === meta) - Number(a.meta === meta))
            }
            // Without a checkpoint neither summary can safely fence replayed
            // live earnings. Leave conflicting/incomplete stores untouched.
            if (candidates.some(candidate => candidate.checkpoint == null)) return null
            const mergedEvents = new Map()
            for (const entry of [...legacyEvents, ...targetEvents]) {
                const normalized = { ...entry, runId }
                mergedEvents.set(Number.isFinite(entry.id) ? `id:${entry.id}` : JSON.stringify(normalized), normalized)
            }
            const journal = [...mergedEvents.values()].sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
            // Each account retains its own summary watermark. In particular,
            // a later summary for an account absent from the legacy prefix may
            // cover events already truncated from the journal. Restore it at
            // that watermark, then publish one summary at the common maximum.
            const accountWatermarks = new Map()
            for (const candidate of [...candidates].reverse())
                for (const account of candidate.meta.accounts ?? [])
                    accountWatermarks.set(account.email, { account, checkpoint: candidate.checkpoint })
            const checkpoint = Math.max(...candidates.map(candidate => candidate.checkpoint))
            const projection = createRunState({ accountEmails: [...this.configuredEmails] })
            const actions = [
                ...journal
                    .filter(entry => Number.isFinite(entry.id) && entry.id <= checkpoint)
                    .map(entry => ({
                        id: entry.id,
                        entry,
                        priority: 0
                    })),
                ...[...accountWatermarks.values()].map(saved => ({ id: saved.checkpoint, saved, priority: 1 }))
            ].sort((a, b) => a.id - b.id || a.priority - b.priority)
            let totalsCheckpoint = -1
            for (const action of actions) {
                if (action.entry) {
                    const previousTotals = projection.totals
                    applyLogToRunState(projection, action.entry)
                    if (projection.totals !== previousTotals) totalsCheckpoint = action.id
                } else
                    restoreRunSummary(
                        projection,
                        { accounts: [action.saved.account] },
                        { authoritative: true, accountsOnly: true }
                    )
            }
            const chronological = [...candidates].sort((a, b) => a.checkpoint - b.checkpoint)
            const knownRunFacts = Object.assign(
                {},
                ...chronological.map(candidate =>
                    Object.fromEntries(Object.entries(candidate.meta).filter(([, value]) => value != null))
                )
            )
            const totals =
                chronological.findLast(candidate => candidate.meta.totals && candidate.checkpoint >= totalsCheckpoint)
                    ?.meta.totals ??
                projection.totals ??
                null
            const mergedMeta = {
                ...knownRunFacts,
                runId,
                upstreamRunId,
                legacyRunId: legacyId,
                lastLogId: checkpoint,
                version: knownRunFacts.version ?? projection.version,
                clusters: knownRunFacts.clusters ?? projection.clusters,
                accountsTotal: knownRunFacts.accountsTotal ?? projection.accountsTotal,
                totals,
                finished:
                    Boolean(totals) || projection.finished || candidates.some(candidate => candidate.meta.finished),
                accounts: summarizeRunState(projection).accounts.map(accountCheckpoint)
            }
            for (const [name, contents] of [
                ['meta.json', JSON.stringify(mergedMeta, null, 2)],
                ['events.jsonl', journal.map(entry => JSON.stringify(entry)).join('\n') + '\n']
            ]) {
                const file = path.join(runDir, name)
                fs.writeFileSync(`${file}.tmp`, contents)
                fs.renameSync(`${file}.tmp`, file)
            }
            let archive = path.join(runDir, `legacy-${legacyId}`)
            for (let suffix = 1; fs.existsSync(archive); suffix++)
                archive = path.join(runDir, `legacy-${legacyId}-${suffix}`)
            fs.renameSync(legacyDir, archive)
        } else {
            fs.renameSync(legacyDir, runDir)
        }
        this.knownRuns.delete(legacyId)
        this.runsHistory = this.runsHistory.filter(item => item.runId !== legacyId)
        return legacyId
    }

    _openPersistence() {
        if (!this.runId) return
        const dir = path.join(this.runsDir, encodeURIComponent(this.runId))
        fs.mkdirSync(dir, { recursive: true })
        const eventsPath = path.join(dir, 'events.jsonl')
        const existed = fs.existsSync(eventsPath)
        // 监控服务重启会重放上游缓冲区，必须按日志 id 去重，否则同一轮事件会被写两遍。
        let lastId = 0
        let count = 0
        const events = []
        if (existed) {
            const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean)
            count = lines.length
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line)
                    events.push(parsed)
                    if (typeof parsed.id === 'number') lastId = Math.max(lastId, parsed.id)
                } catch {
                    /* 损坏行跳过 */
                }
            }
        }
        this.persist = {
            runDir: dir,
            events: null,
            eventsPath,
            count,
            lastId
        }
        return events
    }

    _persistEvent(entry) {
        if (!this.persist?.eventsPath) return
        // Append before publishing a new summary, so a monitor restart can
        // always rebuild the same projection without an open-stream flush race.
        fs.appendFileSync(this.persist.eventsPath, JSON.stringify({ ...entry, runId: this.runId }) + '\n')
        this.persist.count += 1
        if (typeof entry.id === 'number') this.persist.lastId = entry.id
    }

    _writeMeta() {
        if (!this.runId || !this.persist?.runDir) return
        const summary = summarizeRunState(this.runState)
        const meta = {
            runId: this.runId,
            legacyRunId: this.legacyRunId,
            upstreamRunId: this.upstreamRunId,
            selectedAccounts: this.selectedAccounts,
            startedAt: this.runStartedAt,
            endedAt: this.runEndedAt,
            exit: this.runExit,
            clusters: this.runState.clusters,
            version: this.runState.version,
            accountsTotal: this.runState.accountsTotal,
            totals: this.runState.totals,
            finished: this.runState.finished,
            logEvents: this.persist.count,
            lastLogId: Math.max(this.summaryCheckpointId ?? 0, this.persist.lastId ?? 0),
            source: 'control-api-logs',
            accounts: (summary.accounts ?? []).map(accountCheckpoint)
        }
        const file = path.join(this.persist.runDir, 'meta.json')
        const tmp = `${file}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(meta, null, 2))
        fs.renameSync(tmp, file)
        this.knownRuns.set(this.runId, meta)
    }

    _recordAccountEvent(entry, email) {
        if (!email) return
        const rec = this.perAccount.get(email) ?? { firstStartAt: null, lastEvent: null, workerPid: null }
        const title = entry.title ?? null
        const observedAt = entry.receivedAt ?? nowIso()

        if (title === 'ACCOUNT-START') {
            if (!rec.firstStartAt) rec.firstStartAt = parseLogTs(entry.ts) ?? Date.parse(observedAt)
            // clusters >= 账号数 时，worker 与账号是 1:1，映射可靠；否则不猜。
            const oneToOne =
                typeof this.runState.clusters === 'number' &&
                typeof this.runState.accountsTotal === 'number' &&
                this.runState.clusters >= this.runState.accountsTotal
            if (oneToOne && this.workerQueue.length) {
                rec.workerPid = this.workerQueue.shift()
            }
        }

        // 等待状态单独保存：否则等待期间只要再来一条心跳/调试日志，倒计时就会凭空消失
        const w = parseWait(entry.message)
        if (w) {
            const startMs = parseLogTs(entry.ts) ?? Date.parse(observedAt)
            const endsAt = new Date(startMs + (w.kind === 'countdown' ? w.seconds : w.maxSec) * 1000).toISOString()
            rec.wait = { ...w, startedAt: new Date(startMs).toISOString(), endsAt }
        } else if (rec.wait && Date.parse(observedAt) > Date.parse(rec.wait.endsAt) + 30000) {
            // 已经超过预计结束时间且出现了新事件，说明这一段等待早已过去
            rec.wait = null
        }

        if (entry.title && this.activityTitles.has(entry.title)) {
            const agg = (rec.activities ??= {})
            const hit = (agg[entry.title] ??= { count: 0, platform: null, lastAt: null })
            hit.count += 1
            hit.platform = entry.platform ?? hit.platform
            hit.lastAt = observedAt
        }

        rec.lastEvent = {
            id: entry.id,
            at: observedAt,
            logTs: entry.ts ?? null,
            level: entry.level,
            platform: entry.platform,
            title,
            message: entry.message,
            source: entry.source
        }
        this.perAccount.set(email, rec)
    }

    _ingest(entries, { persist = true, writeMeta = true } = {}) {
        let ingested = 0
        for (const entry of entries) {
            if (!this._belongsToRun(entry)) continue
            if (persist && Number.isFinite(entry.id) && entry.id <= (this.summaryCheckpointId ?? -1)) continue
            const key = Number.isFinite(entry.id) ? `id:${entry.id}` : JSON.stringify(entry)
            if (this.seenEvents?.has(key)) continue
            this.seenEvents?.add(key)
            ingested += 1
            // worker 任务声明先入队，供后续 ACCOUNT-START 归属
            if (entry.title === 'CLUSTER-WORKER-TASK') {
                const m = String(entry.message || '').match(WORKER_TASK_RE)
                if (m) this.workerQueue.push(Number(m[1]))
            }

            let email = this._accountFor(entry)
            if (entry.title === 'ACCOUNT-START') {
                const m = String(entry.message || '').match(ACCOUNT_START_RE)
                if (m) {
                    // ACCOUNT-START 的消息体里有完整邮箱，这是最可靠的来源
                    email = m[1]
                }
            }

            this.logs.push({ ...entry, email })
            if (this.logs.length > this.logCap) this.logs.splice(0, this.logs.length - this.logCap)

            applyLogToRunState(this.runState, { ...entry, email })
            this._recordAccountEvent(entry, email)
            if (persist) this._persistEvent({ ...entry, email })
        }
        this.lastIngestAt = nowIso()
        if (writeMeta && ingested && this.runId) this._writeMeta()
    }

    _belongsToRun(entry) {
        if (!this.runId) return false
        if (entry.runId)
            return entry.runId === this.runId || entry.runId === this.upstreamRunId || entry.runId === this.legacyRunId
        // Older APIs have no run id. Only a finite received-at window can
        // establish ownership; a logger timestamp without a zone cannot.
        const at = Date.parse(entry.receivedAt ?? '')
        const start = Date.parse(this.runStartedAt ?? '')
        const end = this.runEndedAt ? Date.parse(this.runEndedAt) : Infinity
        return Number.isFinite(at) && Number.isFinite(start) && at >= start && at <= end
    }

    _routeEntries(entries) {
        const current = []
        const otherRuns = new Map()
        for (const entry of entries) {
            if (this._belongsToRun(entry)) {
                current.push(entry)
                continue
            }
            const at = Date.parse(entry.receivedAt ?? '')
            const info = entry.runId
                ? this.knownRuns.get(entry.runId)
                : [...this.knownRuns.values()].find(r => {
                      const end = Date.parse(r.endedAt ?? '')
                      return Number.isFinite(at) && Number.isFinite(end) && at >= Date.parse(r.startedAt) && at <= end
                  })
            if (!info || info.runId === this.runId) continue
            const group = otherRuns.get(info.runId) ?? { info, entries: [] }
            group.entries.push(entry)
            otherRuns.set(info.runId, group)
        }
        for (const { info, entries: group } of otherRuns.values()) {
            // Delayed terminal facts belong to their original journal. Rebuild
            // that projection without replacing the currently displayed run.
            const previous = new RunTracker({
                control: this.control,
                configuredAccounts: this.configuredAccounts,
                logCap: this.logCap,
                runsDir: this.runsDir
            })
            previous._resetForRun(info.runId, info.startedAt, info)
            previous._ingest(group)
        }
        this._ingest(current)
    }

    async attach() {
        // Restore the local journal before applying the API's bounded tail.
        // Stable upstream ids fence batches; old APIs use received-at windows.
        const version = this.statusVersion
        const [all, history, fetchedStatus] = await Promise.all([
            this.control.logs({ afterId: 0 }),
            this.control.history({ limit: 5 }).catch(() => null),
            this.control.status().catch(() => null)
        ])
        const status = this.statusVersion === version ? fetchedStatus : this.status
        const list = all.logs ?? []

        const runs = history?.runs ?? []
        for (const item of runs) {
            const info = runInfo(item)
            if (info) this.knownRuns.set(info.runId, info)
        }
        const info =
            (status?.state !== 'idle' ? runInfo(status) : null) ??
            runInfo(status?.lastRun) ??
            runInfo(runs[0]) ??
            runInfo(this.runsHistory[0])
        if (info) {
            this._resetForRun(info.runId, info.startedAt, info)
        } else {
            this.logs = []
            this.runState = createRunState()
            this.perAccount = new Map()
            this.workerQueue = []
        }

        this._routeEntries(list)
        this.lastLogId = list.reduce((max, entry) => Math.max(max, entry.id ?? 0), 0)
        this.attached = true
        if (this.runId) this._writeMeta()
        return list.length
    }

    async pollStatus() {
        const sequence = ++this.statusPollSequence
        try {
            const status = await this.control.status()
            if (sequence !== this.statusPollSequence) return this.status
            this.status = status
            this.statusVersion += 1
            const lastRun = runInfo(status.lastRun)
            if (lastRun) this.knownRuns.set(lastRun.runId, lastRun)
            this.apiOnline = true
            this.apiError = null

            const health = await this.control.health().catch(() => null)
            if (sequence !== this.statusPollSequence) return this.status
            if (health && typeof health.uptimeSec === 'number') {
                if (this.apiUptime != null && health.uptimeSec < this.apiUptime) {
                    // API 重启：日志序号归零、上游状态清空，本地必须同步重置
                    this.lastLogId = 0
                    this.attached = false
                    this.logs = []
                }
                this.apiUptime = health.uptimeSec
            }

            const info = status.state === 'idle' ? status.lastRun : status
            const runId = info?.runId ?? (info?.startedAt ? String(info.startedAt).replace(/[:.]/g, '-') : null)
            if (runId && runId !== this.runId) {
                // 上一轮若未收尾，先落盘
                if (this.runId && !this.runEndedAt) {
                    const previous = this.knownRuns.get(this.runId)
                    this.runEndedAt = previous?.endedAt ?? status.lastExit?.at ?? nowIso()
                    this.runExit = previous?.exit ?? status.lastExit ?? null
                    this._writeMeta()
                }
                this._resetForRun(runId, info.startedAt, {
                    upstreamRunId: info.runId ?? null,
                    selectedAccounts: info.selectedAccounts,
                    endedAt: info.endedAt,
                    exit: info.exit
                })
            }

            if (status.state === 'idle' && this.runId && !this.runEndedAt) {
                this.runEndedAt = status.lastExit?.at ?? nowIso()
                this.runExit = status.lastExit ?? null
                this._writeMeta()
                this.loadHistory()
            }

            return status
        } catch (error) {
            if (sequence !== this.statusPollSequence) return this.status
            this.apiOnline = false
            this.apiError = error?.message ?? String(error)
            return null
        }
    }

    async pollLogs() {
        if (!this.apiOnline) return
        if (!this.attached) {
            await this.attach()
            return
        }
        const res = await this.control.logs({ afterId: this.lastLogId })
        const list = res.logs ?? []
        if (!list.length) return
        if (list.some(e => e.runId && e.runId !== this.runId && !this.knownRuns.has(e.runId))) {
            await this.pollStatus()
            const history = await this.control.history({ limit: 50 }).catch(() => null)
            for (const item of history?.runs ?? []) {
                const info = runInfo(item)
                if (info) this.knownRuns.set(info.runId, info)
            }
        }
        this._routeEntries(list)
        this.lastLogId = list.reduce((max, entry) => Math.max(max, entry.id ?? 0), this.lastLogId)
    }

    _statusFor(email) {
        const acc = this.runState.accounts?.[email] ?? null
        const rec = this.perAccount.get(email) ?? null
        const runActive = this.status?.state && this.status.state !== 'idle'
        const started = Boolean(rec?.firstStartAt)

        if (acc?.error) return ACCOUNT_STATUS.FAILED
        if (acc && acc.success === true) return ACCOUNT_STATUS.COMPLETED
        if (acc && acc.success === false) return ACCOUNT_STATUS.FAILED

        if (runActive) {
            if (!started) {
                if (!this.selectedAccounts) return ACCOUNT_STATUS.UNKNOWN
                return this.selectedAccounts.some(a => a.email === email)
                    ? ACCOUNT_STATUS.WAITING
                    : ACCOUNT_STATUS.NOT_RUN
            }
            const elapsed = Date.now() - (rec.firstStartAt ?? Date.now())
            const advanced = rec.lastEvent && rec.lastEvent.title !== 'ACCOUNT-START'
            if (!advanced && elapsed < 20000) return ACCOUNT_STATUS.STARTING
            return ACCOUNT_STATUS.RUNNING
        }

        if (started && !runActive) {
            // 运行已结束却没有终态事件：如果中途被停止，就是"已停止"，
            // 否则无法判断，如实标为未知。
            if (this.runExit?.signal) return ACCOUNT_STATUS.STOPPED
            if (this.runExit?.code != null && this.runExit.code !== 0) return ACCOUNT_STATUS.STOPPED
            return ACCOUNT_STATUS.UNKNOWN
        }
        return ACCOUNT_STATUS.NOT_RUN
    }

    deriveAccounts(accountsPayload) {
        const configured = accountsPayload?.accounts ?? this.configuredAccounts ?? []
        const history = accountHistory(this.historyStore.read(), { now: this.now() })
        return configured.map(a => {
            const email = a.email
            const rec = this.perAccount.get(email) ?? null
            const acc = this.runState.accounts?.[email] ?? null
            const currentRunStatus = this._statusFor(email)
            const includedInCurrentRun = this.selectedAccounts
                ? this.selectedAccounts.some(account => account.email === email)
                : acc || rec
                  ? true
                  : null
            const saved = history.get(email)
            const todayResult = saved?.today ?? null
            const showToday =
                todayResult &&
                includedInCurrentRun !== true &&
                (currentRunStatus === ACCOUNT_STATUS.NOT_RUN || !this.runId)
            const status = showToday ? todayResult.status : currentRunStatus
            const statusScope = showToday
                ? 'today'
                : includedInCurrentRun === true || currentRunStatus !== ACCOUNT_STATUS.NOT_RUN
                  ? 'current-run'
                  : 'none'
            const upstreamAt = Date.parse(a.lastRunAt ?? '')
            const upstreamConfirmed = typeof a.lastSuccess === 'boolean' || Boolean(a.lastError)
            const latest =
                saved?.latest &&
                (!upstreamConfirmed || !Number.isFinite(upstreamAt) || Date.parse(saved.latest.at) >= upstreamAt)
                    ? saved.latest
                    : null
            const running = currentRunStatus === ACCOUNT_STATUS.RUNNING || currentRunStatus === ACCOUNT_STATUS.STARTING

            const startedAt = rec?.firstStartAt ? new Date(rec.firstStartAt).toISOString() : null
            let durationSec = null
            if (acc?.durationSeconds != null) durationSec = acc.durationSeconds
            else if (running && rec?.firstStartAt) durationSec = Math.floor((Date.now() - rec.firstStartAt) / 1000)

            return {
                index: a.index,
                email,
                status,
                statusKnown: status !== ACCOUNT_STATUS.UNKNOWN,
                currentRunStatus,
                includedInCurrentRun,
                statusScope,
                statusAt: showToday
                    ? todayResult.at
                    : statusScope === 'current-run'
                      ? (rec?.lastEvent?.at ?? this.runEndedAt ?? this.runStartedAt)
                      : null,
                todayStatus: todayResult?.status ?? null,
                todayResult,
                currentTask: rec?.lastEvent
                    ? {
                          title: rec.lastEvent.title,
                          message: rec.lastEvent.message,
                          at: rec.lastEvent.at,
                          platform: rec.lastEvent.platform,
                          level: rec.lastEvent.level
                      }
                    : null,
                workerPid: rec?.workerPid ?? null,
                activities: rec?.activities ?? {},
                ...(() => {
                    const localpart = String(email).split('@')[0]
                    const bucket = this.userKeyToEmails.get(localpart)
                    const prefixAmbiguous = Boolean(bucket && bucket.size > 1)
                    const reliable = !prefixAmbiguous || this.seenFullEmailIds.has(email)
                    return {
                        attributionReliable: reliable,
                        attributionNote: reliable
                            ? null
                            : '该批次日志只带邮箱前缀，与另一同前缀账号无法区分；已停止归属而非猜测'
                    }
                })(),
                wait: (() => {
                    const w = rec?.wait
                    if (!w) return null
                    // 超过预计结束时间 30 秒仍未继续，就不再显示倒计时（可能卡住或事件缺失）
                    if (Date.parse(w.endsAt) < Date.now() - 30000) return null
                    return {
                        kind: w.kind,
                        label: w.label,
                        startedAt: w.startedAt,
                        endsAt: w.endsAt,
                        totalSec: w.kind === 'countdown' ? w.seconds : null,
                        minSec: w.minSec ?? null,
                        maxSec: w.maxSec ?? null
                    }
                })(),
                startedAt,
                durationSec,
                collectedThisRun: observedCollected(acc),
                balance: acc?.live?.balance ?? acc?.finalPoints ?? null,
                initialPoints: acc?.initialPoints ?? null,
                earnable: acc?.earnable ?? null,
                searchSummary: acc?.searchSummary ?? null,
                lastSuccess: latest ? latest.success : (a.lastSuccess ?? null),
                lastRunAt: latest?.at ?? a.lastRunAt ?? null,
                lastCollected: latest ? latest.collected : (a.lastCollected ?? null),
                lastError: acc?.error ?? (latest ? latest.error : (a.lastError ?? null)),
                error: acc?.error ?? null,
                hasTotp: a.hasTotp ?? null,
                geoLocale: a.geoLocale ?? null,
                langCode: a.langCode ?? null,
                durationSource: acc?.durationSeconds != null ? 'api' : running ? 'computed' : null,
                dataSource: 'control-api:/accounts + /logs'
            }
        })
    }

    getRunView() {
        const summary = summarizeRunState(this.runState)
        return {
            runId: this.runId,
            upstreamRunId: this.upstreamRunId,
            selectedAccounts: this.selectedAccounts,
            excludedAccounts: this.selectedAccounts
                ? (this.configuredAccounts ?? [])
                      .filter(a => !this.selectedAccounts.some(s => s.email === a.email))
                      .map(a => ({ index: a.index, email: a.email }))
                : null,
            logStreamAvailable: this.status?.logStreamAvailable !== false,
            startedAt: this.runStartedAt,
            endedAt: this.runEndedAt,
            exit: this.runExit,
            state: this.status?.state ?? 'unknown',
            pid: this.status?.pid ?? null,
            clusters: this.runState.clusters ?? null,
            version: this.runState.version ?? null,
            accountsTotal: this.runState.accountsTotal ?? null,
            accountsSeen: summary.accountsSeen ?? null,
            totals: this.runState.totals ?? null,
            finished: this.runState.finished ?? null,
            // 上游的 currentAccount 是单值，并行时会误导，单独暴露并标注
            upstreamCurrentAccount: summary.live?.currentAccount ?? null,
            upstreamCurrentAccountReliable: typeof this.runState.clusters === 'number' && this.runState.clusters <= 1,
            logEventCount: this.persist.count ?? 0,
            ambiguousAttributions: this.ambiguousAttributions,
            exitInfo: this.status?.lastExit ?? null
        }
    }

    getLogsSince(afterId = 0, { limit = 400 } = {}) {
        const list = this.logs.filter(e => (e.id ?? 0) > afterId)
        return list.slice(-limit)
    }
}
