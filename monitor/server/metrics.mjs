// 本机系统指标采集。全部走 macOS 原生接口（vm_stat / sysctl / ps / os），
// 不做任何估算或推算，拿不到就返回 null 并由前端显示"未知"。

import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const CHROMIUM_MARKERS = ['chrome-headless-shell', 'Google Chrome for Testing.app/Contents/MacOS']

async function run(cmd, args) {
    try {
        const { stdout } = await execFileAsync(cmd, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
        return stdout
    } catch (error) {
        return { error: error?.message ?? String(error) }
    }
}

function parseVmStat(text) {
    const out = {}
    for (const line of String(text).split('\n')) {
        const m = line.match(/^(.+?):\s+(\d+)\.?\s*$/)
        if (m) out[m[1].trim()] = Number(m[2])
    }
    return out
}

export async function readMemory() {
    const pageSizeOut = await run('sysctl', ['-n', 'hw.pagesize'])
    const totalOut = await run('sysctl', ['-n', 'hw.memsize'])
    const vmOut = await run('vm_stat', [])

    const pageSize = Number(String(pageSizeOut).trim()) || 4096
    const total = Number(String(totalOut).trim()) || os.totalmem()
    if (typeof vmOut !== 'string') {
        return { totalBytes: total, source: 'os', availableBytes: os.freemem(), note: 'vm_stat 不可用' }
    }

    const v = parseVmStat(vmOut)
    const pages = key => (typeof v[key] === 'number' ? v[key] : 0)
    // macOS 上"可回收"内存 ≈ free + inactive + purgeable + speculative
    const availablePages =
        pages('Pages free') + pages('Pages inactive') + pages('Pages purgeable') + pages('Pages speculative')
    const available = availablePages * pageSize
    const wired = pages('Pages wired down') * pageSize

    return {
        totalBytes: total,
        availableBytes: available,
        wiredBytes: wired,
        pageSize,
        source: 'vm_stat',
        formula: 'free + inactive + purgeable + speculative',
        compressedBytes: pages('Pages occupied by compressor') * pageSize
    }
}

let lastCpuSample = null

export function readCpu() {
    const cpus = os.cpus()
    let idle = 0
    let total = 0
    for (const cpu of cpus) {
        for (const t of Object.values(cpu.times)) total += t
        idle += cpu.times.idle
    }
    let usagePercent = null
    if (lastCpuSample) {
        const idleDelta = idle - lastCpuSample.idle
        const totalDelta = total - lastCpuSample.total
        if (totalDelta > 0) usagePercent = Math.round((1 - idleDelta / totalDelta) * 1000) / 10
    }
    lastCpuSample = { idle, total }

    return {
        cores: cpus.length,
        loadAvg: os.loadavg().map(v => Math.round(v * 100) / 100),
        usagePercent,
        source: 'os.cpus 采样差分'
    }
}

export async function readProcesses() {
    const out = await run('ps', ['-axo', 'pid,ppid,rss,pcpu,etime,command'])
    if (typeof out !== 'string') {
        return { error: 'ps 不可用', workers: [], browsers: [], api: null, monitor: null }
    }

    const rows = []
    for (const line of out.split('\n').slice(1)) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/)
        if (!m) continue
        rows.push({
            pid: Number(m[1]),
            ppid: Number(m[2]),
            rssMb: Math.round(Number(m[3]) / 1024),
            cpuPercent: Number(m[4]),
            etime: m[5],
            command: m[6]
        })
    }

    const workers = rows.filter(r => r.command.includes('dist/index.js'))
    const browsers = rows.filter(r => CHROMIUM_MARKERS.some(marker => r.command.includes(marker)))
    const api = rows.find(r => r.command.includes('scripts/api/server.js')) ?? null
    const monitor = rows.find(r => r.command.includes('monitor/server/index.mjs')) ?? null

    // 一个浏览器实例 = 一个不带 --type= 的顶层进程
    const browserInstances = browsers.filter(r => !r.command.includes('--type='))
    const browserRss = browsers.reduce((sum, r) => sum + r.rssMb, 0)
    const workerRss = workers.reduce((sum, r) => sum + r.rssMb, 0)

    return {
        workers: workers.map(w => ({
            pid: w.pid,
            ppid: w.ppid,
            rssMb: w.rssMb,
            cpuPercent: w.cpuPercent,
            etime: w.etime
        })),
        browserInstances: browserInstances.length,
        browserProcessCount: browsers.length,
        browserRssMb: browserRss,
        workerRssMb: workerRss,
        api,
        monitor,
        totalProcessCount: rows.length,
        source: 'ps -axo'
    }
}

export async function readSystemSnapshot() {
    const [memory, processes] = await Promise.all([readMemory(), readProcesses()])
    const cpu = readCpu()
    return {
        at: new Date().toISOString(),
        host: {
            platform: process.platform,
            arch: process.arch,
            release: os.release(),
            nodeVersion: process.version,
            uptimeSec: Math.round(os.uptime()),
            hostname: os.hostname()
        },
        cpu,
        memory,
        processes
    }
}
