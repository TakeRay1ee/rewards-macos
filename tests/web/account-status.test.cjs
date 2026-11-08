const test = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('patchright')
const { createSnapshot } = require('./fixtures/snapshot.cjs')
const { startPreviewServer } = require('./fixtures/server.cjs')

test('daily completed accounts survive a single-account batch without inflating its current progress', async t => {
    const snapshot = createSnapshot(new Date('2026-11-08T08:00:00.000Z'))
    snapshot.accounts = snapshot.accounts.slice(0, 3).map((account, i) => ({
        ...account,
        status: 'completed',
        currentRunStatus: i === 0 ? 'completed' : 'not_run',
        includedInCurrentRun: i === 0,
        statusScope: i === 0 ? 'current-run' : 'today',
        statusAt: '2026-11-08T01:00:00.000Z',
        todayStatus: 'completed',
        todayResult: {
            status: 'completed',
            at: '2026-11-08T01:00:00.000Z',
            runId: 'earlier-daily',
            collected: [10, 42, 74][i],
            error: null
        },
        collectedThisRun: i === 0 ? 10 : null,
        currentTask: null,
        wait: null,
        workerPid: null,
        lastSuccess: true,
        lastRunAt: '2026-11-08T01:00:00.000Z',
        lastCollected: [10, 42, 74][i],
        error: null
    }))
    snapshot.run = {
        ...snapshot.run,
        state: 'idle',
        accountsTotal: 1,
        endedAt: snapshot.generatedAt,
        selectedAccounts: [snapshot.accounts[0]]
    }
    snapshot.overview = {
        ...snapshot.overview,
        accountsTotal: 3,
        running: 0,
        waiting: 0,
        completed: 1,
        failed: 0,
        notRun: 2,
        todayCompleted: 3
    }
    snapshot.ledger.todayTotals = Object.fromEntries(
        snapshot.accounts.map((account, i) => [account.email, [10, 42, 74][i]])
    )
    const preview = await startPreviewServer(snapshot)
    t.after(() => preview.close())
    const browser = await chromium.launch({ headless: true })
    t.after(() => browser.close())
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(preview.base + '/#/')
    const completed = page.locator('.stat').filter({ has: page.getByText('今日完成', { exact: true }) })
    await completed.waitFor()
    assert.equal(await completed.locator('.value').innerText(), '3 / 3')
    assert.match(await completed.locator('.hint').innerText(), /本轮完成 1 \/ 1/)
    assert.equal(await page.locator('tbody').getByText('今日已完成', { exact: true }).count(), 3)
    await page.goto(preview.base + '/#/accounts')
    await page.getByRole('heading', { name: '多账号实时监控' }).waitFor()
    assert.equal(await page.locator('tbody').getByText('今日已完成', { exact: true }).count(), 3)
    await page.getByRole('combobox', { name: '按账号状态筛选' }).selectOption('completed')
    assert.equal(await page.locator('tbody tr').count(), 3)
    snapshot.accounts[0] = {
        ...snapshot.accounts[0],
        status: 'running',
        currentRunStatus: 'running'
    }
    preview.publish()
    await page.getByRole('combobox', { name: '按账号状态筛选' }).selectOption('all')
    await page.locator('tbody tr').first().getByText('运行中', { exact: true }).waitFor()
    assert.equal(await page.locator('tbody tr').first().getByText('今日已完成', { exact: true }).count(), 0)
    const second = page.locator('tbody tr').nth(1)
    assert.match(await second.innerText(), /未参与本轮/)
    await second.getByRole('button').click()
    await page.getByRole('heading', { name: snapshot.accounts[1].email, exact: true }).waitFor()
    const current = page.locator('.card').filter({ has: page.getByRole('heading', { name: '当前执行', exact: true }) })
    assert.equal(await current.getByText('未参与本轮', { exact: true }).count(), 1)
    assert.equal(await current.getByText('今日已完成', { exact: true }).count(), 1)
    snapshot.accounts[1] = {
        ...snapshot.accounts[1],
        status: 'unknown',
        statusKnown: false,
        currentRunStatus: 'unknown',
        includedInCurrentRun: null,
        statusScope: 'current-run'
    }
    preview.publish()
    await page.goto(preview.base + '/#/accounts')
    await page.getByText('今日已完成 · 本轮待确认', { exact: true }).waitFor()
    assert.deepEqual(errors, [])
})
