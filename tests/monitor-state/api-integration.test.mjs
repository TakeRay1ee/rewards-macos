import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { fixture, waitFor } from '../control-api/api-fixture.mjs'
import { RunTracker } from '../../monitor/server/runTracker.mjs'
import { buildLedger } from '../../monitor/server/pointsLedger.mjs'

test('real API recovery preserves tracker identity, selection, known earnings and unavailable-log boundary', async t => {
    const fx = await fixture(t)
    const envFile = path.join(fx.dir, '.env')
    fs.writeFileSync(
        envFile,
        fs
            .readFileSync(envFile, 'utf8')
            .replace(
                /^API_RUN_ARGS=.*$/m,
                `API_RUN_ARGS=${JSON.stringify([path.join(fx.dir, 'heartbeat.cjs'), '--with-points'])}`
            )
    )
    let api = await fx.launch()
    const started = await api.request('POST', '/start', { accountIndex: 1 })
    await waitFor(() => fx.beats(started.body.pid) >= 2)
    const accounts = [
        { index: 1, email: 'one@example.invalid' },
        { index: 2, email: 'two@example.invalid' }
    ]
    const control = {
        status: async () => (await api.request('GET', '/status')).body,
        health: async () => (await api.request('GET', '/health')).body,
        history: async () => (await api.request('GET', '/history')).body,
        logs: async ({ afterId = 0 } = {}) => (await api.request('GET', `/logs?afterId=${afterId}`)).body
    }
    const runsDir = path.join(fx.dir, 'monitor-runs')
    const tracker = new RunTracker({ control, configuredAccounts: accounts, logCap: 100, runsDir })
    await tracker.pollStatus()
    await tracker.pollLogs()
    assert.equal(tracker.getRunView().runId, started.body.runId)
    assert.deepEqual(tracker.getRunView().selectedAccounts, [accounts[0]])
    assert.equal(tracker.deriveAccounts()[0].collectedThisRun, 3)
    assert.equal(tracker.deriveAccounts()[1].status, 'not_run')
    const exited = once(api.child, 'exit')
    process.kill(api.child.pid, 'SIGKILL')
    await exited
    api = await fx.launch(api.port)
    await tracker.pollStatus()
    await tracker.pollLogs()
    assert.equal(tracker.getRunView().runId, started.body.runId)
    assert.equal(tracker.getRunView().logStreamAvailable, false)
    assert.equal(tracker.deriveAccounts()[0].collectedThisRun, 3)
    const stopping = await api.request('POST', '/stop', { force: true, expectedRunId: started.body.runId })
    assert.equal(stopping.status, 202)
    await waitFor(async () => (await api.request('GET', '/status')).body.state === 'idle')
    await tracker.pollStatus()
    await tracker.pollLogs()
    const restarted = new RunTracker({ control, configuredAccounts: accounts, logCap: 100, runsDir })
    await restarted.pollStatus()
    await restarted.pollLogs()
    assert.equal(restarted.getRunView().runId, started.body.runId)
    assert.equal(restarted.deriveAccounts()[0].collectedThisRun, 3)
    assert.equal(restarted.deriveAccounts()[0].status, 'stopped')
    assert.equal(buildLedger({ runsDir, emails: [accounts[0].email] }).days[0].accounts[accounts[0].email].collected, 3)
})
