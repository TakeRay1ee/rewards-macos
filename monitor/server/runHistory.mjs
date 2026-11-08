import fs from 'node:fs'
import path from 'node:path'
import { calendarDate, REWARDS_TIME_ZONE } from './calendar.mjs'

// A durable history reader owns discovery and invalidation. A new/changed/deleted
// summary becomes visible on the next read, including delayed old-run facts.
// Copies are not added together here: overlapping event journals must be
// reconciled by RunTracker before a numeric total can be trusted.
export class RunHistoryStore {
    constructor(runsDir) {
        this.runsDir = runsDir
        this.cache = new Map()
    }

    read() {
        let names
        try {
            names = fs.readdirSync(this.runsDir)
        } catch {
            this.cache.clear()
            return []
        }
        const present = new Set()
        for (const name of names) {
            const file = path.join(this.runsDir, name, 'meta.json')
            try {
                const stat = fs.statSync(file)
                const signature = `${stat.ino}:${stat.mtimeMs}:${stat.size}`
                present.add(file)
                if (this.cache.get(file)?.signature === signature) continue
                const meta = JSON.parse(fs.readFileSync(file, 'utf8'))
                if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
                    this.cache.delete(file)
                    continue
                }
                this.cache.set(file, { signature, meta })
            } catch {
                this.cache.delete(file)
            }
        }
        for (const file of this.cache.keys()) if (!present.has(file)) this.cache.delete(file)
        return [...this.cache.values()]
            .map(value => value.meta)
            .sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')))
    }
}

export function readRunMetas(runsDir) {
    return new RunHistoryStore(runsDir).read()
}

export function accountResultAt(meta, account) {
    const values = [account.terminalAt, account.live?.lastUpdateTs, meta.endedAt, meta.startedAt]
    return values.find(value => typeof value === 'string' && Number.isFinite(Date.parse(value))) ?? null
}

// Current-batch participation and daily completion answer different questions.
// Keep the durable account history behind this interface so callers cannot
// mistake absence from a single-account retry for absence from today's work.
export function accountHistory(metas, { now = new Date(), timeZone = REWARDS_TIME_ZONE } = {}) {
    const today = calendarDate(now, { timeZone })
    const byEmail = new Map()
    for (const meta of metas) {
        if (!meta || typeof meta !== 'object') continue
        for (const account of Array.isArray(meta.accounts) ? meta.accounts : []) {
            if (!account || typeof account !== 'object') continue
            if (typeof account.email !== 'string' || !account.email.includes('@')) continue
            const at = accountResultAt(meta, account)
            if (!at) continue
            const status =
                account.error || account.success === false ? 'failed' : account.success === true ? 'completed' : null
            const result = {
                status,
                success: status === 'completed' ? true : status === 'failed' ? false : null,
                at,
                runId: meta.upstreamRunId ?? meta.runId ?? null,
                collected: Number.isFinite(account.collected) ? account.collected : null,
                error: account.error ?? null
            }
            const previous = byEmail.get(account.email) ?? { latest: null, today: null }
            // A partial/empty account projection is not a later result. It
            // must not erase a confirmed completion retained from an older run.
            if (status && (!previous.latest || Date.parse(at) >= Date.parse(previous.latest.at)))
                previous.latest = result
            if (
                status &&
                calendarDate(at, { timeZone }) === today &&
                (!previous.today || Date.parse(at) >= Date.parse(previous.today.at))
            )
                previous.today = result
            byEmail.set(account.email, previous)
        }
    }
    return byEmail
}
