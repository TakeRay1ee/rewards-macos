import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RunTracker } from '../../monitor/server/runTracker.mjs'
import { accountHistory, RunHistoryStore, readRunMetas } from '../../monitor/server/runHistory.mjs'

const accounts = [1, 2, 3].map(index => ({ index, email: `same@account${index}.invalid` }))
const priorStarted = '2026-11-07T16:28:00.000Z'
const priorEnded = '2026-11-08T02:00:00.000Z'
const current = {
    runId: 'current-single-account',
    startedAt: '2026-11-08T03:00:00.000Z',
    selectedAccounts: [accounts[0]],
    state: 'running'
}

function fixture(t, priorAccounts) {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-account-history-'))
    const write = (name, meta) => {
        const dir = path.join(runsDir, name)
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, 'meta.json')
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(meta))
        fs.renameSync(`${file}.tmp`, file)
    }
    const prior = {
        runId: 'prior-all-accounts',
        startedAt: priorStarted,
        endedAt: priorEnded,
        selectedAccounts: accounts,
        accounts: priorAccounts,
        exit: { code: 0, signal: null, at: priorEnded }
    }
    write(prior.runId, prior)
    const api = {
        status: current,
        logs: [
            {
                runId: current.runId,
                id: 1,
                user: accounts[0].email,
                title: 'ACCOUNT-START',
                message: `开始处理账户: ${accounts[0].email} | geoLocale: CN`,
                receivedAt: '2026-11-08T03:00:01.000Z',
                level: 'info'
            }
        ],
        history: []
    }
    let now = new Date('2026-11-08T04:00:00.000Z')
    const create = () =>
        new RunTracker({
            runsDir,
            configuredAccounts: accounts,
            logCap: 100,
            now: () => now,
            control: {
                status: async () => api.status,
                health: async () => ({ uptimeSec: 10 }),
                logs: async ({ afterId = 0 } = {}) => ({ logs: api.logs.filter(log => log.id > afterId) }),
                history: async () => ({ runs: api.history })
            }
        })
    t.after(() => fs.rmSync(runsDir, { recursive: true, force: true }))
    return { runsDir, write, create, api, prior, setNow: value => (now = new Date(value)) }
}

test('a single-account retry retains other accounts confirmed today across restart without crediting the current batch', async t => {
    const fx = fixture(
        t,
        accounts.map((account, index) => ({ ...account, success: true, collected: index === 2 ? 0 : 20 }))
    )
    for (let attempt = 0; attempt < 2; attempt++) {
        const tracker = fx.create()
        await tracker.pollStatus()
        await tracker.pollLogs()
        const rows = tracker.deriveAccounts({ accounts })
        assert.equal(rows[0].includedInCurrentRun, true)
        assert.equal(rows[0].statusScope, 'current-run')
        assert.ok(['running', 'starting'].includes(rows[0].status))
        for (const row of rows.slice(1)) {
            assert.equal(row.status, 'completed')
            assert.equal(row.currentRunStatus, 'not_run')
            assert.equal(row.includedInCurrentRun, false)
            assert.equal(row.statusScope, 'today')
            assert.equal(row.statusAt, priorEnded)
            assert.equal(row.todayStatus, 'completed')
            assert.equal(row.lastSuccess, true)
            assert.equal(row.lastRunAt, priorEnded)
            assert.equal(row.collectedThisRun, null)
            assert.equal(row.currentTask, null)
            assert.equal(row.wait, null)
        }
        assert.equal(rows[2].lastCollected, 0)
    }
    fx.setNow('2026-11-08T16:00:00.000Z') // Shanghai midnight, independently from process TZ.
    const nextDay = fx.create()
    await nextDay.pollStatus()
    await nextDay.pollLogs()
    const row = nextDay.deriveAccounts()[1]
    assert.equal(row.status, 'not_run')
    assert.equal(row.statusScope, 'none')
    assert.equal(row.todayStatus, null)
    assert.equal(row.lastSuccess, true)
    assert.equal(row.lastRunAt, priorEnded)
})

test('selected waiting accounts keep current-batch status even after an earlier successful daily run', async t => {
    const fx = fixture(
        t,
        accounts.map(account => ({ ...account, success: true, collected: 10 }))
    )
    fx.api.status = { ...current, selectedAccounts: accounts }
    fx.api.logs = []
    const tracker = fx.create()
    await tracker.pollStatus()
    await tracker.pollLogs()
    for (const row of tracker.deriveAccounts()) {
        assert.equal(row.status, 'waiting')
        assert.equal(row.currentRunStatus, 'waiting')
        assert.equal(row.includedInCurrentRun, true)
        assert.equal(row.statusScope, 'current-run')
        assert.equal(row.todayStatus, 'completed')
    }
})

test('delayed old-run metadata updates excluded account results immediately without switching the current batch', async t => {
    const fx = fixture(t, [
        { ...accounts[1], success: null, collected: null },
        { ...accounts[2], success: false, collected: 0, error: 'synthetic activity failure' }
    ])
    const tracker = fx.create()
    await tracker.pollStatus()
    await tracker.pollLogs()
    let rows = tracker.deriveAccounts()
    assert.equal(rows[1].status, 'not_run')
    assert.equal(rows[1].lastSuccess, null)
    assert.equal(rows[1].lastCollected, null)
    assert.equal(rows[2].status, 'failed')
    assert.equal(rows[2].statusScope, 'today')
    assert.equal(rows[2].currentRunStatus, 'not_run')
    assert.equal(rows[2].lastCollected, 0)
    fx.write(fx.prior.runId, {
        ...fx.prior,
        accounts: [
            { ...accounts[1], success: true, collected: 42 },
            { ...accounts[2], success: true, collected: 74 }
        ]
    })
    rows = tracker.deriveAccounts()
    assert.equal(rows[1].status, 'completed')
    assert.equal(rows[1].lastCollected, 42)
    assert.equal(rows[2].status, 'completed')
    assert.equal(rows[2].lastCollected, 74)
    assert.equal(rows[2].lastError, null)
    assert.equal(tracker.getRunView().runId, current.runId)
    assert.equal(rows[1].collectedThisRun, null)
    fs.rmSync(path.join(fx.runsDir, fx.prior.runId), { recursive: true })
    rows = tracker.deriveAccounts()
    assert.equal(rows[1].status, 'not_run')
    assert.equal(rows[1].lastSuccess, null)
})

