import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

// PID alone is unsafe after a controller restart: include native process birth time,
// process group and a command digest before allowing any signal to a recovered run.
export function processIdentity(pid) {
    if (!Number.isSafeInteger(pid) || pid < 2) return null
    try {
        const output = execFileSync(
            '/bin/ps',
            ['-p', String(pid), '-o', 'lstart=', '-o', 'pgid=', '-o', 'stat=', '-o', 'command='],
            {
                encoding: 'utf8',
                timeout: 1500,
                stdio: ['ignore', 'pipe', 'ignore'],
                env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }
            }
        ).trim()
        const match = output.match(
            /^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s+(\S+)\s+([\s\S]+)$/
        )
        if (!match || match[3].startsWith('Z')) return null
        return {
            pid,
            birth: match[1].replace(/\s+/g, ' '),
            pgid: Number(match[2]),
            commandHash: crypto.createHash('sha256').update(match[4]).digest('hex')
        }
    } catch {
        return null
    }
}

export function identityStatus(identity) {
    if (!identity) return 'unknown'
    const current = processIdentity(identity.pid)
    if (!current) {
        try {
            process.kill(identity.pid, 0)
            return 'unknown'
        } catch (error) {
            return error.code === 'ESRCH' ? 'gone' : 'unknown'
        }
    }
    return current.birth === identity.birth &&
        current.pgid === identity.pgid &&
        current.commandHash === identity.commandHash
        ? 'same'
        : 'reused'
}

function busy(message, code = 'ALREADY_RUNNING') {
    return Object.assign(new Error(message), { code })
}

function initializeDatabase(db) {
    const deadline = Date.now() + 5000
    for (;;) {
        try {
            db.exec('PRAGMA journal_mode = WAL')
            db.exec('PRAGMA synchronous = FULL')
            db.exec(`
                CREATE TABLE IF NOT EXISTS active_run (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS run_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS run_logs (seq INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS run_requests (request_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            `)
            return
        } catch (error) {
            // SQLite may fail a simultaneous journal-mode change without honoring
            // busy_timeout. Retry only lock contention; preserve all other errors.
            if (![5, 6].includes(error.errcode) || Date.now() >= deadline) throw error
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
        }
    }
}

export class RunIdentityStore {
    constructor(file, { logBufferSize = 2000, historySize = 20 } = {}) {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
        this.db = new DatabaseSync(file)
        // Set the timeout before any schema/journal operation so concurrent API startups wait.
        this.db.exec('PRAGMA busy_timeout = 5000')
        initializeDatabase(this.db)
        this.logBufferSize = logBufferSize
        this.historySize = historySize
    }

    readActive() {
        const row = this.db.prepare('SELECT payload FROM active_run WHERE id=1').get()
        return row ? JSON.parse(row.payload) : null
    }

    reserve(snapshot) {
        this.db.exec('BEGIN IMMEDIATE')
        try {
            if (snapshot.requestId) {
                const duplicate = this.request(snapshot.requestId)
                if (duplicate) {
                    this.db.exec('COMMIT')
                    return duplicate
                }
            }
            const active = this.readActive()
            if (active) {
                const status = identityStatus(active.processIdentity)
                const ownerStatus = active.ownerIdentity ? identityStatus(active.ownerIdentity) : 'gone'
                // A live owner may still be draining inherited stdout/stderr
                // after the worker exited. Let it archive the exact result.
                if (
                    active.pid &&
                    (status === 'gone' || status === 'reused') &&
                    ['gone', 'reused'].includes(ownerStatus)
                ) {
                    this._archive({
                        runId: active.runId,
                        selectedAccounts: active.selectedAccounts ?? null,
                        startedAt: active.startedAt,
                        endedAt: new Date().toISOString(),
                        exit: {
                            code: null,
                            signal: null,
                            error: 'Previous process exited while API was unavailable; exit status unknown.'
                        },
                        run: active.summary
                    })
                } else {
                    throw busy(
                        active.pid
                            ? 'Cannot start: a persisted run is still active or its identity cannot be verified.'
                            : 'Cannot start: an earlier startup reservation requires recovery.',
                        active.pid ? 'ALREADY_RUNNING' : 'RECOVERY_REQUIRED'
                    )
                }
            }
            this.db.prepare('INSERT OR REPLACE INTO active_run(id,payload) VALUES(1,?)').run(JSON.stringify(snapshot))
            if (snapshot.requestId) {
                this.db.prepare('INSERT INTO run_requests(request_id,payload) VALUES(?,?)').run(
                    snapshot.requestId,
                    JSON.stringify({
                        runId: snapshot.runId,
                        startedAt: snapshot.startedAt,
                        selectedAccounts: snapshot.selectedAccounts,
                        pid: null
                    })
                )
            }
            this.db.exec('COMMIT')
            return null
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }

    save(snapshot) {
        this.db
            .prepare("UPDATE active_run SET payload=? WHERE id=1 AND json_extract(payload,'$.runId')=?")
            .run(JSON.stringify(snapshot), snapshot.runId)
        if (snapshot.requestId) {
            this.db.prepare('UPDATE run_requests SET payload=? WHERE request_id=?').run(
                JSON.stringify({
                    runId: snapshot.runId,
                    startedAt: snapshot.startedAt,
                    selectedAccounts: snapshot.selectedAccounts,
                    pid: snapshot.pid
                }),
                snapshot.requestId
            )
        }
    }

    request(requestId) {
        const row = this.db.prepare('SELECT payload FROM run_requests WHERE request_id=?').get(requestId)
        return row ? JSON.parse(row.payload) : null
    }

    _archive(history) {
        this.db
            .prepare('INSERT OR IGNORE INTO run_history(run_id,payload) VALUES(?,?)')
            .run(history.runId, JSON.stringify(history))
        this.db
            .prepare('DELETE FROM run_history WHERE seq NOT IN (SELECT seq FROM run_history ORDER BY seq DESC LIMIT ?)')
            .run(this.historySize)
    }

    finish(history) {
        this.db.exec('BEGIN IMMEDIATE')
        try {
            this._archive(history)
            this.db
                .prepare("DELETE FROM active_run WHERE id=1 AND json_extract(payload,'$.runId')=?")
                .run(history.runId)
            this.db.exec('COMMIT')
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }

    append(entry) {
        const id = Number(
            this.db.prepare('INSERT INTO run_logs(payload) VALUES(?)').run(JSON.stringify(entry)).lastInsertRowid
        )
        this.db.prepare('DELETE FROM run_logs WHERE seq <= ?').run(id - this.logBufferSize)
        return id
    }

    logs() {
        return this.db
            .prepare('SELECT seq,payload FROM run_logs ORDER BY seq')
            .all()
            .map(row => ({ ...JSON.parse(row.payload), id: Number(row.seq) }))
    }

    history() {
        return this.db
            .prepare('SELECT payload FROM run_history ORDER BY seq DESC LIMIT ?')
            .all(this.historySize)
            .map(row => JSON.parse(row.payload))
    }
}
