const test = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('patchright')
const { startPreviewServer } = require('./fixtures/server.cjs')
test('six navigation entries retain legacy routes, themes and usable narrow layouts', async t => {
    const preview = await startPreviewServer()
    t.after(() => preview.close())
    const browser = await chromium.launch({ headless: true })
    t.after(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
        errors = []
    page.on('pageerror', e => errors.push(e.message))
    for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 })
        for (const route of ['/', '/accounts', '/reports', '/logs', '/history', '/control', '/control/system']) {
            await page.goto(preview.base + '/#' + route)
            await page.locator('main h2').first().waitFor()
            assert.equal(await page.locator('.nav-item').count(), 6)
            const dimensions = await page.evaluate(() => ({
                width: globalThis.innerWidth,
                scroll: globalThis.document.documentElement.scrollWidth
            }))
            assert.ok(dimensions.scroll <= dimensions.width + 1, `${route} overflows at ${width}: ${dimensions.scroll}`)
        }
    }
    await page.goto(preview.base + '/#/points')
    await page.getByRole('heading', { name: '积分报表', exact: true }).waitFor()
    await page.goto(preview.base + '/#/system')
    await page.getByRole('tab', { name: '系统资源', exact: true }).waitFor()
    assert.equal(await page.getByRole('tab', { name: '系统资源', exact: true }).getAttribute('aria-selected'), 'true')
    const before = await page.evaluate(() => globalThis.location.hash)
    await page.locator('.skip-link').focus()
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => globalThis.location.hash), before)
    assert.equal(await page.evaluate(() => globalThis.document.activeElement.id), 'main-content')
    await page.getByRole('button', { name: '切换深色', exact: true }).click()
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
    await page.reload()
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
    assert.deepEqual(errors, [])
})