test('the shared history reader discovers new summaries, ignores damaged files and invalidates deleted or replaced summaries', t => {
    const fx = fixture(t, [])
    const reader = new RunHistoryStore(fx.runsDir)
    assert.equal(reader.read().length, 1)
    fx.write('second', { runId: 'second', startedAt: current.startedAt, accounts: [] })
    const bad = path.join(fx.runsDir, 'bad')
    fs.mkdirSync(bad)
    fs.writeFileSync(path.join(bad, 'meta.json'), '{truncated')
    assert.equal(reader.read().length, 2)
    fx.write('second', { runId: 'second', startedAt: current.startedAt, accounts: [], finished: true })
    assert.equal(reader.read()[1].finished, true)
    fs.rmSync(path.join(fx.runsDir, fx.prior.runId), { recursive: true })
    assert.equal(reader.read().length, 1)
    assert.deepEqual(reader.read(), readRunMetas(fx.runsDir))
})

test('newer unselected placeholders and damaged account rows cannot erase an older confirmed result', async t => {
    const fx = fixture(t, [{ ...accounts[1], success: true, collected: 42 }])
    fx.setNow('2026-11-09T03:00:00.000Z')
    fx.write('newer-placeholder', {
        runId: 'newer-placeholder',
        startedAt: '2026-11-09T02:00:00.000Z',
        endedAt: '2026-11-09T02:01:00.000Z',
        selectedAccounts: [accounts[0]],
        accounts: [null, 3, { ...accounts[1], success: null, collected: null }]
    })
    const tracker = fx.create()
    await tracker.pollStatus()
    await tracker.pollLogs()
    const rows = tracker.deriveAccounts({
        accounts: accounts.map(account => ({
            ...account,
            lastRunAt: '2026-11-09T02:01:00.000Z',
            lastSuccess: null,
            lastCollected: null
        }))
    })
    assert.equal(rows[1].status, 'not_run')
    assert.equal(rows[1].todayStatus, null)
    assert.equal(rows[1].lastSuccess, true)
    assert.equal(rows[1].lastCollected, 42)
    assert.equal(rows[1].lastRunAt, priorEnded)
})

test('cross-midnight errors keep their terminal date through journal replay and a legacy summary without terminalAt', async t => {
    const fx = fixture(t, [])
    const startedAt = '2026-11-08T15:58:00.000Z'
    const endedAt = '2026-11-08T16:02:00.000Z'
    const terminalAt = '2026-11-08T16:01:00.000Z'
    const lastRun = { ...current, startedAt, endedAt, exit: { code: 1, signal: null, at: endedAt } }
    fx.api.status = { state: 'idle', lastRun, lastExit: lastRun.exit }
    fx.api.logs = [
        { ...fx.api.logs[0], receivedAt: startedAt, parsed: true },
        {
            runId: current.runId,
            id: 2,
            user: accounts[0].email,
            parsed: true,
            level: 'info',
            title: 'SEARCH-BING',
            message: '开始必应搜索 | 当前余额=100',
            receivedAt: '2026-11-08T15:59:00.000Z'
        },
        {
            runId: current.runId,
            id: 3,
            user: accounts[0].email,
            parsed: true,
            level: 'error',
            title: 'ACCOUNT-ERROR',
            message: `${accounts[0].email} | 错误=synthetic failure after midnight`,
            receivedAt: terminalAt
        }
    ]
    fx.setNow('2026-11-08T16:03:00.000Z')
    const first = fx.create()
    await first.pollStatus()
    await first.pollLogs()
    const file = path.join(fx.runsDir, current.runId, 'meta.json')
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(meta.accounts[0].terminalAt, terminalAt)
    delete meta.accounts[0].terminalAt
    fx.write(current.runId, meta)
    const restored = fx.create()
    await restored.pollStatus()
    await restored.pollLogs()
    const row = restored.deriveAccounts()[0]
    assert.equal(row.todayStatus, 'failed')
    assert.equal(row.todayResult.at, terminalAt)
    assert.equal(restored.runState.accounts[accounts[0].email].live.lastUpdateTs, '2026-11-08T15:59:00.000Z')
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).accounts[0].terminalAt, terminalAt)
})

test('a confirmed completion before midnight does not move to the next day when the batch or later balance observation ends later', () => {
    const terminalAt = '2026-11-08T15:59:00.000Z'
    const meta = {
        runId: 'batch-crosses-midnight',
        startedAt: '2026-11-08T15:58:00.000Z',
        endedAt: '2026-11-08T16:02:00.000Z',
        accounts: [
            {
                email: accounts[0].email,
                success: true,
                collected: 0,
                terminalAt,
                live: { lastUpdateTs: '2026-11-08T16:01:00.000Z' }
            }
        ]
    }
    const history = accountHistory([meta], { now: new Date('2026-11-08T16:03:00.000Z') }).get(accounts[0].email)
    assert.equal(history.latest.at, terminalAt)
    assert.equal(history.today, null)
})
