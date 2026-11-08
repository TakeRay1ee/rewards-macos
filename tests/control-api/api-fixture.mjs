import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../../', import.meta.url))
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
export function alive(pid) {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}
export async function waitFor(fn, timeout = 5000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        if (await fn()) return
        await pause(30)
    }
    assert.fail('Timed out waiting for isolated API behavior')
}
export async function freePort() {
    const socket = net.createServer().listen(0, '127.0.0.1')
    await once(socket, 'listening')
    const port = socket.address().port
    await new Promise(resolve => socket.close(resolve))
    assert.ok(port !== 3000 && port !== 3010)
    return port
}
export async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-control-test-'))
    const apiDir = path.join(dir, 'scripts/api')
    fs.mkdirSync(apiDir, { recursive: true })
    for (const name of fs
        .readdirSync(path.join(project, 'scripts/api'))
        .filter(n => n.endsWith('.js') && !n.includes('.test.'))) {
        fs.copyFileSync(path.join(project, 'scripts/api', name), path.join(apiDir, name))
    }
    fs.copyFileSync(path.join(project, 'scripts/env.js'), path.join(dir, 'scripts/env.js'))
    fs.writeFileSync(path.join(dir, 'scripts/package.json'), '{"type":"module"}')
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"isolated-control-test","version":"0.0.0"}')
    const worker = path.join(dir, 'heartbeat.cjs')
    fs.copyFileSync(fileURLToPath(new URL('./fixtures/heartbeat.cjs', import.meta.url)), worker)
    fs.writeFileSync(
        path.join(dir, '.env'),
        [
            'API_HOST=127.0.0.1',
            'API_TOKEN=synthetic-test-token',
            `API_RUN_COMMAND=${process.execPath}`,
            `API_RUN_ARGS=${JSON.stringify([worker])}`,
            'ACCOUNT_1_EMAIL=one@example.invalid',
            'ACCOUNT_2_EMAIL=two@example.invalid',
            'API_STOP_TIMEOUT_MS=300',
            ''
        ].join('\n')
    )
    const children = [],
        workerPids = new Set()
    t.after(async () => {
        for (const child of children) {
            try {
                process.kill(-child.pid, 'SIGKILL')
            } catch {}
        }
        for (const pid of workerPids) {
            try {
                process.kill(-pid, 'SIGKILL')
            } catch {}
        }
        await Promise.all(
            children.map(child =>
                child.exitCode != null || child.signalCode
                    ? Promise.resolve()
                    : Promise.race([once(child, 'exit'), pause(1000)])
            )
        )
        // Other test teardown hooks may still own a synthetic worker in this
        // directory. Allow their signal and any last file writes to settle.
        await pause(150)
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    })
    async function launch(port = null) {
        port ??= await freePort()
        const child = spawn(process.execPath, [path.join(apiDir, 'server.js')], {
            cwd: dir,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', LANG: 'C', API_PORT: String(port) }
        })
        children.push(child)
        let output = ''
        child.stdout.on('data', chunk => {
            output += chunk.toString()
        })
        child.stderr.on('data', chunk => {
            output += chunk.toString()
        })
        await waitFor(() => output.includes('__API_READY__') || child.exitCode != null)
        assert.ok(output.includes('__API_READY__'), output)
        async function request(method, endpoint, body) {
            const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
                method,
                headers: { Authorization: 'Bearer synthetic-test-token', 'Content-Type': 'application/json' },
                body: body == null ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(3000)
            })
            const data = await res.json()
            if (data.pid) workerPids.add(data.pid)
            return { status: res.status, body: data }
        }
        return { child, port, request }
    }
    return {
        dir,
        launch,
        trackWorker: worker => workerPids.add(typeof worker === 'number' ? worker : worker.pid),
        beats: pid => {
            try {
                return fs
                    .readFileSync(path.join(dir, `beats-${pid}`), 'utf8')
                    .trim()
                    .split('\n').length
            } catch {
                return 0
            }
        }
    }
}
