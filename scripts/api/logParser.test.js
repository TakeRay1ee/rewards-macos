import assert from 'node:assert/strict'
import test from 'node:test'

import { applyLogToRunState, createRunState, parseLogLine, restoreRunSummary, summarizeRunState } from './logParser.js'

function line(user, title, message, level = 'INFO', platform = 'MAIN') {
    return `[2026-08-06 11:20:01] [${user}] [${level}] ${platform} [${title}] ${message}`
}

function apply(state, raw, receivedAt) {
    const entry = parseLogLine(raw)
    entry.receivedAt = receivedAt
    applyLogToRunState(state, entry)
    return entry
}

test('account terminal timestamps are independent from earlier balance observations and survive legacy checkpoints', () => {
    const email = 'midnight@example.invalid'
    const state = createRunState({ accountEmails: [email] })
    apply(state, line(email, 'ACCOUNT-START', `开始处理账户: ${email} | geoLocale: CN`), '2026-11-08T15:58:00.000Z')
    apply(state, line(email, 'SEARCH-BING', '开始必应搜索 | 当前余额=100'), '2026-11-08T15:59:00.000Z')
    assert.equal(state.accounts[email].terminalAt, null)
    apply(
        state,
        line(email, 'ACCOUNT-ERROR', `${email} | 错误=synthetic failure after midnight`, 'ERROR'),
        '2026-11-08T16:01:00.000Z'
    )
    assert.equal(state.accounts[email].terminalAt, '2026-11-08T16:01:00.000Z')
    assert.equal(state.accounts[email].live.lastUpdateTs, '2026-11-08T15:59:00.000Z')
    const saved = { ...state.accounts[email] }
    delete saved.terminalAt
    restoreRunSummary(state, { accounts: [saved] }, { authoritative: true, accountsOnly: true })
    assert.equal(state.accounts[email].terminalAt, '2026-11-08T16:01:00.000Z')
    const fresh = createRunState()
    restoreRunSummary(
        fresh,
        { accounts: [{ ...saved, terminalAt: '2026-11-08T16:01:00.000Z' }] },
        { authoritative: true }
    )
    assert.equal(fresh.accounts[email].terminalAt, '2026-11-08T16:01:00.000Z')
})

test('account completion and explicit flow failure each record their own terminal event time', () => {
    const email = 'terminal@example.invalid'
    const completed = createRunState()
    apply(
        completed,
        line(email, 'ACCOUNT-END', `账户完成: ${email} | 获得积分=0 | 原余额=100 | 现余额=100 | 持续秒数=1`),
        '2026-11-08T15:59:00.000Z'
    )
    assert.equal(completed.accounts[email].terminalAt, '2026-11-08T15:59:00.000Z')
    const failed = createRunState()
    apply(
        failed,
        line(email, 'BROWSER', `${email} 的移动端流程失败: synthetic failure`, 'ERROR'),
        '2026-11-08T16:01:00.000Z'
    )
    assert.equal(failed.accounts[email].success, false)
    assert.equal(failed.accounts[email].terminalAt, '2026-11-08T16:01:00.000Z')
})

test('parses the logger envelope and strips ANSI formatting', () => {
    const entry = parseLogLine(
        `\u001b[32m${line('account.n', 'LOGIN', 'Starting login process', 'INFO', 'MOBILE')}\u001b[39m`
    )

    assert.equal(entry.parsed, true)
    assert.equal(entry.user, 'account.n')
    assert.equal(entry.level, 'info')
    assert.equal(entry.platform, 'MOBILE')
    assert.equal(entry.title, 'LOGIN')
    assert.equal(entry.message, 'Starting login process')
})

test('keeps account geoLocale, resolved locale, and cached region as separate fields', () => {
    const state = createRunState()

    apply(
        state,
        line(
            'account.n',
            'ACCOUNT-START',
            '开始处理账户: account.n@example.com | geoLocale: auto | locale: nl-NL | 缓存区域: NL'
        ),
        '2026-08-06T09:20:01.000Z'
    )

    assert.equal(state.accounts['account.n@example.com'].geoLocale, 'auto')
    assert.equal(state.accounts['account.n@example.com'].locale, 'nl-NL')
    assert.equal(state.accounts['account.n@example.com'].cachedRegion, 'NL')
})

