import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { RunIdentityStore, processIdentity } from '../../scripts/api/runIdentity.js'
import { applyLogToRunState, createRunState, parseLogLine, summarizeRunState } from '../../scripts/api/logParser.js'
import { fixture, alive, pause, waitFor } from './api-fixture.mjs'

test('history preserves unknown earnings independently from an observed zero and a positive observation', async t => {
    const fx = await fixture(t)
    const email = 'one@example.invalid'
    const store = new RunIdentityStore(path.join(fx.dir, '.control-api', 'runtime.sqlite'))
    const cases = [
        { id: 'unknown', points: null },
        { id: 'observed-zero', points: 0 },
        { id: 'observed-positive', points: 3 },
        { id: 'cross-midnight-error', points: null, terminal: 'error', terminalAt: '2026-11-08T16:01:00.000Z' },
        { id: 'before-midnight-completion', points: 0, terminal: 'end', terminalAt: '2026-11-08T15:59:00.000Z' }
    ]
    for (const scenario of cases) {
        const state = createRunState({ accountEmails: [email] })
        applyLogToRunState(state, {
            ...parseLogLine(
                `[2026-11-08 12:00:00] [${email}] [INFO] MAIN [ACCOUNT-START] 开始处理账户: ${email} | geoLocale: CN`
            ),
            email,
            receivedAt: '2026-11-08T04:00:00.000Z'
        })
        if (scenario.points != null) {
            applyLogToRunState(state, {
                ...parseLogLine(
                    `[2026-11-08 12:00:00] [${email}] [INFO] DESKTOP [SEARCH-BING] 必应搜索完成 | pointsGained=${scenario.points} | currentBalance=${100 + scenario.points}`
                ),
                email,
                receivedAt: '2026-11-08T04:00:00.000Z'
            })
        }
        if (scenario.terminal) {
            const title = scenario.terminal === 'error' ? 'ACCOUNT-ERROR' : 'ACCOUNT-END'
            const message =
                scenario.terminal === 'error'
                    ? `${email} | 错误=synthetic failure after midnight`
                    : `账户完成: ${email} | 获得积分=0 | 原余额=100 | 现余额=100 | 持续秒数=1`
            applyLogToRunState(state, {
                email,
                user: email,
                parsed: true,
                level: 'info',
                title,
                message,
                receivedAt: scenario.terminalAt
            })
        }
        store.finish({
            runId: scenario.id,
            startedAt: '2026-11-08T04:00:00.000Z',
            endedAt: scenario.terminal ? '2026-11-08T16:02:00.000Z' : '2026-11-08T04:01:00.000Z',
            exit: { code: 0, signal: null },
            selectedAccounts: [{ index: 1, email }],
            run: summarizeRunState(state)
        })
    }
    store.db.close()
    const api = await fx.launch()
    const history = await api.request('GET', '/history')
    assert.equal(history.status, 200)
    for (const scenario of cases) {
        const account = history.body.runs.find(run => run.runId === scenario.id).accounts[0]
        assert.equal(account.collected, scenario.points)
        assert.equal(account.collectedObserved, scenario.points != null)
        assert.equal(account.terminalAt, scenario.terminalAt ?? null)
    }
})

test('API crash recovery keeps the surviving run busy and stoppable without duplicate start', async t => {
    const fx = await fixture(t)
    const first = await fx.launch()
    const started = await first.request('POST', '/start', { accountIndex: 1 })
    assert.equal(started.status, 202)
    const pid = started.body.pid
    await waitFor(() => fx.beats(pid) >= 2)
    const exited = once(first.child, 'exit')
    process.kill(first.child.pid, 'SIGKILL')
    await exited
    await pause(150)
    assert.equal(alive(pid), true, 'Fixture survives its API parent so recovery must reconcile it')
    const second = await fx.launch(first.port)
    const status = await second.request('GET', '/status')
    assert.notEqual(status.body.state, 'idle', 'Surviving worker must not be presented as idle')
    assert.equal(status.body.pid, pid)
    assert.equal(status.body.runId, started.body.runId)
    assert.deepEqual(status.body.selectedAccounts, [{ index: 1, email: 'one@example.invalid' }])
    assert.equal((await second.request('POST', '/start', {})).status, 409)
    assert.equal((await second.request('POST', '/stop', { force: true, expectedRunId: 'another-run' })).status, 409)
    assert.equal(alive(pid), true, 'Stale stop must never kill a different run')
    assert.equal(
        (await second.request('POST', '/stop', { force: true, expectedRunId: started.body.runId })).status,
        202
    )
    await waitFor(() => !alive(pid))
    await waitFor(async () => (await second.request('GET', '/status')).body.state === 'idle')
    const history = await second.request('GET', '/history')
    assert.equal(history.body.runs[0].runId, started.body.runId)
    const next = await second.request('POST', '/start', { accountIndex: 2 })
    assert.equal(next.status, 202)
    assert.notEqual(next.body.runId, started.body.runId)
})

