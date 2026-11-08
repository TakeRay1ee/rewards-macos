import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildLedger } from '../../monitor/server/pointsLedger.mjs'

const email = 'ledger@example.invalid'
function fixture(t, records) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reward-ledger-test-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    for (const [index, record] of records.entries()) {
        const dir = path.join(root, String(index))
        fs.mkdirSync(dir)
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(record))
    }
    return root
}
const record = (date, collected) => ({ startedAt: `${date}T12:00:00`, accounts: [{ email, collected }] })

test('ledger preserves unknown earnings independently from an observed zero and a mixed total', t => {
    const runsDir = fixture(t, [
        record('2026-01-01', null),
        record('2026-01-02', 0),
        record('2026-01-03', null),
        record('2026-01-03', 8)
    ])
    const rows = buildLedger({
        runsDir,
        emails: [email, 'missing@example.invalid'],
        now: new Date('2026-01-03T12:00:00+08:00')
    }).days
    assert.equal(rows.find(r => r.date === '2026-01-01').accounts[email].collected, null)
    assert.equal(rows.find(r => r.date === '2026-01-01').total, null)
    assert.equal(rows.find(r => r.date === '2026-01-02').accounts[email].collected, 0)
    assert.equal(rows.find(r => r.date === '2026-01-03').accounts[email].collected, 8)
    assert.equal(rows[0].accounts['missing@example.invalid'].collected, null)
})

test('week totals include exactly seven local calendar dates across the year, regardless of missing dates or response size', t => {
    const runsDir = fixture(t, [
        record('2025-12-27', 100),
        record('2025-12-28', 7),
        record('2026-01-03', 3),
        record('2026-01-04', 200)
    ])
    const ledger = buildLedger({ runsDir, emails: [email], days: 1, now: new Date('2026-01-03T23:30:00+08:00') })
    assert.equal(ledger.today, '2026-01-03')
    assert.equal(ledger.weekTotals[email], 10)
})

test('daily windows use Shanghai calendar dates and custom ranges include old records without filling missing observations', t => {
    const runsDir = fixture(t, [
        { ...record('2025-12-31', 7), startedAt: '2025-12-31T16:01:00Z' },
        { ...record('2026-01-01', 0), startedAt: '2026-01-01T16:01:00Z' },
        record('2025-01-01', 50),
        record('2025-12-20', 99)
    ])
    const now = new Date('2026-01-01T16:30:00Z')
    const ledger = buildLedger({ runsDir, emails: [email, 'missing@example.invalid'], days: 2, now })
    assert.equal(ledger.timeZone, 'Asia/Shanghai')
    assert.equal(ledger.today, '2026-01-02')
    assert.deepEqual(ledger.range, { from: '2026-01-01', to: '2026-01-02' })
    assert.deepEqual(
        ledger.days.map(row => row.date),
        ['2026-01-02', '2026-01-01']
    )
    assert.deepEqual(
        ledger.days.map(row => row.total),
        [0, 7]
    )
    assert.equal(ledger.weekTotals['missing@example.invalid'], null)
    assert.equal(ledger.todayTotals[email], 0)
    const old = buildLedger({ runsDir, emails: [email], from: '2025-01-01', to: '2025-01-07', now })
    assert.equal(old.days[0].total, 50)
    assert.equal(old.rangeRunCount, 1)
    assert.equal(old.runCount, 4)
})