test('keeps mobile and desktop browser search pools separate in earnable points', () => {
    const state = createRunState()

    apply(
        state,
        line(
            'account.n',
            'POINTS',
            '今日可赚取 | 移动端: 60 | 浏览器: 90 | App: 0 | account.n@example.com | locale: nl-NL'
        ),
        '2026-08-06T09:20:01.000Z'
    )

    assert.deepEqual(state.accounts['account.n@example.com'].earnable, {
        mobile: 60,
        browser: 90,
        app: 0
    })
})

test('attributes per-account summaries by logger user when cluster output is interleaved', () => {
    const state = createRunState()

    apply(
        state,
        line('alpha', 'ACCOUNT-START', '开始处理账户: alpha@example.com | geoLocale: US | locale: en-US'),
        '2026-08-06T09:20:01.000Z'
    )
    apply(
        state,
        line('beta', 'ACCOUNT-START', '开始处理账户: beta@example.com | geoLocale: GB | locale: en-GB'),
        '2026-08-06T09:20:02.000Z'
    )
    apply(
        state,
        line('alpha', 'SEARCH-MANAGER', '搜索汇总 | 移动端=30 | 桌面端=90 | 额外=0 | 总计=120'),
        '2026-08-06T09:20:03.000Z'
    )

    assert.deepEqual(state.accounts['alpha@example.com'].searchSummary, {
        mobile: 30,
        desktop: 90,
        bonus: 0,
        total: 120
    })
    assert.equal(state.accounts['beta@example.com'].searchSummary, null)
})

test('tracks the most recently received point update across interleaved accounts', () => {
    const state = createRunState()

    apply(
        state,
        line('alpha', 'ACCOUNT-START', '开始处理账户: alpha@example.com | geoLocale: US | locale: en-US'),
        '2026-08-06T09:20:01.000Z'
    )
    apply(
        state,
        line('alpha', 'SEARCH-BING', '必应搜索完成 | 获得积分=3 | 当前余额=1003', 'INFO', 'DESKTOP'),
        '2026-08-06T09:20:02.000Z'
    )
    apply(
        state,
        line('beta', 'ACCOUNT-START', '开始处理账户: beta@example.com | geoLocale: GB | locale: en-GB'),
        '2026-08-06T09:20:03.000Z'
    )
    apply(
        state,
        line('beta', 'SEARCH-BING', '必应搜索完成 | 获得积分=3 | 当前余额=2003', 'INFO', 'DESKTOP'),
        '2026-08-06T09:20:04.000Z'
    )
    apply(
        state,
        line('alpha', 'SEARCH-BING', '必应搜索完成 | 获得积分=3 | 当前余额=1006', 'INFO', 'DESKTOP'),
        '2026-08-06T09:20:05.000Z'
    )

    const summary = summarizeRunState(state)
    assert.equal(summary.live.updatedAt, '2026-08-06T09:20:05.000Z')
    assert.equal(state.accounts['alpha@example.com'].live.gained, 6)
    assert.equal(state.accounts['beta@example.com'].live.gained, 3)
})

