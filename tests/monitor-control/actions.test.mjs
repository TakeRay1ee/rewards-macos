import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeIndexes, launchctlArgs } from '../../monitor/server/control.mjs'
test('account selection accepts all configured safe positive slots, without silently dropping invalid values', () => {
    assert.deepEqual(normalizeIndexes([1000, 1, 100, 100], [1, 100, 1000]), [1, 100, 1000])
    assert.equal(normalizeIndexes([1, 100], [1]), null)
    for (const x of [[1, 0], [1, 1.5], [1, NaN], [1, '2'], [], null]) assert.equal(normalizeIndexes(x), null)
})
test('restart explicitly terminates an already running LaunchAgent', () => {
    assert.deepEqual(launchctlArgs('kickstart', 'local.rewards.api', 501), [
        'kickstart',
        '-k',
        'gui/501/local.rewards.api'
    ])
})
