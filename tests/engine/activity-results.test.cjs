const test = require('node:test'),
    assert = require('node:assert/strict'),
    fs = require('node:fs'),
    path = require('node:path'),
    vm = require('node:vm')
const { AsyncLocalStorage } = require('node:async_hooks')
const ts = require('typescript'),
    { loadSource, root } = require('./source-loader.cjs')
function modules() {
    const results = loadSource('src/util/ActivityResults.ts')
    const base = loadSource('src/functions/activities/BaseActivity.ts', { '../../util/ActivityResults': results })
    const reading = loadSource('src/functions/activities/app/ReadToEarn.ts', {
        '../../../constants/urls': { URLs: { platform: { activities: 'https://example.invalid' } } },
        '../../../constants/userAgents': { BING_APP_USER_AGENT: 'synthetic' },
        '../../../util/Humanize': { getReadToEarnArticleLimit: () => 1 },
        '../BaseActivity': base
    })
    return { results, base, reading }
}
test('account activity scope retains a caught reading failure and stays isolated during concurrent work', async () => {
    const { results, reading } = modules()
    const a = new results.ActivityResults(),
        b = new results.ActivityResults()
    const bot = {
        accessToken: 'SYNTHETIC',
        isMobile: true,
        userData: { currentPoints: 100 },
        config: { searchSettings: { readDelay: { min: 0, max: 0 } } },
        http: {
            request: async () => {
                throw new Error('reading unavailable')
            }
        },
        logger: { info() {}, debug() {}, error() {}, warn() {} }
    }
    await Promise.all([
        a.run(async () => {
            await new reading.ReadToEarn(bot).doReadToEarn()
            await Promise.resolve()
        }),
        b.run(async () => {
            await Promise.resolve()
        })
    ])
    assert.match(a.summary(), /ReadToEarn.*reading unavailable/)
    assert.equal(b.summary(), undefined)
})
test('a public activity boundary records a terminal thrown error and allows the next activity', async () => {
    const { results, base } = modules()
    let later = 0
    const source = fs.readFileSync(path.join(root, 'src/functions/Activities.ts'), 'utf8')
    const mocks = { '../util/ActivityResults': results }
    for (const [, name, file] of source.matchAll(/import \{ (\w+) \} from '(\.\/activities\/[^']+)'/g))
        mocks[file] = {
            [name]: class extends base.BaseActivity {
                async run() {
                    this.markExecuted()
                }
                async claimBonusPoints() {
                    later++
                }
            }
        }
    for (const [, name, , file] of source.matchAll(/import \{ (\w+) as (\w+) \} from '([^']+)'/g))
        mocks[file] = { [name]: class {} }
    mocks['./activities/rewards/DailySet'] = {
        DailySet: class {
            async run() {
                throw new Error('daily unavailable')
            }
        }
    }
    const Activities = loadSource('src/functions/Activities.ts', mocks).default
    const activity = new Activities({ isMobile: true, logger: { error() {} } }),
        scope = new results.ActivityResults()
    await scope.run(async () => {
        assert.equal(await activity.doDailySet({}), true)
        await activity.doClaimBonusPoints()
    })
    assert.equal(later, 1)
    assert.match(scope.summary(), /doDailySet.*daily unavailable/)
})
test('Main aggregates a failed independent activity, continues later activities, and starts next account clean', async () => {
    const { results, base, reading } = modules()
    let later = 0
    const activitiesSource = fs.readFileSync(path.join(root, 'src/functions/Activities.ts'), 'utf8')
    const activityMocks = { '../util/ActivityResults': results }
    for (const [, name, file] of activitiesSource.matchAll(/import \{ (\w+) \} from '(\.\/activities\/[^']+)'/g))
        activityMocks[file] = {
            [name]: class extends base.BaseActivity {
                async run() {}
                async claimBonusPoints() {
                    later++
                }
            }
        }
    activityMocks['./activities/app/ReadToEarn'] = reading
    // Aliased imports are not reached in this test but must resolve at module load.
    for (const [, name, , file] of activitiesSource.matchAll(/import \{ (\w+) as (\w+) \} from '([^']+)'/g))
        activityMocks[file] = { [name]: class {} }
    const Activities = loadSource('src/functions/Activities.ts', activityMocks).default
    const source = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8')
    const body = source.slice(source.indexOf('    async Main('), source.indexOf('\n}\n\nexport { executionContext }'))
    const js = ts.transpileModule(`class Bot { ${body} };globalThis.Bot=Bot`, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    const ctx = {
        executionContext: new AsyncLocalStorage(),
        ActivityResults: results.ActivityResults,
        recordActivityFailure: results.recordActivityFailure,
        normalizeCountry: () => 'CN',
        resolveAccountLocale: () => ({ country: 'CN', language: 'zh-CN', locale: 'zh-CN', acceptLanguage: 'zh-CN' }),
        saveResolvedRegion() {},
        AbortController,
        Error,
        console
    }
    vm.runInNewContext(js, ctx)
    const bot = new ctx.Bot()
    const context = { newPage: async () => ({}), cookies: async () => [] }
    let fail = true
    Object.assign(bot, {
        config: {
            workers: { doReadToEarn: true, doDailySet: true, doClaimBonusPoints: true },
            experimental: { apiSearch: true, apiSearchOnBing: true },
            searchSettings: { readDelay: { min: 0, max: 0 } }
        },
        browserFactory: { createBrowser: async () => ({ context, fingerprint: {} }) },
        login: { login: async () => {}, getAppAccessToken: async () => 'SYNTHETIC' },
        browser: {
            func: {
                checkpointActiveSession: async () => {},
                closeBrowser: async () => {},
                getDashboardData: async () => ({
                    dashboard: {
                        userWarnings: [],
                        userProfile: { attributes: { country: 'CN' } },
                        userStatus: { availablePoints: 100 }
                    }
                }),
                getAppDashboardData: async () => ({ response: { promotions: [] } }),
                getAppEarnablePoints: async () => ({ totalEarnablePoints: 0 }),
                getBrowserEarnablePoints: async () => ({}),
                getCurrentPoints: async () => 100
            }
        },
        userData: { currentPoints: 100 },
        accountLocale: {},
        nextActions: {},
        http: {
            setDefaultHeaders() {},
            request: async () => {
                if (fail) throw new Error('reading unavailable')
                return { status: 200, data: { response: { balance: 100 } } }
            }
        },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        searchManager: { getSearchPoints: async () => ({ doMobile: false, doDesktop: false }) },
        gapBetweenWorkers: async () => {}
    })
    bot.activities = new Activities(bot)
    const first = await bot.Main({ email: 'a@example.invalid', geoLocale: 'CN' })
    assert.match(first.error, /ReadToEarn.*reading unavailable/)
    assert.equal(later, 1)
    fail = false
    const second = await bot.Main({ email: 'b@example.invalid', geoLocale: 'CN' })
    assert.equal(second.error, undefined)
    assert.equal(later, 2)
})
function urlRewardFixture(responses) {
    const { results, base } = modules()
    let attempts = 0,
        repairs = 0
    const { UrlReward } = loadSource('src/functions/activities/api/UrlReward.ts', {
        '../BaseActivity': base,
        '../../../constants/urls': { URLs: { rewards: { dashboard: 'https://example.invalid' } } }
    })
    const bot = {
        isMobile: true,
        nextActions: { reportActivity: 'synthetic' },
        config: {},
        userData: { currentPoints: 100, gainedPoints: 0 },
        logger: { info() {}, warn() {}, debug() {}, error() {} },
        browser: {
            react: { routerStateTree: () => 'synthetic' },
            func: {
                ensureOffer: async () => ({ reportable: true, hash: 'synthetic', points: 10, activityType: 11 }),
                reportServerAction: async () => responses(++attempts),
                getCurrentPoints: async () => 100
            }
        },
        refreshCurrentRewardsContext: async () => {
            repairs++
            return true
        }
    }
    return { results, activity: new UrlReward(bot), bot, stats: () => ({ attempts, repairs }) }
}
test('UrlReward repair success clears the transient attempt from account outcome', async () => {
    const f = urlRewardFixture(n => {
            if (n === 1) throw new Error('transient connection reset')
            return { status: 200, acknowledged: true, availablePoints: 110 }
        }),
        scope = new f.results.ActivityResults()
    await scope.run(() => f.activity.doUrlReward({ offerId: 'synthetic-offer' }))
    assert.equal(scope.summary(), undefined)
    assert.deepEqual(f.stats(), { attempts: 2, repairs: 1 })
    assert.equal(f.bot.userData.currentPoints, 110)
})
test('UrlReward exhausted repair retains terminal failure without preventing later work', async () => {
    const f = urlRewardFixture(() => {
            throw new Error('connection unavailable')
        }),
        scope = new f.results.ActivityResults()
    let later = false
    await scope.run(async () => {
        await f.activity.doUrlReward({ offerId: 'synthetic-offer' })
        later = true
    })
    assert.match(scope.summary(), /connection unavailable/)
    assert.equal(later, true)
    assert.deepEqual(f.stats(), { attempts: 2, repairs: 1 })
})
test('UrlReward final unconfirmed outcome does not become a successful account', async () => {
    const f = urlRewardFixture(() => ({ status: 200, acknowledged: false, availablePoints: 100 })),
        scope = new f.results.ActivityResults()
    await scope.run(() => f.activity.doUrlReward({ offerId: 'synthetic-offer' }))
    assert.match(scope.summary(), /未确认/)
})
for (const api of [false, true])
    test(`SearchOnBing submitted activation failure reaches outcome; missing activation remains a skip, api=${api}`, async () => {
        const { results, base } = modules()
        const dependencies = {
            '../BaseActivity': base,
            '../../../constants/urls': { URLs: { rewards: { earn: 'https://example.invalid' } } },
            './SearchOnBingShared': {
                activateSearchOnBing: async (_bot, _promo, submit) => {
                    submit()
                    return false
                }
            },
            '../search/SearchOnBingShared': {
                activateSearchOnBing: async (_bot, _promo, submit) => {
                    submit()
                    return false
                }
            },
            './BingSearchApi': { BingSearchApi: class {} }
        }
        const file = api
            ? 'src/functions/activities/experimental/ApiSearchOnBing.ts'
            : 'src/functions/activities/search/BrowserSearchOnBing.ts'
        const make = deps => {
            const exports = loadSource(file, deps)
            return new (api ? exports.ApiSearchOnBing : exports.SearchOnBing)({
                isMobile: true,
                userData: { currentPoints: 0 },
                logger: { info() {}, warn() {}, error() {} }
            })
        }
        const scope = new results.ActivityResults()
        await scope.run(() => make(dependencies).doSearchOnBing({ offerId: 'synthetic' }, { goto: async () => {} }))
        assert.match(scope.summary(), /激活未确认/)
        const skip = { ...dependencies }
        for (const k of ['./SearchOnBingShared', '../search/SearchOnBingShared'])
            skip[k] = { activateSearchOnBing: async () => false }
        const skipped = new results.ActivityResults()
        await skipped.run(() => make(skip).doSearchOnBing({ offerId: 'synthetic' }, { goto: async () => {} }))
        assert.equal(skipped.summary(), undefined)
    })
