import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RunTracker } from '../../monitor/server/runTracker.mjs'
import { buildLedger } from '../../monitor/server/pointsLedger.mjs'

const accounts = [
    { index: 1, email: 'same@one.invalid' },
    { index: 3, email: 'same@two.invalid' }
]
const startedAt = '2026-11-08T01:00:00.000Z'
const run = { runId: 'stable-run-a', startedAt, selectedAccounts: [accounts[0]] }
const event = (id, title, message, extra = {}) => ({
    id,
    runId: run.runId,
    receivedAt: `2026-11-08T01:00:${String(id).padStart(2, '0')}.000Z`,
    parsed: true,
    user: accounts[0].email,
    title,
    message,
    level: 'info',
    ...extra
})
const start = (id = 1, extra) => event(id, 'ACCOUNT-START', `开始处理账户: ${accounts[0].email} | geoLocale: CN`, extra)
const finish = (id = 2, extra) =>
    event(
        id,
        'ACCOUNT-END',
        `账户完成: ${accounts[0].email} | 获得积分=10 | 原余额=100 | 现余额=110 | 持续秒数=1`,
        extra
    )

function fixture(t) {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reward-tracker-test-'))
    const api = { status: { ...run, state: 'running' }, history: [], logs: [], uptimeSec: 100 }
    const trackers = []
    const control = {
        status: async () => api.status,
        health: async () => ({ uptimeSec: api.uptimeSec }),
        logs: async ({ afterId = 0 } = {}) => ({ logs: api.logs.filter(e => e.id > afterId) }),
        history: async () => ({ runs: api.history })
    }
    const create = () => {
        const tracker = new RunTracker({ control, configuredAccounts: accounts, logCap: 100, runsDir })
        tracker.setConfiguredAccounts(accounts)
        trackers.push(tracker)
        return tracker
    }
    t.after(async () => {
        for (const tracker of trackers) {
            if (tracker.persist?.events) await new Promise(resolve => tracker.persist.events.end(resolve))
        }
        fs.rmSync(runsDir, { recursive: true, force: true })
    })
    return { api, create, runsDir }
}

test('tracker exposes stable upstream run identity and leaves unselected configured accounts out of waiting', async t => {
    const { api, create } = fixture(t)
    api.logs = [start()]
    const tracker = create()
    await tracker.pollStatus()
    await tracker.pollLogs()
    assert.equal(tracker.getRunView().runId, run.runId)
    assert.deepEqual(tracker.getRunView().selectedAccounts, [accounts[0]])
    assert.equal(tracker.deriveAccounts()[1].status, 'not_run')
})

test('terminal logs received after idle update the durable ledger, without inventing zero before any point observation', async t => {
    const { api, create, runsDir } = fixture(t)
    api.logs = [start()]
    const tracker = create()
    await tracker.pollStatus()
    await tracker.pollLogs()
    assert.equal(
        buildLedger({ runsDir, emails: [accounts[0].email], now: new Date('2026-11-08T12:00:00.000Z') }).days[0]
            .accounts[accounts[0].email].collected,
        null
    )
    api.status = {
        ...run,
        state: 'idle',
        startedAt: null,
        lastExit: { code: 0, signal: null, at: '2026-11-08T01:01:00.000Z' },
        lastRun: { ...run, endedAt: '2026-11-08T01:01:00.000Z', exit: { code: 0, signal: null } }
    }
    await tracker.pollStatus()
    api.logs.push(finish())
    await tracker.pollLogs()
    assert.equal(
        buildLedger({ runsDir, emails: [accounts[0].email], now: new Date('2026-11-08T12:00:00.000Z') }).days[0]
            .accounts[accounts[0].email].collected,
        10
    )
    await tracker.pollLogs()
    assert.equal(
        buildLedger({ runsDir, emails: [accounts[0].email], now: new Date('2026-11-08T12:00:00.000Z') }).days[0]
            .accounts[accounts[0].email].collected,
        10
    )
})

