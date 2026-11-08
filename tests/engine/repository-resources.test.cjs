const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { loadSource } = require('./source-loader.cjs')

class ImmediateQueue {
    add(fn) {
        return fn()
    }
}

const logger = { info() {}, debug() {}, warn() {}, error() {} }

test('notification severity does not mutate the shared ntfy priority for later informational messages', async () => {
    const requests = []
    const { sendNtfy } = loadSource('src/logging/Ntfy.ts', {
        '../util/Http': { httpRequest: async request => requests.push(request) },
        'p-queue': ImmediateQueue,
        './Queue': { flushQueue: async () => {} }
    })
    const config = Object.freeze({ url: 'https://notify.example.invalid', priority: 3 })
    await sendNtfy(config, 'synthetic error', 'error')
    await sendNtfy(config, 'synthetic info', 'info')
    await sendNtfy(config, 'synthetic warning', 'warn')
    await sendNtfy(config, 'synthetic info again', 'info')
    assert.deepEqual(
        requests.map(request => request.headers.Priority),
        ['5', '3', '4', '3']
    )
    assert.equal(config.priority, 3)
})

test('failed queue drain clears its deadline while preserving the original rejection', async () => {
    const cleared = []
    const { flushQueue } = loadSource(
        'src/logging/Queue.ts',
        {},
        {
            setTimeout: () => 123,
            clearTimeout: value => cleared.push(value)
        }
    )
    const failure = new Error('synthetic queue failure')
    await assert.rejects(flushQueue({ onIdle: () => Promise.reject(failure) }), error => error === failure)
    assert.deepEqual(cleared, [123])
})

test('Telegram preformatted logs preserve backticks and backslashes in MarkdownV2', async () => {
    const requests = []
    const { sendTelegram } = loadSource('src/logging/Telegram.ts', {
        '../util/Http': { httpRequest: async request => requests.push(request) },
        'p-queue': ImmediateQueue,
        './Queue': { flushQueue: async () => {} }
    })
    await sendTelegram({ botToken: 'synthetic-token', chatId: 'synthetic-chat' }, 'path C:\\tmp\\a and `code`', 'info')
    assert.equal(requests[0].data.text, 'ℹ️\n```\npath C:\\\\tmp\\\\a and \\`code\\`\n```')
    assert.equal(requests[0].data.parse_mode, 'MarkdownV2')
})

test('structured log timestamps remain parseable when the host locale changes', async () => {
    const lines = []
    class LocaleDate extends Date {
        toLocaleString() {
            return '08.11.2026, 12:34:56'
        }
    }
    const chalk = { bgCyan: value => value, bgBlue: value => value, bgMagenta: value => value }
    const { Logger } = loadSource(
        'src/logging/Logger.ts',
        {
            chalk,
            cluster: { isPrimary: true },
            fs: { mkdirSync() {}, readdirSync: () => [], appendFileSync() {} },
            path,
            './Discord': { sendDiscord() {} },
            './Ntfy': { sendNtfy() {} },
            './Telegram': { sendTelegram() {} },
            '../util/ErrorDiagnostic': { errorDiagnostic() {} },
            '../util/Load': { getProjectRoot: () => '/synthetic-project' }
        },
        { Date: LocaleDate, console: { log: value => lines.push(value), warn() {}, error() {} } }
    )
    const instance = new Logger({ config: { webhook: {} }, userData: { userName: 'account@example.invalid' } })
    instance.info('main', 'ACCOUNT-END', 'synthetic completion')
    assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/)
    const { parseLogLine } = await import('../../scripts/api/logParser.js')
    const parsed = parseLogLine(lines[0])
    assert.equal(parsed.parsed, true)
    assert.equal(parsed.title, 'ACCOUNT-END')
    assert.equal(parsed.message, 'synthetic completion')
})

test('a failed native UA probe closes the temporary context even when creating its first page fails', async () => {
    const Browser = loadSource('src/browser/Browser.ts', {
        patchright: {},
        'fingerprint-injector': {},
        'fingerprint-generator': { FingerprintGenerator: class {} },
        '../util/SessionStore': {},
        '../util/Locale': {},
        '../util/Proxy': {},
        './UserAgent': { UserAgentManager: class {} },
        '../constants/urls': { URLs: {} }
    }).default
    let closes = 0
    const failure = new Error('synthetic newPage failure')
    const browser = new Browser({ logger })
    await assert.rejects(
        browser.resolveNativeUserAgent({
            newContext: async () => ({
                newPage: async () => {
                    throw failure
                },
                close: async () => {
                    closes++
                }
            })
        }),
        error => error === failure
    )
    assert.equal(closes, 1)
})

test('closing a broken browser context still closes the owning browser process', async () => {
    const BrowserFunc = loadSource('src/browser/BrowserFunc.ts', {
        '../functions/activities/search/SearchProgress': {},
        '../functions/activities/app/CheckInState': {},
        '../constants/urls': { URLs: {} },
        '../constants/userAgents': {},
        '../util/SessionStore': {},
        '../util/Utils': { isBrowserClosedError: () => false },
        './FlyoutDashboard': {}
    }).default
    let rootCloses = 0
    const browser = {
        browser: () => ({
            close: async () => {
                rootCloses++
            }
        }),
        close: async () => {
            throw new Error('synthetic close failure')
        }
    }
    await new BrowserFunc({ logger }).closeBrowser(browser, 'account@example.invalid', false)
    assert.equal(rootCloses, 1)
})

test('failed navigation of an added tab closes that tab and returns the existing usable page', async () => {
    const BrowserUtils = loadSource('src/browser/BrowserUtils.ts', {
        '../constants/urls': { REWARDS_BASE_URL: 'https://rewards.example.invalid' },
        'ghost-cursor-playwright-port': {}
    }).default
    let extraCloses = 0
    const pages = []
    const context = {
        pages: () => pages,
        newPage: async () => {
            const extra = {
                goto: async () => {
                    throw new Error('synthetic navigation failure')
                },
                close: async () => {
                    extraCloses++
                    pages.pop()
                }
            }
            pages.push(extra)
            return extra
        }
    }
    const original = { context: () => context }
    pages.push(original)
    const current = await new BrowserUtils({ logger }).closeTabs(original, { minTabs: 2, maxTabs: 2 })
    assert.equal(extraCloses, 1)
    assert.equal(pages.length, 1)
    assert.equal(current, original)
})
