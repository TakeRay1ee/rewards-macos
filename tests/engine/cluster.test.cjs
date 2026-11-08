const test = require('node:test'),
    assert = require('node:assert/strict'),
    fs = require('node:fs'),
    path = require('node:path'),
    vm = require('node:vm')
const { EventEmitter } = require('node:events')
const ts = require('typescript'),
    { root, loadSource } = require('./source-loader.cjs')
const Util = loadSource('src/util/Utils.ts', {
    ms: () => 0,
    './Humanize': { waitForQuietHours: async () => {} }
}).default
const source = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8')
function publicRun(cluster, exit) {
    const run = source.slice(source.indexOf('    async run():'), source.indexOf('    private runWorker('))
    const js = ts.transpileModule(`class Bot { ${run} };globalThis.Bot=Bot`, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    const context = {
        cluster,
        pkg: { version: 'test' },
        configureHumanize() {},
        shouldSkipRunToday: () => false,
        waitForQuietHours: async () => {},
        ensureClawBotReady: async () => {},
        markRunSucceeded() {},
        flushAllWebhooks: async () => {},
        sendDiscord() {},
        sendNtfy() {},
        sendTelegram() {},
        process: { pid: 999, exit },
        console
    }
    vm.runInNewContext(js, context)
    const bot = new context.Bot()
    Object.assign(bot, {
        accounts: [{ email: 'a@example.invalid' }, { email: 'b@example.invalid' }],
        config: { clusters: 2, webhook: {} },
        utils: { chunkArray: a => a.map(x => [x]) },
        logger: { info() {}, warn() {}, error() {} },
        waitBeforeNextAccount: async () => new Promise(r => setImmediate(r)),
        sendPushPlusSummary: async () => {},
        sendServerChanSummary: async () => {},
        sendClawBotSummary: async () => {},
        exitedWorkers: []
    })
    return bot
}
test('public run settles workers that exit during later worker startup delays exactly once', async () => {
    const cluster = new EventEmitter()
    cluster.isPrimary = true
    let count = 0,
        exits = []
    cluster.fork = () => {
        const worker = new EventEmitter()
        worker.id = ++count
        worker.process = { pid: 1000 + count }
        worker.send = () =>
            queueMicrotask(() => {
                cluster.emit('disconnect', worker)
                cluster.emit('exit', worker, worker.id === 1 ? 1 : 0, null)
                cluster.emit('exit', worker, 0, null)
            })
        return worker
    }
    const bot = publicRun(cluster, code => exits.push(code))
    await bot.run()
    await new Promise(r => setImmediate(r))
    assert.equal(count, 2)
    assert.equal(bot.activeWorkers, 0)
    assert.deepEqual(exits, [1])
})
test('a fork failure still settles already spawned workers and ends the batch as failed', async () => {
    const cluster = new EventEmitter()
    cluster.isPrimary = true
    let count = 0,
        exits = []
    cluster.fork = () => {
        if (++count === 2) throw new Error('synthetic fork failure')
        const worker = new EventEmitter()
        worker.id = count
        worker.process = { pid: 1000 + count }
        worker.send = () => queueMicrotask(() => cluster.emit('exit', worker, 0, null))
        return worker
    }
    const bot = publicRun(cluster, code => exits.push(code))
    await assert.doesNotReject(() => bot.run())
    await new Promise(r => setImmediate(r))
    assert.equal(bot.activeWorkers, 0)
    assert.deepEqual(exits, [1])
})

test('three workers start with account delays and then overlap without serializing their tasks', async () => {
    const cluster = new EventEmitter()
    cluster.isPrimary = true
    const workers = []
    const events = []
    const exits = []
    cluster.fork = () => {
        const worker = new EventEmitter()
        worker.id = workers.length + 1
        worker.process = { pid: 1000 + worker.id }
        worker.send = payload => {
            worker.payload = payload
            events.push(`start:${worker.id}`)
        }
        workers.push(worker)
        return worker
    }
    const bot = publicRun(cluster, code => exits.push(code))
    bot.accounts.push({ email: 'c@example.invalid' })
    bot.config.clusters = 3
    bot.utils = new Util()
    bot.waitBeforeNextAccount = async email => {
        events.push(`delay:${email}`)
        await new Promise(resolve => setImmediate(resolve))
    }
    await bot.run()
    assert.deepEqual(events, ['start:1', 'delay:b@example.invalid', 'start:2', 'delay:c@example.invalid', 'start:3'])
    assert.equal(bot.activeWorkers, 3)
    assert.deepEqual(
        workers.map(worker => Array.from(worker.payload.chunk, account => account.email)),
        [['a@example.invalid'], ['b@example.invalid'], ['c@example.invalid']]
    )
    assert.deepEqual(exits, [])
    for (const worker of workers) cluster.emit('exit', worker, 0, null)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(bot.activeWorkers, 0)
    assert.deepEqual(exits, [0])
})

test('account chunks occupy every allowed worker and preserve all accounts exactly once', () => {
    const utils = new Util()
    for (let size = 0; size <= 10; size++) {
        const accounts = Array.from({ length: size }, (_, index) => index + 1)
        const chunks = utils.chunkArray(accounts, 3)
        assert.equal(chunks.length, Math.min(size, 3))
        assert.deepEqual(Array.from(chunks.flat()), accounts)
        if (size) {
            const sizes = Array.from(chunks, chunk => chunk.length)
            assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1)
            assert.ok(sizes.every(value => value > 0))
        }
    }
    assert.throws(() => utils.chunkArray([1, 2, 3], 0), /positive/)
})