test('a new monitor restores the complete durable run and killed exit even when the API retains only its tail', async t => {
    const { api, create, runsDir } = fixture(t)
    api.status = { ...run, selectedAccounts: accounts, state: 'running' }
    api.logs = [
        start(),
        finish(),
        event(3, 'ACCOUNT-START', `开始处理账户: ${accounts[1].email} | geoLocale: CN`, { user: accounts[1].email })
    ]
    const first = create()
    await first.pollStatus()
    await first.pollLogs()
    const exit = { code: null, signal: 'SIGKILL', at: '2026-11-08T01:01:00.000Z' }
    const ended = { ...run, selectedAccounts: accounts, endedAt: exit.at, exit }
    api.status = { ...run, selectedAccounts: accounts, state: 'idle', startedAt: null, lastExit: exit, lastRun: ended }
    api.history = [ended]
    await first.pollStatus()
    api.logs = api.logs.slice(-1)
    const restored = create()
    await restored.pollStatus()
    await restored.pollLogs()
    assert.equal(restored.deriveAccounts()[0].collectedThisRun, 10)
    assert.equal(restored.deriveAccounts()[0].status, 'completed')
    assert.equal(restored.deriveAccounts()[1].status, 'stopped')
    assert.deepEqual(restored.getRunView().exit, exit)
    assert.equal(restored.getRunView().logEventCount, 3)
    assert.equal(
        buildLedger({ runsDir, emails: [accounts[0].email], now: new Date('2026-11-08T12:00:00.000Z') }).days[0]
            .accounts[accounts[0].email].collected,
        10
    )
})

test('delayed old-run facts update their own ledger without completing the new run, and duplicate events are idempotent', async t => {
    const { api, create, runsDir } = fixture(t)
    api.logs = [start()]
    const tracker = create()
    await tracker.pollStatus()
    await tracker.pollLogs()
    const second = { ...run, runId: 'stable-run-b', startedAt: '2026-11-09T01:00:00.000Z' }
    api.status = {
        ...second,
        state: 'running',
        lastRun: { ...run, endedAt: '2026-11-08T01:01:00.000Z', exit: { code: 0, signal: null } }
    }
    await tracker.pollStatus()
    api.logs.push(finish(), start(3, { runId: second.runId, receivedAt: '2026-11-09T01:00:03.000Z' }))
    await tracker.pollLogs()
    assert.equal(tracker.getRunView().runId, second.runId)
    assert.ok(['running', 'starting'].includes(tracker.deriveAccounts()[0].status))
    assert.equal(tracker.deriveAccounts()[0].collectedThisRun, null)
    assert.ok(tracker.getLogsSince().every(e => e.runId === second.runId))
    assert.equal(
        buildLedger({ runsDir, emails: [accounts[0].email], now: new Date('2026-11-08T12:00:00.000Z') }).days.find(
            r => r.date === '2026-11-08'
        ).accounts[accounts[0].email].collected,
        10
    )
    api.logs.push({ ...api.logs.at(-1) })
    await tracker.attach()
    assert.equal(tracker.getRunView().logEventCount, 1)
})

test('legacy journals restore safe identities, terminal exit and metadata when the API loses its in-memory history', async t => {
    const { api, create, runsDir } = fixture(t)
    const legacyId = startedAt.replace(/[:.]/g, '-')
    const dir = path.join(runsDir, legacyId)
    fs.mkdirSync(dir)
    const exit = { code: null, signal: 'SIGTERM', at: '2026-11-08T01:01:00.000Z' }
    fs.writeFileSync(
        path.join(dir, 'events.jsonl'),
        [start(), finish()].map(e => JSON.stringify({ ...e, runId: legacyId })).join('\n') + '\n'
    )
    fs.writeFileSync(
        path.join(dir, 'meta.json'),
        JSON.stringify({
            runId: legacyId,
            startedAt,
            endedAt: exit.at,
            exit,
            accounts: [{ email: accounts[0].email, collected: 10, success: true }]
        })
    )
    api.status = { state: 'idle', startedAt: null }
    api.logs = []
    const tracker = create()
    await tracker.pollStatus()
    await tracker.pollLogs()
    assert.equal(tracker.deriveAccounts()[0].collectedThisRun, 10)
    assert.deepEqual(tracker.getRunView().exit, exit)
    assert.equal(tracker.getRunView().selectedAccounts, null)
})

