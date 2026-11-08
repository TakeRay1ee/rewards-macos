// A single SQLite row owns the scheduler lock. Short transactions make check,
// reclaim and release atomic across processes; process identity fences PID reuse.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { processIdentity, identityStatus } from '../../scripts/api/runIdentity.js'

function legacyStatus(record, inspect) {
    if (record?.ownerIdentity) return inspect(record.ownerIdentity)
    if (!Number.isSafeInteger(record?.pid) || record.pid < 2) return 'unknown'
    try {
        process.kill(record.pid, 0)
        return 'unknown'
    } catch (error) {
        return error.code === 'ESRCH' ? 'gone' : 'unknown'
    }
}

function transaction(file, fn) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    try {
        db.exec('PRAGMA busy_timeout = 5000')
        db.exec('BEGIN IMMEDIATE')
        db.exec(
            'CREATE TABLE IF NOT EXISTS schedule_lock (id INTEGER PRIMARY KEY CHECK(id = 1), token TEXT NOT NULL, owner TEXT NOT NULL)'
        )
        const result = fn(db)
        db.exec('COMMIT')
        return result
    } catch (error) {
        try {
            db.exec('ROLLBACK')
        } catch {
            /* No active transaction */
        }
        throw error
    } finally {
        db.close()
    }
}

export function acquireSchedulerLock(lockFile, adapters = {}) {
    const capture = adapters.processIdentity ?? processIdentity
    const inspect = adapters.identityStatus ?? identityStatus
    const ownerIdentity = capture(process.pid)
    if (!ownerIdentity) return { ok: false, lockFile, reason: '无法确认调度进程身份，未取得调度锁' }
    const databaseFile = `${lockFile}.sqlite3`
    try {
        return transaction(databaseFile, db => {
            // Older releases wrote this JSON file. A live or unidentifiable
            // old owner must finish before the new SQLite lock may be used.
            if (fs.existsSync(lockFile)) {
                let legacy = null
                try {
                    legacy = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
                } catch {
                    /* Unknown legacy owner */
                }
                if (!['gone', 'reused'].includes(legacyStatus(legacy, inspect))) {
                    return {
                        ok: false,
                        lockFile,
                        databaseFile,
                        reason: '旧调度锁的拥有者仍存活或身份无法确认，请检查后恢复'
                    }
                }
                fs.unlinkSync(lockFile)
            }
            const existing = db.prepare('SELECT token, owner FROM schedule_lock WHERE id = 1').get()
            if (existing) {
                let owner = null
                try {
                    owner = JSON.parse(existing.owner)
                } catch {
                    /* Invalid owner stays fenced */
                }
                if (!['gone', 'reused'].includes(inspect(owner))) {
                    return { ok: false, lockFile, databaseFile, reason: '已有调度进程持有锁，或其身份暂时无法确认' }
                }
                db.prepare('DELETE FROM schedule_lock WHERE id = 1 AND token = ?').run(existing.token)
            }
            const token = crypto.randomUUID()
            db.prepare('INSERT INTO schedule_lock (id, token, owner) VALUES (1, ?, ?)').run(
                token,
                JSON.stringify(ownerIdentity)
            )
            return { ok: true, lockFile, databaseFile, token, pid: process.pid }
        })
    } catch (error) {
        return { ok: false, lockFile, databaseFile, reason: `无法取得调度锁：${error.message}` }
    }
}

export function releaseSchedulerLock(lock) {
    if (!lock?.ok || !lock.token || !lock.databaseFile || !fs.existsSync(lock.databaseFile)) return false
    return transaction(
        lock.databaseFile,
        db => Number(db.prepare('DELETE FROM schedule_lock WHERE id = 1 AND token = ?').run(lock.token).changes) === 1
    )
}
