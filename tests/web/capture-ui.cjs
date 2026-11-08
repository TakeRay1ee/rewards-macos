const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('patchright')
const { startPreviewServer } = require('./fixtures/server.cjs')
;(async () => {
    const preview = await startPreviewServer(),
        browser = await chromium.launch({ headless: true })
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1 })
        const output = path.resolve(__dirname, '../../docs/images')
        fs.mkdirSync(output, { recursive: true })
        for (const [route, name] of [
            ['/', 'overview'],
            ['/accounts', 'accounts'],
            ['/reports', 'reports'],
            ['/control', 'control'],
            ['/control/system', 'system']
        ]) {
            await page.goto(preview.base + '/#' + route)
            await page.locator('main h2').first().waitFor()
            await page.waitForTimeout(250)
            await page.mouse.move(240, 5)
            await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true })
        }
        await page.goto(preview.base + '/#/')
        await page.getByRole('button', { name: '切换深色', exact: true }).click()
        await page.waitForTimeout(250)
        await page.mouse.move(240, 5)
        await page.screenshot({ path: path.join(output, 'overview-dark.png'), fullPage: true })
        await page.getByRole('button', { name: '切换浅色', exact: true }).click()
        await page.setViewportSize({ width: 390, height: 844 })
        await page.waitForTimeout(250)
        await page.mouse.move(1, 1)
        await page.screenshot({ path: path.join(output, 'overview-mobile.png'), fullPage: true })
        console.log(JSON.stringify({ output, synthetic: true, screenshots: 7 }))
    } finally {
        await browser.close()
        await preview.close()
    }
})().catch(error => {
    console.error(error)
    process.exitCode = 1
})
