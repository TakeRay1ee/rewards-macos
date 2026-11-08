// 监控服务的统一配置。所有路径、端口、上游地址都在这里解析，
// 其它模块不允许自己拼路径或自己读 process.env。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = path.resolve(here, '..', '..')
export const MONITOR_ROOT = path.resolve(here, '..')

/** 解析 .env，规则与上游 src/util/Load.ts 保持一致：
 *  跳过注释与空行，KEY=VALUE，去掉成对引号，已存在的真实环境变量优先。 */
function loadEnvFile(file) {
    if (!fs.existsSync(file)) return
    const raw = fs.readFileSync(file, 'utf-8')
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        const key = trimmed.slice(0, eq).trim()
        let value = trimmed.slice(eq + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
        }
        if (process.env[key] === undefined) process.env[key] = value
    }
}

loadEnvFile(path.join(PROJECT_ROOT, '.env'))

export const CONTROL_API = {
    host: process.env.API_HOST || '127.0.0.1',
    port: Number(process.env.API_PORT || 3010),
    token: process.env.API_TOKEN || '',
    get base() {
        return `http://${this.host}:${this.port}`
    }
}

export const MONITOR = {
    host: '127.0.0.1',
    port: Number(process.env.MONITOR_PORT || 3000),
    // 采集节奏：上游 /logs 是内存环形缓冲，轮询足够快即可，不必上 SSE 中转
    pollStatusMs: Number(process.env.MONITOR_POLL_STATUS_MS || 2000),
    pollLogsMs: Number(process.env.MONITOR_POLL_LOGS_MS || 1500),
    logMemoryCap: Number(process.env.MONITOR_LOG_CAP || 5000),
    snapshotLogWindow: 400
}

export const PATHS = {
    root: PROJECT_ROOT,
    sessions: path.join(PROJECT_ROOT, 'sessions'),
    logs: path.join(PROJECT_ROOT, 'logs'),
    config: path.join(PROJECT_ROOT, 'config.json'),
    data: path.join(MONITOR_ROOT, 'data'),
    runs: path.join(MONITOR_ROOT, 'data', 'runs'),
    calibration: path.join(MONITOR_ROOT, 'data', 'calibration.json'),
    schedulerLog: path.join(MONITOR_ROOT, 'data', 'scheduler.jsonl'),
    lastRun: path.join(MONITOR_ROOT, 'data', 'last-run.json')
}

export function ensureDirs() {
    for (const dir of [PATHS.data, PATHS.runs]) {
        fs.mkdirSync(dir, { recursive: true })
    }
}

/** 资源预算参数。数值都可用环境变量覆盖，含义写在 README_CN.md 里。
 *  这里没有"业务并发上限"，只有对物理资源的估算。 */
export const BUDGET = {
    // 为系统、GUI、监控服务预留的内存（GB）。低于此值不再给浏览器分配。
    // 3GB 在 16GB 机器上会把绝大多数可用内存吃掉，导致 clusters 恒为 1；
    // 1.5GB 足够覆盖 macOS 的缓存回收与监控服务自身开销。
    reserveGb: Number(process.env.MONITOR_RESERVE_GB || 1.5),
    // 首次运行前没有实测值时的保守估计（MB/账号）。
    defaultFootprintMb: Number(process.env.MONITOR_DEFAULT_FOOTPRINT_MB || 700),
    // 单轮最多允许派生的 worker 数只受内存推导约束，不设常量上限
    hardCap: 0
}