test('complete existing summary facts are retained when its original event journal is unavailable', async t => {
    const { api, create, runsDir } = fixture(t)
    const dir = path.join(runsDir, run.runId)
    fs.mkdirSync(dir)
    const ended = { ...run, endedAt: '2026-11-08T01:01:00.000Z', exit: { code: 0, signal: null } }
    fs.writeFileSync(
        path.join(dir, 'meta.json'),
        JSON.stringify({
            ...ended,
            accounts: [
                {
                    email: accounts[0].email,
                    collected: 10,
                    collectedSource: 'account-end',
                    initialPoints: 100,
                    finalPoints: 110,
                    success: true
                }
            ]
        })
    )
    api.history = [ended]
    api.status = { ...ended, state: 'idle', startedAt: null, lastRun: ended }
    api.logs = [event(5, 'MISC', 'tail only')]
    const tracker = create()
    await tracker.pollStatus()
    await tracker.pollLogs()
    assert.equal(tracker.deriveAccounts()[0].collectedThisRun, 10)
    assert.equal(tracker.deriveAccounts()[0].status, 'completed')
    assert.equal(
        buildLedger({ runsDir, emails: [accounts[0].email], now: new Date('2026-11-08T12:00:00.000Z') }).days[0]
            .accounts[accounts[0].email].collected,
        10
    )
})

test('legacy ambiguous activity logs remain visible but cannot credit either configured account', async t => {
    const { api, create } = fixture(t)
    api.status = { ...run, selectedAccounts: accounts, state: 'running' }
    api.logs = [
        start(1, { user: 'same' }),
        event(2, 'ACCOUNT-START', `开始处理账户: ${accounts[1].email} | geoLocale: CN`, { user: 'same' }),
        event(3, 'SEARCH-BING', '必应搜索完成 | pointsGained=15 | currentBalance=115', { user: 'same' })
    ]
    const tracker = create()
    await tracker.pollStatus()
    await tracker.pollLogs()
    assert.equal(tracker.getLogsSince().at(-1).email, null)
    assert.ok(tracker.deriveAccounts().every(a => a.collectedThisRun === null && a.attributionReliable === false))
    api.logs.push(finish(4, { user: 'same' }))
    await tracker.pollLogs()
    assert.equal(tracker.deriveAccounts()[0].collectedThisRun, 10)
    assert.equal(tracker.deriveAccounts()[1].collectedThisRun, null)
})

test('legacy logs outside the current time window cannot complete a new run and unknown selection stays explicit', async t => {
    const { api, create } = fixture(t)
    delete api.status.runId
    delete api.status.selectedAccounts
    api.logs = [start(1, { runId: undefined }), finish(2, { runId: undefined, receivedAt: '2026-11-07T01:00:02.000Z' })]
    const tracker = create()
    await tracker.pollStatus()
    await tracker.pollLogs()
    assert.equal(tracker.deriveAccounts()[0].collectedThisRun, null)
    assert.equal(tracker.deriveAccounts()[1].status, 'unknown')
})

test('an attach snapshot started before a new status poll cannot roll the displayed batch back', async t => {
    const { api, create } = fixture(t)
    const tracker = create()
    await tracker.pollStatus()
    let releaseLogs
    tracker.control.logs = () =>
        new Promise(resolve => {
            releaseLogs = resolve
        })
    const attaching = tracker.attach()
    await Promise.resolve()
    const second = { ...run, runId: 'stable-run-b', startedAt: '2026-11-09T01:00:00.000Z' }
    api.status = { ...second, state: 'running' }
    await tracker.pollStatus()
    releaseLogs({ logs: [finish()] })
    await attaching
    assert.equal(tracker.getRunView().runId, second.runId)
    assert.equal(tracker.deriveAccounts()[0].collectedThisRun, null)
})

test('observing only a balance cannot invent an observed zero earning', async t => {
    const { api, create, runsDir } = fixture(t)
    api.logs = [start(), event(2, 'SEARCH-BING', '开始必应搜索 | 当前余额=100')]
    const tracker = create()
    await tracker.pollStatus()
    await tracker.pollLogs()
    assert.equal(tracker.deriveAccounts()[0].balance, 100)
    assert.equal(tracker.deriveAccounts()[0].collectedThisRun, null)
    assert.equal(
        buildLedger({ runsDir, emails: [accounts[0].email], now: new Date('2026-11-08T12:00:00.000Z') }).days[0]
            .accounts[accounts[0].email].collected,
        null
    )
    api.logs.push(event(3, 'SEARCH-BING', '必应搜索完成 | pointsGained=0 | currentBalance=100'))
    await tracker.pollLogs()
    assert.equal(tracker.deriveAccounts()[0].collectedThisRun, 0)
})

