import { httpRequest } from '../util/Http'
import type { HttpRequestConfig } from '../util/Http'
import PQueue from 'p-queue'
import type { WebhookNtfyConfig } from '../interface/Config'
import type { LogLevel } from './Logger'
import { flushQueue } from './Queue'

const ntfyQueue = new PQueue({
    interval: 1000,
    intervalCap: 2,
    carryoverConcurrencyCount: true
})

export async function sendNtfy(config: WebhookNtfyConfig, content: string, level: LogLevel): Promise<void> {
    if (!config?.url) return

    const priority = level === 'error' ? 5 : level === 'warn' ? 4 : config.priority

    const headers: Record<string, string> = { 'Content-Type': 'text/plain' }
    if (config.title) headers['Title'] = config.title
    if (config.tags?.length) headers['Tags'] = config.tags.join(',')
    if (priority) headers['Priority'] = String(priority)
    if (config.token) headers['Authorization'] = `Bearer ${config.token}`

    const url = config.topic ? `${config.url}/${config.topic}` : config.url

    const request: HttpRequestConfig = {
        method: 'POST',
        url: url,
        headers,
        data: content,
        timeout: 10000
    }

    await ntfyQueue.add(async () => {
        try {
            await httpRequest(request)
        } catch (err) {
            const status = (err as { response?: { status?: number } })?.response?.status
            if (status === 429) return
        }
    })
}

export function flushNtfyQueue(timeoutMs = 5000): Promise<void> {
    return flushQueue(ntfyQueue, timeoutMs)
}