test('requestId is durable and idempotent while running, after finish, and after API restart', async t => {
    const fx = await fixture(t)
    let api = await fx.launch()
    const first = await api.request('POST', '/start', { accountIndex: 1, requestId: 'fixture-durable-request' })
    assert.equal(first.status, 202)
    const duplicate = await api.request('POST', '/start', { accountIndex: 1, requestId: 'fixture-durable-request' })
    assert.equal(duplicate.status, 202)
    assert.equal(duplicate.body.duplicate, true)
    assert.equal(duplicate.body.started, false)
    assert.equal(duplicate.body.runId, first.body.runId)
    assert.equal((await api.request('POST', '/start', { requestId: 'different-request' })).status, 409)
    await api.request('POST', '/stop', { force: true, expectedRunId: first.body.runId })
    await waitFor(() => !alive(first.body.pid))
    const exited = once(api.child, 'exit')
    process.kill(api.child.pid, 'SIGTERM')
    await exited
    api = await fx.launch(api.port)
    const repeated = await api.request('POST', '/start', { accountIndex: 1, requestId: 'fixture-durable-request' })
    assert.equal(repeated.status, 202)
    assert.equal(repeated.body.duplicate, true)
    assert.equal(repeated.body.started, false)
    assert.equal(repeated.body.runId, first.body.runId)
    assert.equal((await api.request('GET', '/status')).body.state, 'idle')
})

test('two API instances sharing a project permit only one simultaneous run', async t => {
    const fx = await fixture(t)
    const [a, b] = await Promise.all([fx.launch(), fx.launch()])
    const responses = await Promise.all([a.request('POST', '/start', {}), b.request('POST', '/start', {})])
    assert.deepEqual(responses.map(r => r.status).sort(), [202, 409])
    const accepted = responses.find(r => r.status === 202)
    const observer = responses[0].status === 202 ? b : a
    const observed = await observer.request('GET', '/status')
    assert.equal(observed.body.runId, accepted.body.runId)
    assert.equal(observed.body.pid, accepted.body.pid)
    assert.equal(
        (await observer.request('POST', '/stop', { force: true, expectedRunId: accepted.body.runId })).status,
        202
    )
    await waitFor(() => !alive(accepted.body.pid))
})

test('status, points, logs, history and restart preserve the same run identity and original account slots', async t => {
    const fx = await fixture(t)
    const api = await fx.launch()
    const first = await api.request('POST', '/start', { excludedAccountIndexes: [1] })
    assert.equal(first.status, 202)
    await waitFor(() => fx.beats(first.body.pid) >= 2)
    for (const endpoint of ['/status', '/points']) {
        const response = await api.request('GET', endpoint)
        assert.equal(response.body.runId, first.body.runId)
        assert.deepEqual(response.body.selectedAccounts, [{ index: 2, email: 'two@example.invalid' }])
    }
    const logs = await api.request('GET', '/logs')
    assert.ok(logs.body.logs.length > 0)
    assert.ok(logs.body.logs.every(log => log.runId === first.body.runId))
    const restarted = await api.request('POST', '/restart', { force: true, accountIndex: 1 })
    assert.equal(restarted.status, 202)
    assert.notEqual(restarted.body.runId, first.body.runId)
    const current = await api.request('GET', '/status')
    assert.deepEqual(current.body.selectedAccounts, [{ index: 1, email: 'one@example.invalid' }])
    const history = await api.request('GET', '/history')
    assert.equal(history.body.runs[0].runId, first.body.runId)
    assert.deepEqual(history.body.runs[0].selectedAccounts, [{ index: 2, email: 'two@example.invalid' }])
})

