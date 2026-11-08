import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { planConcurrency } from '../../monitor/server/scheduler.mjs'
import { calendarDate, shiftCalendarDate, dailyScheduledAt } from '../../monitor/server/calendar.mjs'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))

test('explicit concurrency of three wins over memory estimates and legacy unlimited workers', () => {
    for (const accounts of [1, 2, 3, 4, 8]) {
        const plan = planConcurrency({ accounts, byMemory: 1, concurrency: '3', forceClusters: 'all' })
        assert.equal(plan.clusters, Math.min(accounts, 3))
        assert.equal(plan.serializedAccounts, accounts > 3)
        assert.equal(plan.forcedBy, 'env:concurrency:3')
        assert.equal(plan.limitedBy, accounts > 3 ? 'concurrency' : 'accounts')
    }
    assert.throws(() => planConcurrency({ accounts: 3, byMemory: 3, concurrency: '0' }), /正整数/)
    assert.equal(planConcurrency({ accounts: 3, byMemory: 2 }).clusters, 2)
    assert.equal(planConcurrency({ accounts: 3, byMemory: 1, forceClusters: 'all' }).clusters, 3)
})

test('Shanghai daily boundaries do not follow the host process calendar and cross month/year correctly', () => {
    const before = new Date('2026-12-31T15:59:59.999Z')
    const midnight = new Date('2026-12-31T16:00:00.000Z')
    assert.equal(calendarDate(before), '2026-12-31')
    assert.equal(calendarDate(midnight), '2027-01-01')
    assert.equal(dailyScheduledAt(before).toISOString(), '2026-12-30T16:00:00.000Z')
    assert.equal(dailyScheduledAt(midnight).toISOString(), midnight.toISOString())
    assert.equal(dailyScheduledAt(midnight, { hour: 3, minute: 5 }).toISOString(), '2026-12-31T19:05:00.000Z')
    assert.equal(shiftCalendarDate('2027-01-01', -1), '2026-12-31')
    assert.equal(shiftCalendarDate('2028-02-28', 1), '2028-02-29')
    assert.equal(shiftCalendarDate('2026-02-29', 1), null)
    assert.equal(calendarDate(null), null)
    assert.throws(() => dailyScheduledAt(midnight, { hour: 24 }), /00:00/)
})

test('scheduler selects three original account slots and writes only isolated concurrency settings', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-scheduler-test-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    fs.mkdirSync(path.join(dir, 'monitor/server'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'scripts/api'), { recursive: true })
    for (const name of ['scheduler.mjs', 'config.mjs', 'schedulerLock.mjs'])
        fs.copyFileSync(path.join(root, 'monitor/server', name), path.join(dir, 'monitor/server', name))
    fs.copyFileSync(path.join(root, 'scripts/api/runIdentity.js'), path.join(dir, 'scripts/api/runIdentity.js'))
    fs.writeFileSync(path.join(dir, 'scripts/package.json'), '{"type":"module"}')
    fs.writeFileSync(
        path.join(dir, 'monitor/server/metrics.mjs'),
        'export const readMemory=async()=>({availableBytes:512*1048576,totalBytes:16384*1048576,source:"synthetic"});export const readProcesses=async()=>({workers:[]})'
    )
    const configured = [1, 3, 7, 10].map(index => ({ index, email: `account-${index}@example.invalid` }))
    let startBody
    const server = http.createServer(async (req, res) => {
        assert.equal(req.headers.authorization, 'Bearer synthetic-test-token')
        res.setHeader('Content-Type', 'application/json')
        if (req.url === '/status') return res.end('{"state":"idle"}')
        if (req.url === '/accounts') return res.end(JSON.stringify({ accounts: configured }))
        if (req.url === '/start') {
            let raw = ''
            for await (const chunk of req) raw += chunk
            startBody = JSON.parse(raw)
            return res.end('{"started":true,"runId":"synthetic-run","pid":12345}')
        }
        res.writeHead(404)
        res.end('{}')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => new Promise(resolve => server.close(resolve)))
    fs.writeFileSync(
        path.join(dir, '.env'),
        `API_PORT=${server.address().port}\nAPI_HOST=127.0.0.1\nAPI_TOKEN=synthetic-test-token\nREWARDS_CONCURRENCY=3\nREWARDS_FORCE_CLUSTERS=all\n`
    )
    fs.writeFileSync(path.join(dir, 'config.json'), '{"clusters":1,"unrelated":"retained"}')
    const { stdout } = await execFileAsync(
        process.execPath,
        [path.join(dir, 'monitor/server/scheduler.mjs'), 'run', '--accounts', '1,3,7', '--reason', 'synthetic'],
        { cwd: dir, timeout: 10000, env: { PATH: process.env.PATH } }
    )
    const receipt = JSON.parse(stdout)
    assert.equal(receipt.result, 'started')
    assert.equal(receipt.plan.clusters, 3)
    assert.equal(receipt.plan.selectedAccounts, 3)
    assert.equal(receipt.plan.serializedAccounts, false)
    assert.equal(receipt.plan.byMemory, 0)
    assert.deepEqual(startBody, { excludedAccountIndexes: [10] })
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
    assert.equal(config.clusters, 3)
    assert.equal(config.unrelated, 'retained')
    assert.deepEqual(config.accountDelay, { min: '20s', max: '40s' })
})

