const test = require('node:test'),
    assert = require('node:assert/strict')
const { loadSource } = require('./source-loader.cjs')
function client(fetch) {
    return loadSource(
        'src/util/Http.ts',
        {
            impit: {
                Impit: class {
                    fetch(...args) {
                        return fetch(...args)
                    }
                }
            },
            './Proxy': { parseBrowserProxyUrl: v => new URL(v) }
        },
        { setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 15)), clearTimeout }
    )
}
const response = (status, body) => ({
    status,
    statusText: String(status),
    text: async () => body,
    headers: { forEach() {} }
})
test('HTTP request deadline includes a stalled response body and aborts without a late rejection', async () => {
    let aborted = false
    const api = client(async (_url, options) => {
        options.signal.addEventListener('abort', () => {
            aborted = true
        })
        return { ...response(200, ''), text: () => new Promise(() => {}) }
    })
    const result = await Promise.race([
        api.httpRequest({ url: 'https://example.invalid', retries: 0 }).then(
            () => 'resolved',
            e => e.message
        ),
        new Promise(r => setTimeout(() => r('still pending'), 100))
    ])
    assert.match(result, /硬超时/)
    assert.equal(aborted, true)
})
test('HTTP deadline preserves successful JSON/text and permanent HTTP errors without retries', async () => {
    let requests = 0
    const api = client(async () => {
        requests++
        return response(200, '{"points":0}')
    })
    assert.equal((await api.httpRequest({ url: 'https://example.invalid', retries: 0 })).data.points, 0)
    assert.equal(
        (await api.httpRequest({ url: 'https://example.invalid', responseType: 'text', retries: 0 })).data,
        '{"points":0}'
    )
    const bad = client(async () => {
        requests++
        return response(403, 'denied')
    })
    await assert.rejects(() => bad.httpRequest({ url: 'https://example.invalid', retries: 3 }), /403/)
    assert.equal(requests, 3)
})
