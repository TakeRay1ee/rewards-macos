// 浏览器网络探测：用与自动化完全一致的启动参数，逐个访问微软关键域名。
//
// 用途：当出现「curl 正常但脚本报 ERR_CONNECTION_CLOSED」时，用它区分
//       是站点问题、代理问题，还是 Chromium 的网络栈问题。
//
// 用法：
//   /opt/homebrew/bin/node scripts/macos/net-probe.mjs
//   /opt/homebrew/bin/node scripts/macos/net-probe.mjs --proxy http://127.0.0.1:7897
//
// 注意：必须从真实终端或 launchd 运行。某些 IDE 沙箱会拦截浏览器进程的裸 socket，
//       在那类环境里跑出来的失败不能代表本机真实网络。

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('patchright')

const args = process.argv.slice(2)
const proxyIdx = args.indexOf('--proxy')
const proxy = proxyIdx >= 0 ? { server: args[proxyIdx + 1] } : null
const disableDoh = !args.includes('--with-doh')

const TARGETS = [
    'https://www.bing.com/',
    'https://cn.bing.com/',
    'https://login.live.com/',
    'https://account.microsoft.com/',
    'https://rewards.bing.com/about',
    'https://rewards.bing.com/earn'
]

const BROWSER_ARGS = [
    '--no-first-run',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    ...(disableDoh ? ['--disable-features=DnsOverHttps'] : []),
    ...(proxy ? [] : ['--no-proxy-server'])
]

const browser = await chromium.launch({ headless: true, args: BROWSER_ARGS, ...(proxy ? { proxy } : {}) })
const page = await browser.newPage()

console.log(`探测配置：proxy=${proxy ? proxy.server : '直连'} · DoH=${disableDoh ? '已关闭' : '开启'}`)
console.log(`${'结果'.padEnd(10)} 目标`)
console.log('-'.repeat(72))

let ok = 0
for (const url of TARGETS) {
    const started = Date.now()
    try {
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
        const status = res?.status() ?? 0
        const ms = Date.now() - started
        if (status && status < 400) ok += 1
        console.log(`${String(status).padEnd(10)} ${url}  (${ms}ms → ${page.url().slice(0, 55)})`)
    } catch (error) {
        const msg = String(error?.message ?? error)
            .split('\n')[0]
            .slice(0, 90)
        console.log(`${'FAIL'.padEnd(10)} ${url}  ${msg}`)
    }
}

await browser.close()

console.log('-'.repeat(72))
console.log(`通过 ${ok}/${TARGETS.length}`)
if (ok === 0) {
    console.log(`
全部失败时按顺序排查：
  1) 关掉系统代理再跑一次，看是否与本地代理的分流规则有关
  2) 换 --proxy 指向你的代理端口，对比直连与代理
  3) 若只有微软账号域名失败、bing 正常，多半是代理规则把 Chrome 进程单独分流到了不可用节点
  4) 加 --with-doh 对比，若开启 DoH 反而更差，说明 TUN 的 fake-IP 与浏览器自带 DNS 冲突
`)
    process.exitCode = 1
}
