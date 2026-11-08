const test = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('patchright')
const { startPreviewServer } = require('./fixtures/server.cjs')
const { createSnapshot } = require('./fixtures/snapshot.cjs')

test('daily trend keeps calendar gaps, zero, negatives, scale and custom ranges across months and browser time zones', async t => {
    const snapshot = createSnapshot(new Date('2026-03-02T01:00:00Z'))
    snapshot.accounts = snapshot.accounts.slice(0, 1)
    const email = snapshot.accounts[0].email
    const day = (date, value) => ({
        date,
        accounts: { [email]: { collected: value, balance: null, runs: 1, observedAt: null } },
        total: value
    })
    snapshot.ledger = {
        ...snapshot.ledger,
        timeZone: 'Asia/Shanghai',
        today: '2026-03-02',
        days: [
            day('2026-03-02', 0),
            day('2026-02-28', 10),
            day('2026-02-27', null),
            day('2026-02-26', 20),
            day('2026-02-25', -5)
        ]
    }
    const preview = await startPreviewServer(snapshot)
    t.after(() => preview.close())
    const browser = await chromium.launch({ headless: true })
    t.after(() => browser.close())
    const page = await browser.newPage({ timezoneId: 'America/Los_Angeles', viewport: { width: 390, height: 844 } })
    const requests = []
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/points/daily?*', route => {
        const url = new URL(route.request().url())
        requests.push(Object.fromEntries(url.searchParams))
        const ledger =
            url.searchParams.get('from') === '2025-01-01'
                ? { ...snapshot.ledger, days: [day('2025-01-01', 50)] }
                : snapshot.ledger
        return route.fulfill({ json: ledger })
    })
    await page.goto(preview.base + '/#/reports')
    await page.getByText('日均', { exact: true }).waitFor()
    await page.locator('.trend-day[data-date="2026-02-28"][data-value="10"]').waitFor()
    assert.deepEqual(await page.locator('.trend-day').evaluateAll(nodes => nodes.map(node => node.dataset.date)), [
        '2026-02-24',
        '2026-02-25',
        '2026-02-26',
        '2026-02-27',
        '2026-02-28',
        '2026-03-01',
        '2026-03-02'
    ])
    assert.equal(await page.locator('.trend-day[data-date="2026-03-01"] .trend-value').innerText(), '—')
    assert.equal(await page.locator('.trend-day[data-date="2026-03-02"] .trend-value').innerText(), '0')
    assert.equal(await page.locator('.trend-day[data-date="2026-03-02"] .trend-bar.is-zero').count(), 1)
    assert.equal(await page.locator('.trend-day[data-date="2026-02-25"] .trend-bar.is-negative').count(), 1)
    const height10 = await page
        .locator('.trend-day[data-date="2026-02-28"] .trend-bar')
        .evaluate(node => node.getBoundingClientRect().height)
    const height20 = await page
        .locator('.trend-day[data-date="2026-02-26"] .trend-bar')
        .evaluate(node => node.getBoundingClientRect().height)
    assert.ok(Math.abs(height20 / height10 - 2) < 0.01)
    const dimensions = await page.evaluate(() => ({
        width: globalThis.innerWidth,
        scroll: globalThis.document.documentElement.scrollWidth
    }))
    assert.ok(dimensions.scroll <= dimensions.width + 1)
    assert.deepEqual(requests[0], { from: '2026-02-24', to: '2026-03-02' })
    await page.getByRole('button', { name: '上月', exact: true }).click()
    assert.equal(await page.getByLabel('开始日期', { exact: true }).inputValue(), '2026-02-01')
    assert.equal(await page.getByLabel('结束日期', { exact: true }).inputValue(), '2026-02-28')
    assert.equal(await page.locator('.trend-day').count(), 28)
    await page.getByLabel('开始日期', { exact: true }).fill('2025-01-01')
    await page.getByLabel('结束日期', { exact: true }).fill('2025-01-07')
    await page.locator('.trend-day[data-date="2025-01-01"][data-value="50"]').waitFor()
    assert.equal(await page.locator('.trend-day').count(), 7)
    assert.ok(requests.some(request => request.from === '2025-01-01' && request.to === '2025-01-07'))
    await page.getByLabel('结束日期', { exact: true }).fill('2026-03-02')
    await page.getByRole('status').filter({ hasText: '范围最多 366 天' }).waitFor()
    assert.equal(await page.locator('.trend-day').count(), 0)
    assert.deepEqual(errors, [])
})