test('PID identity mismatch never takes over or signals an unrelated process', async t => {
    const fx = await fixture(t)
    const unrelated = spawn(process.execPath, [path.join(fx.dir, 'heartbeat.cjs')], {
        cwd: fx.dir,
        detached: true,
        stdio: 'ignore'
    })
    fx.trackWorker(unrelated)
    t.after(() => {
        try {
            process.kill(-unrelated.pid, 'SIGKILL')
        } catch {}
    })
    await waitFor(() => fx.beats(unrelated.pid) > 0)
    const identity = processIdentity(unrelated.pid)
    assert.ok(identity)
    const store = new RunIdentityStore(path.join(fx.dir, '.control-api/runtime.sqlite'))
    store.reserve({
        runId: 'stale-pid-run',
        startedAt: new Date().toISOString(),
        pid: unrelated.pid,
        processIdentity: { ...identity, birth: 'Mon Jan 1 00:00:00 2001' },
        selectedAccounts: []
    })
    store.db.close()
    const api = await fx.launch()
    assert.equal((await api.request('GET', '/status')).body.state, 'idle')
    assert.equal((await api.request('POST', '/stop', { force: true, expectedRunId: 'stale-pid-run' })).status, 409)
    assert.equal(alive(unrelated.pid), true)
})

test('unresolved pre-spawn reservation blocks duplicate start and reports recovery instead of signaling', async t => {
    const fx = await fixture(t)
    const store = new RunIdentityStore(path.join(fx.dir, '.control-api/runtime.sqlite'))
    store.reserve({
        runId: 'uncertain-start',
        startedAt: new Date().toISOString(),
        pid: null,
        processIdentity: null,
        selectedAccounts: []
    })
    store.db.close()
    const api = await fx.launch()
    const status = await api.request('GET', '/status')
    assert.equal(status.body.state, 'starting')
    assert.equal((await api.request('POST', '/start', {})).status, 409)
    const stop = await api.request('POST', '/stop', { force: true, expectedRunId: 'uncertain-start' })
    assert.equal(stop.status, 409)
    assert.equal(stop.body.code, 'RECOVERY_REQUIRED')
})

test('persisted run points and logs survive API crash without being reset to empty state', async t => {
    const fx = await fixture(t)
    fs.appendFileSync(
        path.join(fx.dir, '.env'),
        `API_RUN_ARGS=${JSON.stringify([path.join(fx.dir, 'heartbeat.cjs'), '--with-points'])}\n`
    )
    // Replace the original args line: .env loader preserves the first value for each key.
    const envFile = path.join(fx.dir, '.env')
    fs.writeFileSync(envFile, fs.readFileSync(envFile, 'utf8').replace(/^API_RUN_ARGS=.*\n/m, ''))
    let api = await fx.launch()
    const start = await api.request('POST', '/start', { accountIndex: 1 })
    await waitFor(async () => (await api.request('GET', '/points')).body.collected === 3)
    const exit = once(api.child, 'exit')
    process.kill(api.child.pid, 'SIGKILL')
    await exit
    api = await fx.launch(api.port)
    const points = await api.request('GET', '/points')
    assert.equal(points.body.runId, start.body.runId)
    assert.equal(points.body.collected, 3)
    assert.equal(points.body.accounts[0].email, 'one@example.invalid')
    const logs = await api.request('GET', '/logs')
    assert.ok(logs.body.logs.some(e => e.title === 'SEARCH-BING' && e.runId === start.body.runId))
    assert.equal((await api.request('GET', '/status')).body.logStreamAvailable, false)
})

test('recovery replays a durable log whose state checkpoint was interrupted by a crash', async t => {
    const fx = await fixture(t)
    const worker = spawn(process.execPath, [path.join(fx.dir, 'heartbeat.cjs')], {
        cwd: fx.dir,
        detached: true,
        stdio: 'ignore'
    })
    fx.trackWorker(worker)
    t.after(() => {
        try {
            process.kill(-worker.pid, 'SIGKILL')
        } catch {}
    })
    await waitFor(() => fx.beats(worker.pid) > 0)
    const store = new RunIdentityStore(path.join(fx.dir, '.control-api/runtime.sqlite'))
    const selectedAccounts = [{ index: 1, email: 'one@example.invalid' }]
    store.reserve({
        runId: 'interrupted-checkpoint',
        startedAt: new Date().toISOString(),
        pid: worker.pid,
        processIdentity: processIdentity(worker.pid),
        selectedAccounts,
        runState: createRunState({ accountEmails: ['one@example.invalid'] }),
        appliedLogId: 0
    })
    for (const raw of [
        '[2026-11-08 12:00:00] [one@example.invalid] [INFO] MAIN [ACCOUNT-START] 开始处理账户: one@example.invalid | geoLocale: CN | locale: zh-CN',
        '[2026-11-08 12:00:01] [one@example.invalid] [INFO] DESKTOP [SEARCH-BING] 必应搜索完成 | 获得积分=3 | 当前余额=103'
    ])
        store.append({ ...parseLogLine(raw), runId: 'interrupted-checkpoint', receivedAt: new Date().toISOString() })
    store.db.close()
    const api = await fx.launch()
    assert.equal((await api.request('GET', '/points')).body.collected, 3)
    assert.equal(
        (await api.request('GET', '/points')).body.live,
        false,
        'Recovered stdout is unavailable; point snapshot must not claim to be live'
    )
})

