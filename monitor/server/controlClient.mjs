// 上游 Control API 的只读客户端。
// 本模块刻意只导出 GET 方法：监控服务在任何路径下都不应该有能力修改上游状态。
// 写操作（/start /stop /restart /config）属于调度器与 Codex，放在 scheduler.mjs 里，
// 不从这里导出，避免被 HTTP 层误用。

import { CONTROL_API } from './config.mjs'

const DEFAULT_TIMEOUT = 8000

export class ControlApiError extends Error {
    constructor(message, { status = null, path = null, cause = null } = {}) {
        super(message)
        this.name = 'ControlApiError'
        this.status = status
        this.path = path
        this.cause = cause
    }
}

async function request(path, { timeout = DEFAULT_TIMEOUT } = {}) {
    const url = `${CONTROL_API.base}${path}`
    const headers = {}
    if (CONTROL_API.token) headers.Authorization = `Bearer ${CONTROL_API.token}`

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeout)
    try {
        const res = await fetch(url, { headers, signal: ac.signal })
        if (!res.ok) {
            let detail = ''
            try {
                detail = (await res.text()).slice(0, 300)
            } catch {
                /* 忽略正文读取失败 */
            }
            throw new ControlApiError(`上游返回 ${res.status}`, { status: res.status, path, cause: detail })
        }
        return await res.json()
    } catch (error) {
        if (error instanceof ControlApiError) throw error
        const reason = error?.name === 'AbortError' ? `请求超时（${timeout}ms）` : error?.message || '未知网络错误'
        throw new ControlApiError(reason, { path, cause: error })
    } finally {
        clearTimeout(timer)
    }
}

export const controlApi = {
    health: () => request('/health', { timeout: 3000 }),
    status: () => request('/status'),
    accounts: () => request('/accounts'),
    points: () => request('/points'),
    errors: ({ limit = 100, warnings = true } = {}) =>
        request(`/errors?limit=${limit}&warnings=${warnings ? 'true' : 'false'}`),
    history: ({ limit = 50 } = {}) => request(`/history?limit=${limit}`),
    logs: ({ afterId = null, limit = 400, level = null } = {}) => {
        const qs = new URLSearchParams()
        if (afterId != null) qs.set('afterId', String(afterId))
        else qs.set('limit', String(limit))
        if (level) qs.set('level', level)
        return request(`/logs?${qs.toString()}`)
    },
    sessions: () => request('/sessions'),
    diagnostics: () => request('/diagnostics')
}
