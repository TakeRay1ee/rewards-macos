import test from 'node:test'
import assert from 'node:assert/strict'
import { readSessionState } from '../../monitor/server/sessions.mjs'
test('session overview uses the engine API metadata and never guesses a local directory', async () => {
    const r = await readSessionState({
        sessions: async () => ({
            databaseExists: true,
            sessions: [
                {
                    email: 'a@example.invalid',
                    platform: 'desktop',
                    updatedAt: '2026-11-08T00:00:00Z',
                    hasStorageState: true,
                    cookieCount: 2
                }
            ]
        })
    })
    assert.equal(r.available, true)
    assert.equal(r.rows[0].platforms.desktop.hasStorageState, true)
    assert.equal(r.rows[0].platforms.desktop.cookieCount, 2)
    assert.equal(r.rows[0].platforms.desktop.bytes, null)
})
test('unavailable upstream sessions remain unknown with an explicit reason', async () => {
    const r = await readSessionState({
        sessions: async () => {
            throw Error('upstream unavailable')
        }
    })
    assert.equal(r.available, false)
    assert.match(r.reason, /upstream unavailable/)
})
