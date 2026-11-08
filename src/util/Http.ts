import { Impit } from 'impit'
import type { HttpMethod, ImpitResponse, RequestInit as ImpitRequestInit } from 'impit'
import type { AccountProxy } from '../interface/Account'
import { parseBrowserProxyUrl } from './Proxy'

const DEFAULT_TIMEOUT = 20000
const MAX_RETRIES = 3
// macOS 适配（本项目新增，非上游代码）：
// Impit 的 timeout 在我们遇到的一次故障里没有生效——请求既没有返回也没有抛错，
// 整个 worker 以 0% CPU 空等超过 20 分钟，账号表现为"卡住不动"。
// 这里再套一层硬性截止时间，用 AbortController + Promise.race 双保险，
// 保证任何一次请求都会在有限时间内以异常结束，让上层能记录失败并继续。
const HARD_DEADLINE_SLACK_MS = 25000
const HARD_DEADLINE_FLOOR_MS = 45000

const RETRY_BASE_DELAY = 1000

export interface HttpRequestConfig {
    url?: string
    method?: string
    headers?: Record<string, unknown>
    params?: Record<string, string> | URLSearchParams
    data?: unknown
    timeout?: number
    responseType?: 'json' | 'text'
    retries?: number
}

export interface HttpResponse<T = unknown> {
    data: T
    status: number
    statusText: string
    headers: Record<string, string | string[]>
    config: HttpRequestConfig
}

export function mergeRequestHeaders(
    defaultHeaders: Record<string, unknown>,
    requestHeaders: Record<string, unknown> = {}
): Record<string, unknown> {
    const merged = { ...defaultHeaders }

    for (const [key, value] of Object.entries(requestHeaders)) {
        const existingKey = Object.keys(merged).find(name => name.toLowerCase() === key.toLowerCase())
        if (existingKey) delete merged[existingKey]
        merged[key] = value
    }

    return merged
}

function toInit(config: HttpRequestConfig): { url: string; init: ImpitRequestInit } {
    let url = config.url ?? ''
    if (config.params) {
        const qs =
            config.params instanceof URLSearchParams
                ? config.params.toString()
                : new URLSearchParams(config.params).toString()
        if (qs) url += (url.includes('?') ? '&' : '?') + qs
    }

    const headers: Record<string, string> = {}
    if (config.headers) {
        for (const [key, value] of Object.entries(config.headers)) {
            if (value === undefined || value === null) continue
            headers[key] = Array.isArray(value) ? value.join(', ') : String(value)
        }
    }

    let body: ImpitRequestInit['body']
    const data = config.data
    if (data !== undefined && data !== null) {
        if (
            typeof data === 'string' ||
            data instanceof URLSearchParams ||
            data instanceof Uint8Array ||
            data instanceof ArrayBuffer
        ) {
            body = data
        } else {
            body = JSON.stringify(data)
            if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) {
                headers['Content-Type'] = 'application/json'
            }
        }
    }

    const init: ImpitRequestInit = {
        method: (config.method ?? 'GET').toUpperCase() as HttpMethod,
        headers,
        body,
        timeout: config.timeout ?? DEFAULT_TIMEOUT
    }

    return { url, init }
}

async function toResponse<T>(res: ImpitResponse, config: HttpRequestConfig): Promise<HttpResponse<T>> {
    const text = await res.text()

    let data: unknown = text
    if (config.responseType !== 'text') {
        try {
            data = JSON.parse(text)
        } catch {
            data = text
        }
    }

    const headers: Record<string, string | string[]> = {}
    res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
    })

    const withSetCookie = res.headers as Headers & { getSetCookie?: () => string[] }
    const setCookie = typeof withSetCookie.getSetCookie === 'function' ? withSetCookie.getSetCookie() : undefined
    if (setCookie && setCookie.length) headers['set-cookie'] = setCookie

    return {
        data: data as T,
        status: res.status,
        statusText: res.statusText,
        headers,
        config
    }
}