test('switching batches without observing idle preserves the previous run exit supplied by lastRun', async t => {
    const { api, create, runsDir } = fixture(t)
    api.logs = [start()]
    const tracker = create()
    await tracker.pollStatus()
    await tracker.pollLogs()
    const exit = { code: null, signal: 'SIGKILL', at: '2026-11-08T01:01:00.000Z' }
    api.status = {
        ...run,
        runId: 'stable-run-b',
        startedAt: '2026-11-09T01:00:00.000Z',
        state: 'running',
        lastExit: null,
        lastRun: { ...run, endedAt: exit.at, exit }
    }
    await tracker.pollStatus()
    const stored = JSON.parse(fs.readFileSync(path.join(runsDir, run.runId, 'meta.json')))
    assert.deepEqual(stored.exit, exit)
    assert.equal(stored.endedAt, exit.at)
})

test('restoring a live summary without its journal does not count the retained API tail twice', async t => {
    const { api, create, runsDir } = fixture(t)
    api.logs = [start(), event(2, 'SEARCH-BING', '必应搜索完成 | pointsGained=3 | currentBalance=103')]
    const first = create()
    await first.pollStatus()
    await first.pollLogs()
    fs.unlinkSync(path.join(runsDir, run.runId, 'events.jsonl'))
    const restored = create()
    await restored.pollStatus()
    await restored.pollLogs()
    assert.equal(restored.deriveAccounts()[0].collectedThisRun, 3)
    api.logs.push(event(3, 'SEARCH-BING', '必应搜索完成 | pointsGained=2 | currentBalance=105'))
    await restored.pollLogs()
    assert.equal(restored.deriveAccounts()[0].collectedThisRun, 5)
})

test('journal facts appended after the metadata checkpoint survive restore exactly once', async t => {
    const { api, create, runsDir } = fixture(t)
    api.logs = [start(), event(2, 'SEARCH-BING', '必应搜索完成 | pointsGained=3 | currentBalance=103')]
    const first = create()
    await first.pollStatus()
    await first.pollLogs()
    const journal = path.join(runsDir, run.runId, 'events.jsonl')
    const added = event(3, 'SEARCH-BING', '必应搜索完成 | pointsGained=2 | currentBalance=105')
    fs.appendFileSync(journal, JSON.stringify(added) + '\n')
    api.logs.push(added)
    const restored = create()
    await restored.pollStatus()
    await restored.pollLogs()
    assert.equal(restored.deriveAccounts()[0].collectedThisRun, 5)
    await restored.pollLogs()
    assert.equal(restored.deriveAccounts()[0].collectedThisRun, 5)
})

test('a completed metadata checkpoint retains its run completion fact without the journal', async t => {
    const { api, create, runsDir } = fixture(t)
    api.logs = [
        start(),
        finish(),
        event(3, 'RUN-END', '全部账户完成 | 处理账户数=1 | 获得积分=10 | 原余额=100 | 现余额=110 | 运行分钟数=1')
    ]
    const first = create()
    await first.pollStatus()
    await first.pollLogs()
    fs.unlinkSync(path.join(runsDir, run.runId, 'events.jsonl'))
    api.logs = []
    const restored = create()
    await restored.pollStatus()
    await restored.pollLogs()
    assert.equal(restored.getRunView().finished, true)
    assert.equal(restored.getRunView().totals.collected, 10)
})

