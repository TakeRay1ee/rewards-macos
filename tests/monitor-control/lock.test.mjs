import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { acquireSchedulerLock, releaseSchedulerLock } from '../../monitor/server/schedulerLock.mjs'
import { processIdentity } from '../../scripts/api/runIdentity.js'

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-scheduler-lock-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return path.join(dir, '.scheduler.lock')
}

test('a live scheduler keeps ownership even when the lock is older than six hours', t => {
    const file = fixture(t)
    const first = acquireSchedulerLock(file)
    assert.equal(first.ok, true)
    const old = new Date(Date.now() - 8 * 3600_000)
    fs.utimesSync(first.databaseFile, old, old)
    assert.equal(acquireSchedulerLock(file).ok, false)
    assert.equal(releaseSchedulerLock(first), true)
    assert.equal(fs.existsSync(file), false)
})

test('a definitely dead scheduler lock is immediately reclaimed', t => {
    const file = fixture(t)
    fs.writeFileSync(
        file,
        JSON.stringify({
            token: 'old-owner',
            ownerIdentity: { pid: 1234, birth: 'old', pgid: 1234, commandHash: 'old' }
        })
    )
    const held = acquireSchedulerLock(file, { identityStatus: () => 'gone' })
    assert.equal(held.ok, true)
    assert.notEqual(held.token, 'old-owner')
    assert.equal(releaseSchedulerLock(held), true)
})

test('PID reuse is distinct from a still running owner', t => {
    const file = fixture(t)
    fs.writeFileSync(
        file,
        JSON.stringify({
            token: 'reused-owner',
            ownerIdentity: { pid: 1234, birth: 'old', pgid: 1234, commandHash: 'old' }
        })
    )
    const held = acquireSchedulerLock(file, { identityStatus: () => 'reused' })
    assert.equal(held.ok, true)
    releaseSchedulerLock(held)
})

test('an unidentifiable legacy lock stays intact and requests attention', t => {
    const file = fixture(t)
    const legacy = JSON.stringify({ pid: process.pid, at: '2020-01-01' })
    fs.writeFileSync(file, legacy)
    const held = acquireSchedulerLock(file)
    assert.equal(held.ok, false)
    assert.match(held.reason, /身份|确认/)
    assert.equal(fs.readFileSync(file, 'utf8'), legacy)
})

test('an old handle cannot release a newer owner lock', t => {
    const file = fixture(t)
    const old = acquireSchedulerLock(file)
    assert.equal(releaseSchedulerLock(old), true)
    const newer = acquireSchedulerLock(file)
    assert.equal(releaseSchedulerLock(old), false)
    assert.equal(acquireSchedulerLock(file).ok, false)
    releaseSchedulerLock(newer)
})

test('unknown native identity never reaps a lock and failed identity capture never acquires', t => {
    const file = fixture(t)
    fs.writeFileSync(file, JSON.stringify({ token: 'unknown', ownerIdentity: processIdentity(process.pid) }))
    assert.equal(acquireSchedulerLock(file, { identityStatus: () => 'unknown' }).ok, false)
    fs.unlinkSync(file)
    assert.equal(acquireSchedulerLock(file, { processIdentity: () => null }).ok, false)
    assert.equal(fs.existsSync(file), false)
})

test('a process exit releases recoverability immediately, without a six-hour timeout', async t => {
    const file = fixture(t)
    const moduleUrl = new URL('../../monitor/server/schedulerLock.mjs', import.meta.url).href
    const script = `import { acquireSchedulerLock } from ${JSON.stringify(moduleUrl)}; const lock = acquireSchedulerLock(${JSON.stringify(file)}); console.log(JSON.stringify(lock)); process.exit(lock.ok ? 0 : 1)`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        stdio: ['ignore', 'pipe', 'ignore']
    })
    const exit = once(child, 'exit')
    let out = ''
    child.stdout.on('data', data => {
        out += data
    })
    assert.equal((await exit)[0], 0)
    assert.equal(JSON.parse(out).ok, true)
    const held = acquireSchedulerLock(file)
    assert.equal(held.ok, true)
    releaseSchedulerLock(held)
})

test('simultaneous scheduler processes have exactly one lock owner', async t => {
    const file = fixture(t)
    const moduleUrl = new URL('../../monitor/server/schedulerLock.mjs', import.meta.url).href
    const children = []
    t.after(() => {
        for (const child of children) {
            try {
                child.kill('SIGKILL')
            } catch {}
        }
    })
    const attempts = Array.from(
        { length: 5 },
        () =>
            new Promise((resolve, reject) => {
                const script = `import { acquireSchedulerLock, releaseSchedulerLock } from ${JSON.stringify(moduleUrl)}; const lock = acquireSchedulerLock(${JSON.stringify(file)}); console.log(JSON.stringify(lock)); if (!lock.ok) process.exit(0); process.stdin.once('data', () => { releaseSchedulerLock(lock); process.exit(0) });`
                const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
                    stdio: ['pipe', 'pipe', 'ignore']
                })
                children.push(child)
                child.once('error', reject)
                let out = ''
                child.stdout.on('data', data => {
                    out += data
                    if (out.includes('\n')) resolve({ child, lock: JSON.parse(out.split('\n')[0]) })
                })
            })
    )
    const results = await Promise.all(attempts)
    const owners = results.filter(result => result.lock.ok)
    assert.equal(owners.length, 1)
    const owner = owners[0].child
    const exit = once(owner, 'exit')
    owner.stdin.write('release\n')
    assert.equal((await exit)[0], 0)
})
