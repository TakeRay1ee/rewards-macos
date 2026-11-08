import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProcessManager } from '../../scripts/api/processManager.js'

const fake = fileURLToPath(new URL('./fixtures/heartbeat.cjs', import.meta.url))
async function waitFor(fn, timeout = 3000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
        if (fn()) return
        await new Promise(r => setTimeout(r, 20))
    }
    assert.fail('Condition did not become true before timeout')
}
test('force stop immediately upgrades an already pending graceful stop', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-pm-test-'))
    const pm = new ProcessManager({
        command: process.execPath,
        args: [fake, '--ignore-term'],
        cwd: dir,
        stateFile: false,
        stopTimeoutMs: 3000
    })
    const { pid } = pm.start()
    t.after(() => {
        try {
            process.kill(-pid, 'SIGKILL')
        } catch {}
        fs.rmSync(dir, { recursive: true, force: true })
    })
    await waitFor(() => pm.getLogs().logs.some(e => e.message.includes('AUDIT_READY_HEARTBEAT')))
    const stopping = pm.stop()
    await new Promise(r => setTimeout(r, 75))
    const sinceForce = Date.now()
    await pm.stop({ force: true })
    await stopping
    assert.ok(Date.now() - sinceForce < 1000, 'Explicit force must not wait for the graceful-stop timeout')
    assert.equal(pm.getStatus().state, 'idle')
})