for (const keepJournal of [true, false]) {
    test(`a live checkpoint retains its observed balance and update time ${keepJournal ? 'with' : 'without'} its journal`, async t => {
        const { api, create, runsDir } = fixture(t)
        api.logs = [start(), event(2, 'FLOW', `积分已收集 | 获得积分=10 | 现余额=110 | 账户=${accounts[0].email}`)]
        const first = create()
        await first.pollStatus()
        await first.pollLogs()
        const observedAt = first.runState.accounts[accounts[0].email].live.lastUpdateTs
        assert.equal(first.deriveAccounts()[0].balance, 110)
        if (!keepJournal) fs.unlinkSync(path.join(runsDir, run.runId, 'events.jsonl'))
        const restored = create()
        await restored.pollStatus()
        await restored.pollLogs()
        assert.equal(restored.deriveAccounts()[0].balance, 110)
        assert.equal(restored.deriveAccounts()[0].collectedThisRun, 10)
        assert.equal(restored.runState.accounts[accounts[0].email].live.lastUpdateTs, observedAt)
        await restored.attach()
        assert.equal(restored.deriveAccounts()[0].balance, 110)
        assert.equal(restored.deriveAccounts()[0].collectedThisRun, 10)
    })
}

for (const journalIdentity of ['upstream', 'legacy']) {
    test(`a legacy timestamp directory with ${journalIdentity} event ids is adopted once for the stable API batch`, async t => {
        const { api, create, runsDir } = fixture(t)
        const legacyId = startedAt.replace(/[:.]/g, '-')
        const legacyDir = path.join(runsDir, legacyId)
        fs.mkdirSync(legacyDir)
        const ended = { ...run, endedAt: '2026-11-08T01:01:00.000Z', exit: { code: 0, signal: null } }
        const logs = [start(), finish()]
        fs.writeFileSync(
            path.join(legacyDir, 'events.jsonl'),
            logs
                .map(e => JSON.stringify({ ...e, runId: journalIdentity === 'legacy' ? legacyId : run.runId }))
                .join('\n') + '\n'
        )
        fs.writeFileSync(
            path.join(legacyDir, 'meta.json'),
            JSON.stringify({
                ...ended,
                runId: legacyId,
                logEvents: logs.length,
                accounts: [{ email: accounts[0].email, collected: 10, success: true, finalPoints: 110 }]
            })
        )
        api.logs = logs
        api.history = [ended]
        api.status = { state: 'idle', lastRun: ended, lastExit: ended.exit }
        const tracker = create()
        await tracker.pollStatus()
        await tracker.pollLogs()
        assert.equal(tracker.getRunView().runId, run.runId)
        assert.equal(tracker.getRunView().logEventCount, 2)
        assert.equal(tracker.deriveAccounts()[0].collectedThisRun, 10)
        assert.equal(fs.existsSync(legacyDir), false)
        for (let attempt = 0; attempt < 2; attempt++) {
            const restored = create()
            await restored.pollStatus()
            await restored.pollLogs()
            assert.equal(restored.getRunView().logEventCount, 2)
            assert.equal(restored.deriveAccounts()[0].collectedThisRun, 10)
            const ledger = buildLedger({ runsDir, emails: [accounts[0].email], now: new Date(startedAt) })
            assert.equal(ledger.runCount, 1)
            assert.equal(ledger.todayTotals[accounts[0].email], 10)
        }
    })
}

test('a legacy timestamp directory with a conflicting stable event identity remains a separate batch', async t => {
    const { api, create, runsDir } = fixture(t)
    const legacyId = startedAt.replace(/[:.]/g, '-')
    const legacyDir = path.join(runsDir, legacyId)
    fs.mkdirSync(legacyDir)
    const original = JSON.stringify({ runId: legacyId, startedAt, accounts: [] })
    fs.writeFileSync(path.join(legacyDir, 'meta.json'), original)
    fs.writeFileSync(
        path.join(legacyDir, 'events.jsonl'),
        JSON.stringify(start(1, { runId: 'different-stable-id' })) + '\n'
    )
    api.logs = [start()]
    const tracker = create()
    await tracker.pollStatus()
    await tracker.pollLogs()
    assert.equal(fs.readFileSync(path.join(legacyDir, 'meta.json'), 'utf8'), original)
    assert.equal(tracker.getRunView().runId, run.runId)
    assert.equal(tracker.getRunView().logEventCount, 1)
    assert.equal(buildLedger({ runsDir, now: new Date('2026-11-08T12:00:00.000Z') }).runCount, 2)
})

