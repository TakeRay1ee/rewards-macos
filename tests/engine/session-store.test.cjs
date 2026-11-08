const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { loadSource } = require('./source-loader.cjs')

test('session store waits for a transient initialization lock and retains account isolation', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-test-sessions-'))
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(path.join(temp, 'sessions.db'))
    db.exec('CREATE TABLE setup(n INTEGER)')
    db.close()
    const child = spawn(
        process.execPath,
        [
            '-e',
            `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN EXCLUSIVE');process.stdout.write('locked\\n');setTimeout(()=>{db.exec('ROLLBACK');db.close()},200)`,
            path.join(temp, 'sessions.db')
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const exited = new Promise(resolve => child.once('exit', resolve))
    await new Promise((resolve, reject) => {
        child.stdout.once('data', resolve)
        child.once('error', reject)
    })
    const store = loadSource('src/util/SessionStore.ts')
    try {
        assert.doesNotThrow(() => store.saveStorageState(temp, 'a@example.invalid', true, { cookies: [], origins: [] }))
        store.saveStorageState(temp, 'b@example.invalid', false, {
            cookies: [],
            origins: [{ origin: 'https://example.invalid', localStorage: [{ name: 'id', value: 'B' }] }]
        })
        assert.equal(store.loadSession(temp, 'a@example.invalid', true).storageState.origins.length, 0)
        assert.equal(
            store.loadSession(temp, 'b@example.invalid', false).storageState.origins[0].localStorage[0].value,
            'B'
        )
        assert.equal(store.loadSession(temp, 'b@example.invalid', true), null)
    } finally {
        await exited
        store.closeSessionStore()
        fs.rmSync(temp, { recursive: true, force: true })
    }
})

test('failed initialization closes the connection and a later call retries the complete schema', () => {
    let opens = 0,
        closed = 0
    class DatabaseSync {
        constructor() {
            this.id = ++opens
            this.timeout = false
            this.schema = false
        }
        exec(sql) {
            if (sql.includes('busy_timeout')) this.timeout = true
            if (sql.includes('journal_mode') && this.id === 1) throw new Error('synthetic lock')
            if (sql.includes('CREATE TABLE')) this.schema = true
        }
        prepare() {
            assert.equal(this.schema, true)
            return { get: () => undefined }
        }
        close() {
            closed++
        }
    }
    const store = loadSource('src/util/SessionStore.ts', {
        'node:sqlite': { DatabaseSync },
        'node:fs': { mkdirSync() {}, chmodSync() {} }
    })
    assert.throws(() => store.loadSession('/mock', 'a@example.invalid', true), /synthetic lock/)
    assert.equal(store.loadSession('/mock', 'a@example.invalid', true), null)
    assert.equal(opens, 2)
    assert.equal(closed, 1)
    store.closeSessionStore()
})

test('an immediate SQLite busy response retries initialization on a fresh connection', () => {
    let opens = 0,
        closed = 0
    class DatabaseSync {
        constructor() {
            this.id = ++opens
            this.schema = false
        }
        exec(sql) {
            if (sql.includes('journal_mode') && this.id === 1) {
                const error = new Error('database is locked')
                error.errcode = 5
                throw error
            }
            if (sql.includes('CREATE TABLE')) this.schema = true
        }
        prepare() {
            assert.equal(this.schema, true)
            return { get: () => undefined }
        }
        close() {
            closed++
        }
    }
    const store = loadSource('src/util/SessionStore.ts', {
        'node:sqlite': { DatabaseSync },
        'node:fs': { mkdirSync() {}, chmodSync() {} }
    })
    assert.equal(store.loadSession('/mock', 'a@example.invalid', true), null)
    assert.equal(opens, 2)
    assert.equal(closed, 1)
    store.closeSessionStore()
})
