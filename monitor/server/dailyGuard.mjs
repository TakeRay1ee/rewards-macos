// 每日补跑以逐账号成功终态为依据；旧版缺少运行身份的记录明确要求确认。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { PATHS } from './config.mjs'
import { controlApi } from './controlClient.mjs'
import { planDailyRecovery, readRunMetas, writeRecoveryPlan } from './recovery.mjs'
import { calendarDate, dailyScheduledAt, REWARDS_TIME_ZONE } from './calendar.mjs'

export async function main() {
    const dryRun = process.argv.includes('--dry-run')
    const now = new Date()
    const scheduledAt = dailyScheduledAt(now, {
        hour: Number(process.env.REWARDS_DAILY_HOUR ?? 0),
        minute: Number(process.env.REWARDS_DAILY_MINUTE ?? 0)
    })
    const emit = value => {
        const record = {
            at: now.toISOString(),
            timeZone: REWARDS_TIME_ZONE,
            date: calendarDate(now),
            scheduledAt: scheduledAt.toISOString(),
            ...value
        }
        if (!dryRun) writeRecoveryPlan(path.join(PATHS.data, 'daily-guard.json'), record)
        console.log(JSON.stringify(record))
        return record
    }
    if (now < scheduledAt) return emit({ action: 'skip', reason: '未到今日计划时间' })
    const status = await controlApi.status()
    if (status.state !== 'idle') return emit({ action: 'wait', reason: `上游状态 ${status.state}` })
    const [configured, history] = await Promise.all([controlApi.accounts(), controlApi.history({ limit: 200 })])
    let records = []
    try {
        records = fs
            .readFileSync(PATHS.schedulerLog, 'utf8')
            .split('\n')
            .filter(Boolean)
            .flatMap(line => {
                try {
                    return [JSON.parse(line)]
                } catch {
                    return []
                }
            })
    } catch {
        /* 首次调度 */
    }
    const plan = planDailyRecovery({
        now,
        scheduledAt,
        accounts: configured.accounts ?? [],
        records,
        metas: readRunMetas(PATHS.runs),
        apiHistory: [
            ...(history.runs ?? []),
            ...(status.lastRun ? [{ ...status.lastRun, accounts: status.lastRun.run?.accounts ?? [] }] : [])
        ],
        maxAttempts: Number(process.env.DAILY_GUARD_MAX_ATTEMPTS ?? 3)
    })
    if (plan.action !== 'start' || dryRun)
        return emit({ ...plan, action: dryRun && plan.action === 'start' ? 'would-start' : plan.action })
    const child = spawn(
        process.execPath,
        [
            path.join(PATHS.root, 'monitor/server/scheduler.mjs'),
            'run',
            '--reason',
            'daily-catchup',
            '--accounts',
            plan.indexes.join(','),
            '--wait-min',
            '10',
            '--refresh-api'
        ],
        { cwd: PATHS.root, detached: true, stdio: 'ignore', env: { ...process.env } }
    )
    await new Promise((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
    })
    child.unref()
    return emit({ ...plan, action: 'scheduled', pid: child.pid })
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        const record = { at: new Date().toISOString(), action: 'error', reason: error?.message ?? String(error) }
        console.error(JSON.stringify(record))
        if (!process.argv.includes('--dry-run')) writeRecoveryPlan(path.join(PATHS.data, 'daily-guard.json'), record)
        process.exitCode = 1
    })
}