function backoff(retry: number): Promise<void> {
    const ms = RETRY_BASE_DELAY * 2 ** (retry - 1) + Math.floor(Math.random() * 250)
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithHardDeadline<T>(
    instance: Impit,
    url: string,
    init: ImpitRequestInit,
    consume: (response: ImpitResponse) => Promise<T>
): Promise<T> {
    const softMs = typeof init.timeout === 'number' ? init.timeout : DEFAULT_TIMEOUT
    const hardMs = Math.max(softMs + HARD_DEADLINE_SLACK_MS, HARD_DEADLINE_FLOOR_MS)

    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    const guard = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            try {
                controller.abort()
            } catch {
                /* 忽略中止失败 */
            }
            reject(
                new Error(
                    `请求硬超时（${hardMs}ms）：底层 HTTP 客户端未在软超时（${softMs}ms）内返回，已强制中止 | ${url}`
                )
            )
        }, hardMs)
    })

    const task = Promise.resolve().then(async () => {
        const response = await instance.fetch(url, { ...init, signal: controller.signal })
        return consume(response)
    })
    // 竞速失败后，落败的 promise 若再拒绝会产生未处理拒绝，这里提前吞掉
    task.catch(() => {})

    try {
        return await Promise.race([task, guard])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

async function send<T>(
    instance: Impit,
    url: string,
    init: ImpitRequestInit,
    config: HttpRequestConfig
): Promise<HttpResponse<T>> {
    const configuredRetries = config.retries ?? MAX_RETRIES
    const maxRetries = Number.isFinite(configuredRetries) ? Math.max(0, Math.floor(configuredRetries)) : MAX_RETRIES

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let responseStatus: number | undefined

        try {
            const out = await fetchWithHardDeadline(instance, url, init, async response => {
                responseStatus = response.status
                return toResponse<T>(response, config)
            })

            if (out.status >= 200 && out.status < 300) return out

            const error = new Error(`Request failed with status code ${out.status}`) as Error & {
                response?: HttpResponse<T>
                status?: number
            }
            error.response = out
            error.status = out.status
            throw error
        } catch (error) {
            const status = (error as { status?: number })?.status ?? responseStatus
            const permanentClientError =
                typeof status === 'number' &&
                status >= 400 &&
                status < 500 &&
                status !== 408 &&
                status !== 425 &&
                status !== 429

            if (permanentClientError || attempt >= maxRetries) throw error

            await backoff(attempt + 1)
        }
    }

    throw new Error('Request failed after maximum retries')
}

class HttpClient {
    private instance: Impit
    private direct?: Impit
    private account: AccountProxy
    private defaultHeaders: Record<string, unknown>

    constructor(account: AccountProxy, defaultHeaders: Record<string, unknown> = {}) {
        this.account = account
        this.defaultHeaders = { ...defaultHeaders }

        const proxyUrl = this.account.url && this.account.proxyHttp ? this.buildProxyUrl(this.account) : undefined

        this.instance = new Impit({ browser: 'chrome', proxyUrl, timeout: DEFAULT_TIMEOUT })
    }

    public setDefaultHeaders(headers: Record<string, unknown>): void {
        this.defaultHeaders = mergeRequestHeaders(this.defaultHeaders, headers)
    }

    public async request<T = unknown>(config: HttpRequestConfig, useProxy = true): Promise<HttpResponse<T>> {
        const requestConfig: HttpRequestConfig = {
            ...config,
            headers: mergeRequestHeaders(this.defaultHeaders, config.headers)
        }
        const { url, init } = toInit(requestConfig)

        if (!useProxy) {
            if (!this.direct) this.direct = new Impit({ browser: 'chrome', timeout: DEFAULT_TIMEOUT })
            return send<T>(this.direct, url, init, requestConfig)
        }

        return send<T>(this.instance, url, init, requestConfig)
    }

    private buildProxyUrl(proxyConfig: AccountProxy): string {
        const { url: baseUrl, port, username, password } = proxyConfig

        const urlObj = parseBrowserProxyUrl(baseUrl)
        const protocol = urlObj.protocol.toLowerCase()

        if (username && password) {
            urlObj.username = encodeURIComponent(username)
            urlObj.password = encodeURIComponent(password)
            urlObj.port = port.toString()
            return urlObj.toString()
        }

        return `${protocol}//${urlObj.hostname}:${port}`
    }
}

let sharedInstance: Impit | undefined

export async function httpRequest<T = unknown>(config: HttpRequestConfig): Promise<HttpResponse<T>> {
    if (!sharedInstance) sharedInstance = new Impit({ browser: 'chrome', timeout: DEFAULT_TIMEOUT })
    const { url, init } = toInit(config)
    return send<T>(sharedInstance, url, init, config)
}

export default HttpClient