for (const { laterAccount, retainedPoints, terminal = false } of [
    { laterAccount: accounts[0], retainedPoints: null },
    { laterAccount: accounts[1], retainedPoints: null },
    { laterAccount: accounts[1], retainedPoints: 5 },
    { laterAccount: accounts[1], retainedPoints: 5, terminal: true }
]) {
    test(`a stable ${retainedPoints == null ? 'tail' : 'truncated checkpoint'} for ${laterAccount.index === 1 ? 'the same' : 'another'} account preserves observed earnings${terminal ? ' and the completed run' : ''}`, async t => {
        const { api, create, runsDir } = fixture(t)
        const legacyId = startedAt.replace(/[:.]/g, '-')
        const legacyDir = path.join(runsDir, legacyId)
        const stableDir = path.join(runsDir, run.runId)
        fs.mkdirSync(legacyDir)
        fs.mkdirSync(stableDir)
        const earlier = [start(), event(2, 'SEARCH-BING', '必应搜索完成 | pointsGained=3 | currentBalance=103')]
        const later = event(
            retainedPoints == null ? 3 : 4,
            'SEARCH-BING',
            '必应搜索完成 | pointsGained=2 | currentBalance=105',
            {
                user: laterAccount.email
            }
        )
        const legacyMeta = JSON.stringify({
            runId: legacyId,
            startedAt,
            endedAt: null,
            exit: null,
            totals: null,
            finished: false,
            logEvents: 2,
            accounts: [{ email: accounts[0].email, collected: 3, collectedSource: 'live-gained' }]
        })
        const endedAt = '2026-11-08T01:01:00.000Z'
        const exit = { code: 0, signal: null, at: endedAt }
        const totals = { accountsProcessed: 2, collected: 8, oldTotal: 200, newTotal: 208, runtimeMinutes: 1 }
        const tail = [later]
        if (terminal)
            tail.push(
                event(5, 'RUN-END', '全部账户完成 | 处理账户数=2 | 获得积分=8 | 原余额=200 | 现余额=208 | 运行分钟数=1')
            )
        fs.writeFileSync(
            path.join(legacyDir, 'events.jsonl'),
            earlier.map(entry => JSON.stringify(entry)).join('\n') + '\n'
        )
        fs.writeFileSync(path.join(legacyDir, 'meta.json'), legacyMeta)
        fs.writeFileSync(
            path.join(stableDir, 'events.jsonl'),
            tail.map(entry => JSON.stringify(entry)).join('\n') + '\n'
        )
        fs.writeFileSync(
            path.join(stableDir, 'meta.json'),
            JSON.stringify({
                ...run,
                logEvents: terminal ? 3 : retainedPoints == null ? 1 : 2,
                lastLogId: tail.at(-1).id,
                endedAt: terminal ? endedAt : null,
                exit: terminal ? exit : null,
                totals: terminal ? totals : null,
                finished: terminal,
                accounts: [
                    { email: laterAccount.email, collected: retainedPoints ?? 2, collectedSource: 'live-gained' }
                ]
            })
        )
        api.logs = tail
        if (terminal) {
            const completed = { ...run, endedAt, exit }
            api.status = { state: 'idle', lastRun: completed, lastExit: exit }
            api.history = [completed]
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            const tracker = create()
            await tracker.pollStatus()
            await tracker.pollLogs()
            const derived = tracker.deriveAccounts()
            assert.equal(derived[0].collectedThisRun, laterAccount.index === 1 ? 5 : 3)
            assert.equal(derived[1].collectedThisRun, laterAccount.index === 1 ? null : (retainedPoints ?? 2))
            assert.equal(derived.find(account => account.email === laterAccount.email).balance, 105)
            if (terminal) {
                assert.equal(tracker.getRunView().finished, true)
                assert.deepEqual(tracker.getRunView().totals, totals)
                assert.equal(tracker.getRunView().endedAt, endedAt)
                assert.deepEqual(tracker.getRunView().exit, exit)
            }
            const ledger = buildLedger({
                runsDir,
                emails: accounts.map(account => account.email),
                now: new Date(startedAt)
            })
            assert.equal(ledger.runCount, 1)
            assert.equal(
                Object.values(ledger.todayTotals).reduce((sum, points) => sum + points, 0),
                retainedPoints == null ? 5 : 3 + retainedPoints
            )
        }
        assert.equal(fs.readFileSync(path.join(stableDir, `legacy-${legacyId}`, 'meta.json'), 'utf8'), legacyMeta)
    })
}