test('an observing API waits for the live pipe owner to archive the exact exit and final output', async t => {
    const fx = await fixture(t)
    const worker = path.join(fx.dir, 'late-output.cjs')
    const lateRaw =
        '[2026-11-08 12:00:01] [one@example.invalid] [INFO] MAIN [ACCOUNT-END] 账户完成: one@example.invalid | 获得积分=9 | 原余额=100 | 现余额=109 | 持续秒数=1\n'
    fs.writeFileSync(
        worker,
        `
        const {spawn}=require('node:child_process');
        console.log('[2026-11-08 12:00:00] [one@example.invalid] [INFO] MAIN [ACCOUNT-START] 开始处理账户: one@example.invalid | geoLocale: CN | locale: zh-CN');
        setTimeout(()=>{
            spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>process.stdout.write(${JSON.stringify(lateRaw)}),300);setTimeout(()=>process.exit(0),800)`)}],{stdio:['ignore',process.stdout,process.stderr]});
            process.exit(0);
        },250);
    `
    )
    const envFile = path.join(fx.dir, '.env')
    fs.writeFileSync(
        envFile,
        fs.readFileSync(envFile, 'utf8').replace(/^API_RUN_ARGS=.*$/m, `API_RUN_ARGS=${JSON.stringify([worker])}`)
    )
    const owner = await fx.launch()
    const started = await owner.request('POST', '/start', { accountIndex: 1 })
    assert.equal(started.status, 202)
    const observer = await fx.launch()
    assert.equal((await observer.request('GET', '/status')).body.runId, started.body.runId)
    await waitFor(async () => (await owner.request('GET', '/status')).body.state === 'idle')
    const history = (await observer.request('GET', '/history')).body.runs
    assert.equal(history[0].exit.code, 0, 'Observer must not replace the live owner exact exit with an unknown exit')
    assert.equal(history[0].accounts[0].collected, 9, 'Pipe tail must be consumed before final history is fixed')
})

test('retrying a previously completed restart request does not stop a newer run', async t => {
    const fx = await fixture(t)
    const api = await fx.launch()
    const initial = await api.request('POST', '/start', { accountIndex: 1 })
    const restarted = await api.request('POST', '/restart', { force: true, accountIndex: 1, requestId: 'restart-once' })
    assert.equal(restarted.status, 202)
    await api.request('POST', '/stop', { force: true, expectedRunId: restarted.body.runId })
    await waitFor(async () => (await api.request('GET', '/status')).body.state === 'idle')
    const newer = await api.request('POST', '/start', { accountIndex: 2 })
    await waitFor(() => fx.beats(newer.body.pid) > 0)
    const duplicate = await api.request('POST', '/restart', { force: true, accountIndex: 1, requestId: 'restart-once' })
    assert.equal(duplicate.body.duplicate, true)
    assert.equal(duplicate.body.runId, restarted.body.runId)
    const current = (await api.request('GET', '/status')).body
    assert.equal(current.runId, newer.body.runId, 'A replayed command must not mutate the current run')
    assert.notEqual(current.state, 'idle')
    assert.equal(alive(newer.body.pid), true)
    assert.notEqual(initial.body.runId, newer.body.runId)
})

test('invalid or stale restart requests leave the current run untouched', async t => {
    const fx = await fixture(t)
    const api = await fx.launch()
    const started = await api.request('POST', '/start', { accountIndex: 1 })
    await waitFor(() => fx.beats(started.body.pid) > 0)
    for (const body of [
        { force: true, requestId: 'bad key' },
        { force: true, args: 7 },
        { force: true, expectedRunId: 'not-current' }
    ]) {
        const response = await api.request('POST', '/restart', body)
        assert.ok([400, 409].includes(response.status))
        const status = (await api.request('GET', '/status')).body
        assert.equal(status.runId, started.body.runId)
        assert.notEqual(status.state, 'idle')
        assert.equal(alive(started.body.pid), true)
    }
})
