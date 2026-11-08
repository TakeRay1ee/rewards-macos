const test = require('node:test'),
    assert = require('node:assert/strict')
const { loadSource } = require('./source-loader.cjs')
const activityResults = loadSource('src/util/ActivityResults.ts')
const base = loadSource('src/functions/activities/BaseActivity.ts', { '../../util/ActivityResults': activityResults })
async function searches(measure) {
    let queries = 0,
        measurements = 0
    const warnings = [],
        failures = []
    const tracker = {
        started: true,
        offerLost: false,
        context: 'SEARCH-BONUS',
        maxSearches: 5,
        stagnantLimit: 10,
        prepare: async () => true,
        done: () => false,
        measure: async () => measure(++measurements),
        progress: () => ''
    }
    const { Search } = loadSource('src/functions/activities/search/BrowserSearch.ts', {
        '../../../constants/urls': { URLs: { bing: { origin: 'https://example.invalid' } } },
        '../../SearchQueryQueue': {
            SearchQueryQueue: class {
                async prepare() {
                    return 1
                }
                async next() {
                    return 'query-' + ++queries
                }
            }
        },
        '../BaseActivity': base,
        './BonusTracker': {
            BonusTracker: class {
                constructor() {
                    return tracker
                }
            }
        },
        './SearchProgress': {},
        '../../../util/Humanize': { getSearchTargetRatio: () => 1 }
    })
    const bot = {
        isMobile: true,
        userData: { currentPoints: 0 },
        recordActivityFailure: (name, error) => failures.push([name, error]),
        logger: {
            info() {},
            debug() {},
            warn(...a) {
                warnings.push(a.join(' '))
            },
            error() {}
        },
        utils: { wait: async () => {}, randomDelay: () => 0 },
        config: { searchSettings: { clusterSearch: false, searchDelay: { min: 0, max: 0 } } },
        browser: {
            func: { synchronizeActiveBrowserCookies: async () => {} },
            utils: { tryDismissAllMessages: async () => {}, ghostClick: async () => {} }
        }
    }
    const page = {
        goto: async () => {},
        waitForLoadState: async () => {},
        evaluate: async () => {},
        keyboard: { press: async () => {}, type: async () => {} },
        locator: () => ({ waitFor: async () => {}, fill: async () => {} })
    }
    const scope = new activityResults.ActivityResults()
    await scope.run(() => new Search(bot).doBonusSearches(page))
    return { queries, measurements, warnings, failures, error: scope.summary() }
}
test('three consecutive measurement failures end a search session', async () => {
    const result = await searches(() => {
        throw new Error('measurement unavailable')
    })
    assert.equal(result.queries, 3)
    assert.equal(result.measurements, 3)
    assert.match(result.error, /measurement unavailable/)
})
test('a complete successful search resets the failure streak', async () => {
    const result = await searches(n => {
        if (n !== 3) throw new Error('measurement unavailable')
        return 0
    })
    assert.equal(result.queries, 5)
    assert.ok(result.warnings.some(x => x.includes('单次搜索失败 2/3')))
})
test('transient search measurement errors that recover do not fail the account', async () => {
    const result = await searches(n => {
        if (n < 3) throw new Error('temporary failure')
        return 0
    })
    assert.equal(result.queries, 5)
    assert.equal(result.error, undefined)
})
test('missing mobile quota emits one diagnostic while desktop search remains enabled', async () => {
    const progress = loadSource('src/functions/activities/search/SearchProgress.ts')
    const { SearchManager } = loadSource('src/functions/activities/search/SearchManager.ts', {
        '../../../index': { executionContext: { run: (_c, fn) => fn() } },
        '../../../constants/urls': { URLs: { bing: { origin: 'https://example.invalid' } } },
        './SearchProgress': progress
    })
    const logs = []
    const bot = {
        config: { workers: { doMobileSearch: true, doDesktopSearch: true } },
        logger: { debug: (...a) => logs.push(a.join(' ')), info() {} },
        browser: {
            func: {
                getDashboardData: async () => ({
                    dashboard: { userStatus: { counters: { pcSearch: [{ pointProgress: 0, pointProgressMax: 90 }] } } }
                })
            }
        }
    }
    const plan = await new SearchManager(bot).getSearchPoints()
    assert.equal(plan.doMobile, false)
    assert.equal(plan.doDesktop, true)
    assert.equal(logs.length, 1)
})
