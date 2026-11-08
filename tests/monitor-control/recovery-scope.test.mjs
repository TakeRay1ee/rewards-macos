import test from 'node:test'
import assert from 'node:assert/strict'
import { recoverStalledRun, planDailyRecovery } from '../../monitor/server/recovery.mjs'
import { evaluateStall } from '../../monitor/server/watchdog.mjs'

test('recovery uses current participation and progress independently from displayed daily outcomes', async () => {
    let selected
    const result = await recoverStalledRun({
        runId: 'scope-test',
        accounts: [
            {
                index: 1,
                email: 'active@example.invalid',
                status: 'running',
                currentRunStatus: 'running',
                includedInCurrentRun: true
            },
            {
                index: 2,
                email: 'done@example.invalid',
                status: 'completed',
                currentRunStatus: 'completed',
                includedInCurrentRun: true
            },
            {
                index: 3,
                email: 'other@example.invalid',
                status: 'failed',
                currentRunStatus: 'not_run',
                includedInCurrentRun: false
            },
            {
                index: 4,
                email: 'waiting@example.invalid',
                status: 'completed',
                currentRunStatus: 'waiting',
                includedInCurrentRun: true
            }
        ],
        save: () => {},
        stop: async () => ({ ok: true }),
        readStatus: async () => ({ state: 'idle', runId: 'scope-test' }),
        retry: async indexes => {
            selected = indexes
            return 123
        },
        canRetry: () => true,
        noteRetry: () => {}
    })
    assert.equal(result.state, 'scheduled')
    assert.deepEqual(selected, [1, 4])
})

test('watchdog ignores excluded daily outcomes and evaluates only current active progress', () => {
    const at = '2026-11-08T01:00:00.000Z'
    const row = {
        index: 1,
        email: 'scope@example.invalid',
        status: 'running',
        currentRunStatus: 'running',
        attributionReliable: true,
        currentTask: { title: 'SEARCH', at }
    }
    const now = Date.parse(at) + 3600000
    assert.equal(evaluateStall({ state: 'running', accounts: [{ ...row, includedInCurrentRun: false }], now }), null)
    assert.equal(evaluateStall({ state: 'running', accounts: [{ ...row, currentRunStatus: 'completed' }], now }), null)
    assert.equal(
        evaluateStall({ state: 'running', accounts: [{ ...row, includedInCurrentRun: true }], now })?.email,
        row.email
    )
})

test('the daily guard counts confirmed account completions across midnight without moving earlier account results', () => {
    const accounts = [
        { index: 1, email: 'first@example.invalid' },
        { index: 2, email: 'second@example.invalid' }
    ]
    const meta = {
        startedAt: '2026-11-07T15:30:00.000Z',
        endedAt: '2026-11-07T17:00:00.000Z',
        accounts: accounts.map(account => ({ email: account.email, success: true }))
    }
    const options = {
        now: new Date('2026-11-07T18:00:00.000Z'),
        scheduledAt: new Date('2026-11-07T16:00:00.000Z'),
        accounts,
        records: [],
        metas: [meta]
    }
    assert.equal(planDailyRecovery(options).action, 'skip')
    meta.accounts[0].live = { lastUpdateTs: '2026-11-07T15:50:00.000Z' }
    const plan = planDailyRecovery(options)
    assert.equal(plan.action, 'start')
    assert.deepEqual(plan.indexes, [1])
})
