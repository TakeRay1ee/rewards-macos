import assert from 'node:assert/strict'
import test from 'node:test'
import { applyLogToRunState, createRunState } from '../../scripts/api/logParser.js'

const start = (email, user) => ({
    parsed: true,
    user,
    title: 'ACCOUNT-START',
    message: `开始处理账户: ${email} | geoLocale: CN`
})
const gain = user => ({
    parsed: true,
    user,
    title: 'SEARCH-BING',
    message: '必应搜索完成 | pointsGained=15 | currentBalance=115',
    receivedAt: '2026-11-08T01:00:00.000Z'
})

test('ambiguous legacy users never credit the current account, while full identities and terminal facts remain usable', () => {
    const state = createRunState({ accountEmails: ['same@one.invalid', 'same@two.invalid'] })
    applyLogToRunState(state, start('same@one.invalid', 'same'))
    applyLogToRunState(state, gain('same'))
    assert.equal(state.accounts['same@one.invalid'].live.gained, 0)
    applyLogToRunState(state, start('same@two.invalid', 'same'))
    applyLogToRunState(state, gain('same'))
    assert.equal(state.accounts['same@two.invalid'].live.gained, 0)
    applyLogToRunState(state, gain('same@one.invalid'))
    assert.equal(state.accounts['same@one.invalid'].live.gained, 15)
    applyLogToRunState(state, {
        parsed: true,
        user: 'same',
        title: 'ACCOUNT-END',
        message: '账户完成: same@two.invalid | 获得积分=7 | 原余额=100 | 现余额=107 | 持续秒数=1'
    })
    assert.equal(state.accounts['same@two.invalid'].collectedPoints, 7)
})

test('unknown identities do not fall back to the most recently started account', () => {
    const state = createRunState()
    applyLogToRunState(state, start('known@example.invalid', 'known'))
    applyLogToRunState(state, gain('unseen'))
    applyLogToRunState(state, gain(null))
    assert.equal(state.accounts['known@example.invalid'].live.gained, 0)
    applyLogToRunState(state, gain('complete@example.invalid'))
    assert.equal(state.accounts['complete@example.invalid'].live.gained, 15)
})

test('Chinese search completion fields produced by the engine update the identified account', () => {
    const state = createRunState()
    applyLogToRunState(state, {
        ...gain('complete@example.invalid'),
        message: '必应搜索完成 | 获得积分=9 | 当前余额=109 | 之前余额=100 | 搜索次数=3'
    })
    assert.equal(state.accounts['complete@example.invalid']?.live.gained, 9)
    assert.equal(state.accounts['complete@example.invalid']?.live.balance, 109)
})

test('reading article debug, acknowledgement and final session total describe the same earnings once', () => {
    const state = createRunState()
    const email = 'reader@example.invalid'
    const apply = message =>
        applyLogToRunState(state, { parsed: true, user: email, title: 'READ-TO-EARN', message, platform: 'MOBILE' })
    apply('开始读文赚积分 | geo=CN | delayRange=1min-2min | currentBalance=100')
    apply('文章后的积分变化 | article=1/10 | previousBalance=100 | currentBalance=103 | pointsGained=3')
    apply('已阅读第 1/10 篇文章 | status=200 | pointsGained=3 | currentBalance=103')
    apply('文章后的积分变化 | article=2/10 | previousBalance=103 | currentBalance=106 | pointsGained=3')
    apply('已阅读第 2/10 篇文章 | status=200 | pointsGained=3 | currentBalance=106')
    apply('读文赚积分完成 | articlesRead=2 | pointsGained=6 | previousBalance=100 | currentBalance=106')
    assert.equal(state.accounts[email].live.gained, 6)
    assert.equal(state.accounts[email].live.bySource.read, 6)
    apply('开始读文赚积分 | geo=CN | delayRange=1min-2min | currentBalance=106')
    apply('已阅读第 1/10 篇文章 | status=200 | pointsGained=3 | currentBalance=109')
    apply('读文赚积分完成 | articlesRead=1 | pointsGained=3 | previousBalance=106 | currentBalance=109')
    assert.equal(state.accounts[email].live.gained, 9)
})
