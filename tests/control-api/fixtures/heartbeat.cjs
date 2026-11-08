const fs = require('node:fs')
const path = require('node:path')
let outputOpen = true
process.stdout.on('error', error => {
    if (error.code === 'EPIPE') outputOpen = false
    else throw error
})
if (process.argv.includes('--ignore-term')) process.on('SIGTERM', () => {})
function beat() {
    fs.appendFileSync(path.join(process.cwd(), `beats-${process.pid}`), 'beat\n')
    if (outputOpen) process.stdout.write('AUDIT_READY_HEARTBEAT\n')
}
if (process.argv.includes('--with-points')) {
    process.stdout.write(
        '[2026-11-08 12:00:00] [one@example.invalid] [INFO] MAIN [ACCOUNT-START] 开始处理账户: one@example.invalid | geoLocale: CN | locale: zh-CN\n'
    )
    process.stdout.write(
        '[2026-11-08 12:00:01] [one@example.invalid] [INFO] DESKTOP [SEARCH-BING] 必应搜索完成 | pointsGained=3 | currentBalance=103\n'
    )
}
beat()
setInterval(beat, 100)
setTimeout(() => process.exit(0), 20000)