test('recognizes every activity format used for live point accumulation', () => {
    const state = createRunState()
    apply(
        state,
        line('alpha', 'ACCOUNT-START', '开始处理账户: alpha@example.com | geoLocale: US | locale: en-US'),
        '2026-08-06T09:20:00.000Z'
    )

    const events = [
        ['SEARCH-BING', '必应搜索完成 | 获得积分=3 | 当前余额=1003', 'search'],
        ['SEARCH-BONUS', '必应搜索完成 | pointsGained=3 | currentBalance=1006 | progress=3/30', 'bonus'],
        ['READ-TO-EARN', '已阅读第 1/10 篇文章 | status=200 | pointsGained=3 | currentBalance=1009', 'read'],
        ['DAILY-CHECK-IN', '每日签到完成 | type=103 | pointsGained=3 | currentBalance=1012', 'checkIn'],
        [
            'CLAIM-BONUS-POINTS',
            '领取奖励积分完成 | acknowledged=true | pointsGained=3 | currentBalance=1015',
            'claimBonus'
        ],
        [
            'CLAIM-REWARD',
            '奖励已领取 | offerId=test | status=200 | pointsGained=3 | currentBalance=1018',
            'claimReward'
        ],
        ['URL-REWARD', 'UrlReward 完成 | offerId=test | pointsGained=3 | currentBalance=1021', 'urlReward'],
        ['VISUAL-SEARCH', '每日视觉搜索完成 | pointsGained=3 | currentBalance=1024 | query="test"', 'visualSearch'],
        ['APP-REWARD', 'AppReward 完成 | offerId=test | pointsGained=3 | currentBalance=1027', 'appReward'],
        ['PUNCHCARD', '任务 "test" COMPLETE | reported=1 | pointsGained=3 | currentBalance=1030', 'punchcard'],
        [
            'SEARCH-ON-BING-SEARCH',
            'SearchOnBing 活动完成 | pointsGained=3 | currentBalance=1033 | query="test" | offerProgress=1',
            'searchOnBing'
        ]
    ]

    events.forEach(([title, message], index) => {
        apply(state, line('alpha', title, message), `2026-08-06T09:20:${String(index + 1).padStart(2, '0')}.000Z`)
    })

    const account = state.accounts['alpha@example.com']
    assert.equal(account.live.gained, events.length * 3)
    assert.deepEqual(Object.fromEntries(events.map(([, , source]) => [source, 3])), account.live.bySource)

    apply(
        state,
        line('alpha', 'FLOW', '积分已收集 | 获得积分=40 | 现余额=1040 | 账户=alpha@example.com'),
        '2026-08-06T09:21:00.000Z'
    )
    assert.equal(account.live.gained, 40)
    assert.equal(account.live.balance, 1040)
})

test('tracks background Edge browsing progress and ETA for the correct account', () => {
    const state = createRunState()

    apply(
        state,
        line('alpha', 'ACCOUNT-START', '开始处理账户: alpha@example.com | geoLocale: US | locale: en-US'),
        '2026-08-06T09:20:00.000Z'
    )
    apply(
        state,
        line('beta', 'ACCOUNT-START', '开始处理账户: beta@example.com | geoLocale: GB | locale: en-GB'),
        '2026-08-06T09:20:01.000Z'
    )
    apply(
        state,
        line(
            'alpha',
            'EDGE-BROWSING',
            '开始后台 Edge 浏览活动 | offerId=DailyCheckIn_Edge | type=29 | targetMinutes=30 | reports=6 | serverIntervalMinutes=5 | jitterSeconds=5-20 | estimatedDurationMinutes=31.2',
            'INFO',
            'MOBILE'
        ),
        '2026-08-06T09:20:02.000Z'
    )
    apply(
        state,
        line(
            'alpha',
            'EDGE-BROWSING',
            'Edge 浏览进度 | reportsCompleted=0/6 | reportsRemaining=6 | scheduledMinutesCovered=0/30 | nextReportInSeconds=311.4 | accepted=0 | duplicates=0 | failed=0 | elapsedMinutes=0 | estimatedRemainingMinutes=31.2',
            'INFO',
            'MOBILE'
        ),
        '2026-08-06T09:20:03.000Z'
    )
    apply(
        state,
        line(
            'alpha',
            'EDGE-BROWSING',
            '已提交 Edge 浏览报告 | report=1/6 | status=200 | duplicate=false | cookies=MUID,MC1 | reportsRemaining=5 | scheduledMinutesCovered=5/30 | accepted=1 | duplicates=0 | failed=0 | elapsedMinutes=5.2 | estimatedRemainingMinutes=26',
            'INFO',
            'MOBILE'
        ),
        '2026-08-06T09:25:14.000Z'
    )
    apply(
        state,
        line('alpha', 'EDGE-BROWSING', '前台活动已完成；正在等待后台 Edge 浏览活动', 'INFO', 'MOBILE'),
        '2026-08-06T09:26:00.000Z'
    )

    assert.deepEqual(state.accounts['alpha@example.com'].edgeBrowsing, {
        status: 'running',
        targetMinutes: 30,
        serverIntervalMinutes: 5,
        reportsCompleted: 1,
        reportsTotal: 6,
        reportsRemaining: 5,
        scheduledMinutesCovered: 5,
        nextReportInSeconds: null,
        estimatedRemainingMinutes: 26,
        elapsedMinutes: 5.2,
        accepted: 1,
        duplicates: 0,
        failed: 0,
        waitingForBackground: true,
        updatedAt: '2026-08-06T09:26:00.000Z'
    })
    assert.equal(state.accounts['beta@example.com'].edgeBrowsing, null)

    apply(
        state,
        line(
            'alpha',
            'EDGE-BROWSING',
            '后台 Edge 浏览活动结束 | reports=6 | scheduledMinutesCovered=30/30 | accepted=6 | duplicates=0 | failed=0 | elapsedMinutes=31.2 | estimatedRemainingMinutes=0',
            'INFO',
            'MOBILE'
        ),
        '2026-08-06T09:51:14.000Z'
    )

    const finished = state.accounts['alpha@example.com'].edgeBrowsing
    assert.equal(finished.status, 'complete')
    assert.equal(finished.reportsCompleted, 6)
    assert.equal(finished.reportsRemaining, 0)
    assert.equal(finished.scheduledMinutesCovered, 30)
    assert.equal(finished.estimatedRemainingMinutes, 0)
    assert.equal(finished.elapsedMinutes, 31.2)
    assert.equal(finished.waitingForBackground, false)
})

