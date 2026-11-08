# 当前 Control API 扩展

Control API 默认监听 `http://127.0.0.1:3010`。本页描述本地扩展版的运行身份与恢复契约；完整配置、通知和历史上游选项可查[上游文档档案](upstream-v4-china.md)。

接口使用 Node.js 内置 HTTP 与 SQLite，执行原引擎进程。监控服务默认在 3000 端口聚合其查询结果，并为 GUI 提供独立的受限管理入口。

## 常用路由

| 方法与路径                  | 行为                                                 |
| --------------------------- | ---------------------------------------------------- |
| `GET /health`               | 服务健康、`serverPid`、`serviceStartedAt` 与运行状态 |
| `GET /status`               | 当前/最近运行身份、账号选择、进程和恢复观测状态      |
| `GET /accounts`             | 已配置账号摘要，不返回密码                           |
| `GET /points`               | 已观测积分、余额和账号结果                           |
| `GET /logs` / `GET /events` | 结构化日志查询 / SSE                                 |
| `GET /history`              | 持久运行历史                                         |
| `GET /sessions`             | 实际 `sessionPath` 的会话摘要                        |
| `POST /start`               | 启动全部、单个或排除部分账号后的运行                 |
| `POST /stop`                | 停止预期批次；可升级为强制停止                       |
| `POST /restart`             | 按幂等键与预期批次保护的重启                         |

启用 `API_TOKEN` 后使用 `Authorization: Bearer <token>` 或受支持的 API key 头。本机界面通过监控后端连接上游；不要将这两个本地服务直接暴露到公网。

## 稳定身份

`/status`、`/points`、`/history` 与日志关联稳定 `runId`；`selectedAccounts` 保留原始配置槽位：

```json
{
    "runId": "example-run-id",
    "selectedAccounts": [{ "index": 100, "email": "demo@example.invalid" }]
}
```

单账号执行可以在引擎环境内临时重编号，但公开契约不把原 100 号误报为 1 号。idle 时保留最近运行身份与 `lastRun` 终态，不能把没有活进程理解为从未运行。

`/history` 的账号结果使用 `collected: null` 表示没有观测到收益，`collectedObserved: false`；确认过的零收益为 `collected: 0`、`collectedObserved: true`。正负收益也只有在日志或账号终态提供事实后才返回数值。界面合并本地历史时按账号保留这些语义，并接受上游稍后确认的新结果。

账号的 `terminalAt` 记录其完成、失败或明确流程失败的时间，与最后一次积分观测时间分开。今日状态和补跑守卫优先按该账号终态归入上海自然日；较早的余额观测及较晚的整轮结束都不会移动一个已确认账号结果的日期。旧记录缺少字段时使用既有时间证据，不补造终态。

## 幂等启动

示例请求体：

```json
{
    "accountIndex": 100,
    "requestId": "manual-example-001"
}
```

不带账号选择时运行所有配置账号，也支持 `excludedAccountIndexes` 排除账号。`accountIndex` 与排除列表不能同时使用。

同一 `requestId` 在运行中、完成后或 API 重启后重放，会返回原 `runId` 和 `duplicate: true`，不再创建第二个任务。接收到请求与任务实际完成是不同状态；调用者应继续查询运行结果。

## 停止保护

```json
{
    "expectedRunId": "example-run-id",
    "force": true
}
```

`/stop` 的 202 响应表示停止已接收，运行可能仍是 `stopping`；调用者需要有界等待同一批次进入 `idle`。预期身份不匹配返回 `409 STALE_RUN`，不能对当前其他批次发信号。

已经优雅停止后再次发送 `force: true` 会立即升级信号。`/restart` 先校验参数和持久幂等键，再停止当前运行；重放旧请求不会误停后来的一轮。

## 崩溃恢复

`.control-api/runtime.sqlite` 保存启动预留、运行身份、账号选择、状态 checkpoint、日志、有限历史和持久请求键。重启时检查原生进程创建时间、进程组与命令摘要，防止 PID 复用时控制无关进程。

若已登记的任务仍存活，API 保持 busy 并可在身份匹配后停止它。若只有启动预留而无可靠 PID，或身份无法确认，则返回需恢复状态，保守拒绝重复启动；不提供按名字批量终止浏览器的捷径。

旧 stdout 不能重新连接。此时 `recovered: true`、`logStreamAvailable: false`；积分端点以 `live: false` / `stale: true` 表明数据来自最后观测，不能伪造实时进展或成功退出码。

## 监控管理入口

3000 端口的 `/api/control/action` 接收白名单操作，需要本机控制密钥与明确确认；动作之间有短冷却。非法 JSON 类型稳定返回 4xx，不能使服务退出。控制入口限制本机 Host 与同源页面。

GUI 的“重启服务”通过 `launchctl kickstart -k` 重启 API，观测到新的服务实例后再重启监控。正常监控退出会关闭 SSE 连接，页面开着也不会阻止服务收尾。