test('daily trend axes redraw on live increases, decreases and range heartbeats without changing runCount', async t => {
    const snapshot = createSnapshot(new Date('2026-11-08T08:00:00Z'))
    snapshot.accounts = snapshot.accounts.slice(0, 1)
    const email = snapshot.accounts[0].email
    const day = (date, value) => ({
        date,
        accounts: { [email]: { collected: value, balance: null, runs: 1, observedAt: null } },
        total: value
    })
    snapshot.ledger = {
        ...snapshot.ledger,
        generatedAt: '2026-11-08T08:00:00Z',
        today: '2026-11-08',
        range: { from: '2026-10-10', to: '2026-11-08' },
        runCount: 1,
        days: [day('2026-11-08', 10), day('2026-11-07', 20)]
    }
    const preview = await startPreviewServer(snapshot)
    t.after(() => preview.close())
    const browser = await chromium.launch({ headless: true })
    t.after(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    const requests = []
    let archivedValue = 40
    let holdArchive = false
    let releaseArchive
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/points/daily?*', async route => {
        const url = new URL(route.request().url())
        const from = url.searchParams.get('from'),
            to = url.searchParams.get('to')
        requests.push({ from, to })
        const archived = from === '2025-01-01'
        if (archived && holdArchive)
            await new Promise(resolve => {
                releaseArchive = resolve
            })
        await route.fulfill({
            json: archived
                ? { ...snapshot.ledger, range: { from, to }, days: [day('2025-01-01', archivedValue)] }
                : snapshot.ledger
        })
    })
    await page.goto(preview.base + '/#/reports')
    const chart = page.locator('.trend-chart')
    await page.locator('.trend-chart[data-axis-max="20"]').waitFor()
    assert.deepEqual(await page.locator('.trend-tick').allTextContents(), ['20', '15', '10', '5', '0'])
    const aligned = async () => {
        const zero = await page.locator('.trend-tick').filter({ hasText: /^0$/ }).boundingBox()
        const top = await page.locator('.trend-tick').first().boundingBox()
        const baseline = await page.locator('.trend-baseline').first().boundingBox()
        const grid = await page.locator('.trend-gridline').first().boundingBox()
        assert.ok(Math.abs(zero.y + zero.height / 2 - baseline.y) < 1)
        assert.ok(Math.abs(top.y + top.height / 2 - grid.y) < 1)
    }
    await aligned()
    const change = (first, second) => {
        snapshot.ledger.days = [day('2026-11-08', first), day('2026-11-07', second)]
        preview.publish()
    }
    change(100, 20)
    await page.locator('.trend-chart[data-axis-max="100"]').waitFor()
    assert.deepEqual(await page.locator('.trend-tick').allTextContents(), ['100', '75', '50', '25', '0'])
    await page.locator('.trend-day[data-date="2026-11-08"][data-value="100"]').waitFor()
    const bar20 = await page.locator('.trend-day[data-value="20"] .trend-bar').boundingBox()
    assert.ok(Math.abs(bar20.height - 30) < 0.1)
    change(4, 8)
    await page.locator('.trend-chart[data-axis-max="8"]').waitFor()
    assert.deepEqual(await page.locator('.trend-tick').allTextContents(), ['8', '6', '4', '2', '0'])
    await page.setViewportSize({ width: 390, height: 844 })
    await aligned()
    assert.ok(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth + 1))
    change(null, null)
    await page.locator('.trend-axis-empty').waitFor()
    assert.equal(await chart.getAttribute('data-axis-max'), null)
    assert.equal(await page.locator('.trend-tick').count(), 0)
    change(0, 0)
    await page.locator('.trend-tick').filter({ hasText: /^0$/ }).waitFor()
    assert.deepEqual(await page.locator('.trend-tick').allTextContents(), ['0'])
    assert.equal(await page.locator('.trend-bar.is-zero').count(), 2)
    await page.getByLabel('开始日期', { exact: true }).fill('2025-01-01')
    await page.getByLabel('结束日期', { exact: true }).fill('2025-01-07')
    await page.locator('.trend-chart[data-axis-max="40"]').waitFor()
    const archiveRequests = requests.filter(
        request => request.from === '2025-01-01' && request.to === '2025-01-07'
    ).length
    holdArchive = true
    archivedValue = 90
    snapshot.ledger.generatedAt = '2026-11-08T08:00:04Z'
    preview.publish()
    await page.waitForFunction(() => globalThis.document.querySelector('main')?.textContent.includes('刷新中'))
    assert.equal(
        await chart.getAttribute('data-axis-max'),
        '40',
        'an unrelated short snapshot must not replace the selected archive'
    )
    for (let attempt = 0; attempt < 100 && !releaseArchive; attempt++) await page.waitForTimeout(10)
    assert.ok(releaseArchive)
    holdArchive = false
    releaseArchive()
    await page.locator('.trend-chart[data-axis-max="100"]').waitFor()
    await page.locator('.trend-day[data-date="2025-01-01"][data-value="90"]').waitFor()
    assert.ok(
        requests.filter(request => request.from === '2025-01-01' && request.to === '2025-01-07').length >
            archiveRequests
    )
    assert.equal(snapshot.ledger.runCount, 1)
    assert.deepEqual(errors, [])
})