test('marks Edge browsing complete when Microsoft completes before the local maximum report count', () => {
    const state = createRunState()

    apply(
        state,
        line('alpha', 'ACCOUNT-START', '开始处理账户: alpha@example.com | geoLocale: US | locale: en-US'),
        '2026-08-13T09:20:00.000Z'
    )
    apply(
        state,
        line(
            'alpha',
            'EDGE-BROWSING',
            '开始后台 Edge 浏览活动 | offerId=DailyCheckIn_Edge | type=29 | targetMinutes=30 | reports=6 | serverDriven=true | serverIntervalMinutes=5 | jitterSeconds=5-20 | estimatedDurationMinutes=31.2',
            'INFO',
            'MOBILE'
        ),
        '2026-08-13T09:20:01.000Z'
    )
    apply(
        state,
        line(
            'alpha',
            'EDGE-BROWSING',
            '后台 Edge 浏览活动结束 | reports=3 | reportsCompleted=3/6 | reportsRemaining=0 | scheduledMinutesCovered=15/30 | serverComplete=true | accepted=3 | duplicates=0 | failed=0 | elapsedMinutes=15.6 | estimatedRemainingMinutes=0',
            'INFO',
            'MOBILE'
        ),
        '2026-08-13T09:35:37.000Z'
    )

    const finished = state.accounts['alpha@example.com'].edgeBrowsing
    assert.equal(finished.status, 'complete')
    assert.equal(finished.reportsCompleted, 3)
    assert.equal(finished.reportsTotal, 6)
    assert.equal(finished.reportsRemaining, 0)
    assert.equal(finished.scheduledMinutesCovered, 15)
})

test('marks Edge browsing partial when the local maximum ends before Microsoft reports completion', () => {
    const state = createRunState()

    apply(
        state,
        line('alpha', 'ACCOUNT-START', '开始处理账户: alpha@example.com | geoLocale: US | locale: en-US'),
        '2026-08-13T09:20:00.000Z'
    )
    apply(
        state,
        line(
            'alpha',
            'EDGE-BROWSING',
            '开始后台 Edge 浏览活动 | offerId=DailyCheckIn_Edge | type=29 | targetMinutes=30 | reports=6 | serverDriven=true | serverIntervalMinutes=5 | jitterSeconds=5-20 | estimatedDurationMinutes=31.2',
            'INFO',
            'MOBILE'
        ),
        '2026-08-13T09:20:01.000Z'
    )
    apply(
        state,
        line(
            'alpha',
            'EDGE-BROWSING',
            '后台 Edge 浏览活动结束 | reports=6 | reportsCompleted=6/6 | reportsRemaining=0 | scheduledMinutesCovered=30/30 | serverComplete=false | accepted=6 | duplicates=0 | failed=0 | elapsedMinutes=31.2 | estimatedRemainingMinutes=0',
            'WARN',
            'MOBILE'
        ),
        '2026-08-13T09:51:13.000Z'
    )

    const finished = state.accounts['alpha@example.com'].edgeBrowsing
    assert.equal(finished.status, 'partial')
    assert.equal(finished.reportsCompleted, 6)
    assert.equal(finished.reportsTotal, 6)
})
