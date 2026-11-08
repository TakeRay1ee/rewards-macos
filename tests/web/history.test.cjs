const test = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('patchright')
const { startPreviewServer } = require('./fixtures/server.cjs')
const { createSnapshot } = require('./fixtures/snapshot.cjs')

test('history merges by run identity and retains local unknown earnings, accounts and exit facts', async t => {
    const snapshot = createSnapshot()
    snapshot.accounts = [{ ...snapshot.accounts[0], status: 'unknown', statusKnown: false, error: null }]
    snapshot.overview = {
        ...snapshot.overview,
        accountsTotal: 1,
        running: 0,
        waiting: 0,
        completed: 0,
        failed: 0,
        unknown: 1
    }
    const startedAt = '2026-11-08T01:00:00.000Z'
    const local = {
        runId: 'stable-history-id',
        startedAt,
        endedAt: '2026-11-08T01:05:00.000Z',
        exit: { code: 137, signal: 'SIGKILL', at: '2026-11-08T01:05:00.000Z' },
        accounts: [
            { email: 'unknown@example.invalid', success: false, collected: null, error: 'synthetic timeout' },
            { email: 'zero@example.invalid', success: true, collected: 0, error: null }
        ]
    }
    snapshot.history = [
        {
            ...local,
            startedAt: '2026-11-08T01:00:00.001Z',
            endedAt: null,
            exit: null,
            accounts: [{ email: 'unknown@example.invalid', success: false, collected: 0, error: null }]
        },
        {
            runId: 'distinct-history-id',
            startedAt,
            accounts: [{ email: 'upstream-only@example.invalid', success: false, collected: 0, error: null }]
        }
    ]
    const preview = await startPreviewServer(snapshot)
    t.after(() => preview.close())
    const browser = await chromium.launch({ headless: true })
    t.after(() => browser.close())
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/runs', route => route.fulfill({ json: { runs: [local] } }))
    await page.goto(preview.base + '/#/history')
    await page.getByText('2 个批次', { exact: true }).waitFor()
    assert.equal(await page.locator('tbody tr').count(), 2)
    const upstreamOnly = page.locator('tbody tr').nth(1)
    await upstreamOnly.getByRole('button', { name: '详情 +' }).click()
    assert.match(
        await upstreamOnly.locator('.batch-detail').innerText(),
        /upstream-only@example\.invalid · 失败 · — 分/
    )
    const row = page.locator('tbody tr').first()
    await row.getByRole('button', { name: '详情 +' }).click()
    const detail = row.locator('.batch-detail')
    const text = await detail.innerText()
    assert.match(text, /退出码 137 · 信号 SIGKILL · 退出时间/)
    assert.doesNotMatch(text, /退出时间 —/)
    assert.match(text, /unknown@example\.invalid · 失败 · — 分 · synthetic timeout/)
    assert.match(text, /zero@example\.invalid · 成功 · 0 分/)
    snapshot.history[0].accounts[0] = {
        email: 'unknown@example.invalid',
        success: true,
        collected: 25,
        collectedObserved: true,
        error: null
    }
    snapshot.history[0].exit = { code: 0, signal: null, at: '2026-11-08T01:05:00.000Z' }
    await page.reload()
    await page.getByText('2 个批次', { exact: true }).waitFor()
    await page.locator('tbody tr').first().getByRole('button', { name: '详情 +' }).click()
    const confirmed = await page.locator('.batch-detail').innerText()
    assert.match(confirmed, /unknown@example\.invalid · 成功 · 25 分/)
    assert.match(confirmed, /退出码 0 · 信号 — · 退出时间/)
    assert.doesNotMatch(confirmed, /SIGKILL/)
    assert.doesNotMatch(confirmed, /synthetic timeout/)
    snapshot.history[0].accounts[0] = {
        email: 'unknown@example.invalid',
        success: false,
        collected: 0,
        collectedObserved: true,
        error: null
    }
    await page.reload()
    await page.getByText('2 个批次', { exact: true }).waitFor()
    await page.locator('tbody tr').first().getByRole('button', { name: '详情 +' }).click()
    assert.match(await page.locator('.batch-detail').innerText(), /unknown@example\.invalid · 失败 · 0 分/)
    await page.goto(preview.base + '/#/')
    await page.getByText('状态待确认，请查看账号详情。', { exact: true }).waitFor()
    const attentionStat = page.locator('.stat').filter({ has: page.getByText('需要关注', { exact: true }) })
    assert.equal(await attentionStat.locator('.value').innerText(), '1')
    assert.equal(await page.getByText('没有待处理的异常', { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
})