test('generated daily LaunchAgent keeps midnight and Shanghai runtime without registering services', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-plist-test-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const script = fs.readFileSync(path.join(root, 'scripts/macos/install-launchd.sh'), 'utf8')
    const definition = script.slice(script.indexOf('load_agent() {'), script.indexOf('ENV_FILE='))
    await execFileAsync(
        'bash',
        [
            '-c',
            `${definition}\nloaded=0; attempts=0\nlaunchctl(){ case "$1" in print) test "$loaded" = 1;; bootout) loaded=0;; bootstrap) attempts=$((attempts+1)); if test "$attempts" -ge 3; then loaded=1; else return 1; fi;; *) return 1;; esac; }\nwrite_plist local.rewards.daily false 0 0 synthetic-scheduler run --reason daily\ntest "$attempts" = 3`
        ],
        {
            env: {
                PATH: process.env.PATH,
                AGENT_DIR: dir,
                PROJECT_ROOT: dir,
                NODE_BIN: process.execPath,
                LOG_DIR: dir,
                SCHEDULE_TIME_ZONE: 'Asia/Shanghai'
            }
        }
    )
    const plist = fs.readFileSync(path.join(dir, 'local.rewards.daily.plist'), 'utf8')
    assert.match(plist, /<key>Hour<\/key><integer>0<\/integer>/)
    assert.match(plist, /<key>Minute<\/key><integer>0<\/integer>/)
    assert.match(plist, /<key>TZ<\/key><string>Asia\/Shanghai<\/string>/)
    assert.match(plist, /<key>RunAtLoad<\/key><false\/>/)
    // The real macOS installer also expands its localized completion message.
    // A non-ASCII punctuation mark must not become part of a shell variable.
    const footer = script.slice(script.lastIndexOf('cat <<EOF'))
    assert.ok(footer.startsWith('cat <<EOF'))
    const { stdout } = await execFileAsync('bash', ['-u', '-c', footer], {
        env: {
            PATH: process.env.PATH,
            LC_ALL: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8',
            HOUR: '0',
            MINUTE: '0',
            HOST_TIME_ZONE: 'Asia/Shanghai',
            LOG_DIR: dir
        }
    })
    assert.match(stdout, /00:00（上海；系统时区 Asia\/Shanghai）/)
    await assert.rejects(
        execFileAsync(
            'bash',
            [
                '-c',
                `${definition}\nlaunchctl(){ return 1; }\nsleep(){ :; }\nload_agent local.rewards.daily synthetic.plist`
            ],
            {
                env: { PATH: process.env.PATH }
            }
        ),
        error => error.code === 1 && /加载 local\.rewards\.daily 失败/.test(error.stderr)
    )
})
