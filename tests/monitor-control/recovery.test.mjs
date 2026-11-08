import test from 'node:test'
import assert from 'node:assert/strict'
import { recoverStalledRun, planDailyRecovery, refreshRecoveryPlan } from '../../monitor/server/recovery.mjs'
const accounts = [
    { index: 1, email: 'a@example.invalid', status: 'running' },
    { index: 2, email: 'b@example.invalid', status: 'completed' },
    { index: 3, email: 'c@example.invalid', status: 'waiting' },
    { index: 4, email: 'd@example.invalid', status: 'not_run' }
]
test('stalled batch recovers every selected unfinished account and preserves completed/excluded accounts', async () => {
    let saved
    const retries = []
    const stopped = []
    const result = await recoverStalledRun({
        runId: 'run-a',
        accounts,
        save: p => {
            saved = p
        },
        readStatus: async () => ({ state: 'idle', runId: 'run-a' }),
        stop: async id => {
            stopped.push(id)
            return { ok: true }
        },
        retry: async (indexes, key) => {
            retries.push({ indexes, key })
            return 123
        },
        canRetry: () => true,
        noteRetry: () => {}
    })
    assert.deepEqual(stopped, ['run-a'])
    assert.deepEqual(retries, [{ indexes: [1, 3], key: 'recovery-run-a' }])
    assert.equal(result.state, 'scheduled')
    assert.equal(saved.state, 'scheduled')
})
test('failed stop does not consume retry budget or schedule work', async () => {
    let notes = 0,
        spawns = 0
    const r = await recoverStalledRun({
        runId: 'run-a',
        accounts,
        save: () => {},
        stop: async () => ({ ok: false, error: 'cooldown' }),
        readStatus: async () => ({ state: 'running', runId: 'run-a' }),
        retry: async () => {
            spawns++
        },
        canRetry: () => true,
        noteRetry: () => notes++
    })
    assert.equal(r.state, 'requires_attention')
    assert.equal(notes, 0)
    assert.equal(spawns, 0)
})
test('different current run is never retried after stop response', async () => {
    let spawns = 0
    const r = await recoverStalledRun({
        runId: 'run-a',
        accounts,
        save: () => {},
        stop: async () => ({ ok: true }),
        readStatus: async () => ({ state: 'running', runId: 'run-b' }),
        retry: async () => {
            spawns++
        },
        canRetry: () => true,
        noteRetry: () => {}
    })
    assert.equal(r.state, 'requires_attention')
    assert.equal(spawns, 0)
})
const now = new Date('2026-11-08T12:00:00+08:00'),
    scheduledAt = new Date('2026-11-08T00:00:00+08:00')
const configured = accounts.slice(0, 3)
test('a started run with failed outcomes retries only unfinished accounts', () => {
    const p = planDailyRecovery({
        now,
        scheduledAt,
        accounts: configured,
        records: [{ at: scheduledAt.toISOString(), reason: 'daily', result: 'started', runId: 'r' }],
        metas: [
            {
                runId: 'r',
                startedAt: scheduledAt.toISOString(),
                endedAt: now.toISOString(),
                accounts: [
                    { email: configured[0].email, success: true },
                    { email: configured[1].email, success: false }
                ]
            }
        ]
    })
    assert.equal(p.action, 'start')
    assert.deepEqual(p.indexes, [2, 3])
})
test('a legacy start without a trustworthy outcome is reported for review, never called complete', () => {
    const p = planDailyRecovery({
        now,
        scheduledAt,
        accounts: configured,
        records: [{ at: scheduledAt.toISOString(), reason: 'daily', result: 'started' }],
        metas: []
    })
    assert.equal(p.action, 'requires_attention')
    assert.match(p.reason, /旧|legacy/)
})
test('all account successes skip and missing success never becomes zero/completed', () => {
    const p = planDailyRecovery({
        now,
        scheduledAt,
        accounts: configured,
        records: [],
        metas: [
            {
                startedAt: scheduledAt.toISOString(),
                endedAt: now.toISOString(),
                accounts: configured.map(a => ({ email: a.email, success: true }))
            }
        ]
    })
    assert.equal(p.action, 'skip')
    assert.deepEqual(p.indexes, [])
})

test('accepted asynchronous stop waits for the same batch to become idle', async () => {
    const statuses = [
        { state: 'stopping', runId: 'a' },
        { state: 'idle', runId: 'a' }
    ]
    let retries = 0
    const r = await recoverStalledRun({
        runId: 'a',
        accounts,
        save: () => {},
        stop: async () => ({ ok: true }),
        readStatus: async () => statuses.shift(),
        wait: async () => {},
        retry: async () => ++retries,
        canRetry: () => true,
        noteRetry: () => {}
    })
    assert.equal(r.state, 'scheduled')
    assert.equal(retries, 1)
})
test('scheduler rejection is reported instead of treating spawned PID as a started retry', async () => {
    const p = await refreshRecoveryPlan({
        plan: { state: 'scheduled', requestId: 'key', runId: 'old', retryPid: 123 },
        records: [{ requestId: 'key', result: 'skipped', detail: 'lock busy' }],
        status: { state: 'idle' },
        isAlive: () => false,
        retry: async () => {
            throw Error('must not retry rejected request')
        }
    })
    assert.equal(p.state, 'requires_attention')
    assert.match(p.reason, /lock busy/)
})
test('a lost scheduler is redispatched with the same idempotency key and a bounded dispatch budget', async () => {
    let call
    const plan = {
        state: 'scheduled',
        requestId: 'key',
        runId: 'old',
        retryPid: 123,
        retried: [accounts[0]],
        dispatchAttempts: 1
    }
    const p = await refreshRecoveryPlan({
        plan,
        records: [],
        status: { state: 'idle' },
        isAlive: () => false,
        retry: async (indexes, key) => {
            call = { indexes, key }
            return 456
        }
    })
    assert.deepEqual(call, { indexes: [1], key: 'key' })
    assert.equal(p.retryPid, 456)
    assert.equal(p.dispatchAttempts, 2)
})
test('the API request identity confirms a retry even when the scheduler receipt was lost', async () => {
    const p = await refreshRecoveryPlan({
        plan: { state: 'scheduled', requestId: 'key' },
        records: [],
        status: { state: 'running', runId: 'new', requestId: 'key' },
        isAlive: () => false,
        retry: async () => {
            throw Error('no duplicate dispatch')
        }
    })
    assert.equal(p.state, 'started')
    assert.equal(p.retryRunId, 'new')
})

test('API durable account success prevents duplicate catchup when monitor metadata is absent', () => {
    const p = planDailyRecovery({
        now,
        scheduledAt,
        accounts: configured,
        records: [],
        metas: [],
        apiHistory: [
            {
                startedAt: scheduledAt.toISOString(),
                endedAt: now.toISOString(),
                accounts: configured.map(a => ({ email: a.email, success: true }))
            }
        ]
    })
    assert.equal(p.action, 'skip')
    assert.deepEqual(p.indexes, [])
})
