const test = require('node:test'),
    assert = require('node:assert/strict'),
    path = require('node:path')
const { loadSource } = require('./source-loader.cjs')
function fixture() {
    const files = new Map()
    let now = '2026-11-08T10:00:00+08:00'
    class Clock extends Date {
        constructor(...args) {
            super(...(args.length ? args : [now]))
        }
        static now() {
            return Date.parse(now)
        }
    }
    const fs = {
        readFileSync: p => {
            if (!files.has(p)) throw new Error('ENOENT')
            return files.get(p)
        },
        mkdirSync() {},
        writeFileSync: (p, v) => files.set(p, v),
        renameSync: (a, b) => {
            files.set(b, files.get(a))
            files.delete(a)
        },
        unlinkSync: p => files.delete(p)
    }
    const human = loadSource(
        'src/util/Humanize.ts',
        { 'node:fs': fs, './ConfigSync': { getProjectRoot: () => '/in-memory' } },
        { Date: Clock }
    )
    const config = { enabled: true, skipWhenCompletedToday: true }
    human.configureHumanize({ config: { humanize: config } })
    return {
        human,
        config,
        files,
        nextDay() {
            now = '2026-11-09T10:00:00+08:00'
        }
    }
}
test('successful A does not suppress B, new accounts or next-day work', () => {
    const { human, config, nextDay } = fixture()
    assert.equal(human.shouldSkipRunToday('a@example.invalid', config), false)
    human.markRunSucceeded('a@example.invalid', config)
    assert.equal(human.shouldSkipRunToday('a@example.invalid', config), true)
    assert.equal(human.shouldSkipRunToday('b@example.invalid', config), false)
    assert.equal(human.shouldSkipRunToday('new@example.invalid', config), false)
    nextDay()
    assert.equal(human.shouldSkipRunToday('a@example.invalid', config), false)
})
test('legacy global success cannot suppress a never-completed account and disabled mode writes no marker', () => {
    const { human, config, files } = fixture()
    files.set(path.join('/in-memory', 'logs', 'last-success.txt'), '2026-11-08')
    assert.equal(human.shouldSkipRunToday('b@example.invalid', config), false)
    human.markRunSucceeded('b@example.invalid', { enabled: false, skipWhenCompletedToday: true })
    assert.equal(files.size, 1)
})
