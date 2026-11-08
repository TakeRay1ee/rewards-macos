// 监控服务入口。监听 127.0.0.1:3000（可用 MONITOR_PORT 覆盖）。
// 提供监控快照、受限控制与停滞恢复，业务任务由上游引擎执行。

import { MONITOR } from './config.mjs'
import { createServer } from './server.mjs'

const { server, service } = createServer()

server.listen(MONITOR.port, MONITOR.host, () => {
    console.log(`[monitor] 监控与控制已启动 http://${MONITOR.host}:${MONITOR.port}`)
    console.log(`[monitor] 上游 Control API 由配置决定，鉴权 token ${process.env.API_TOKEN ? '已启用' : '未启用'}`)
})

server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
        console.error(`[monitor] 端口 ${MONITOR.port} 已被占用，请先停止旧实例或设置 MONITOR_PORT`)
    } else {
        console.error('[monitor] 服务错误', error)
    }
    process.exit(1)
})

let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        if (shuttingDown) return
        shuttingDown = true
        console.log(`[monitor] 收到 ${signal}，正在退出`)
        for (const client of service.clients) client.end()
        service.clients.clear()
        server.close(() => process.exit(0))
        server.closeIdleConnections()
        setTimeout(() => {
            server.closeAllConnections()
            process.exit(1)
        }, 5000).unref()
    })
}
