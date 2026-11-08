# 来源、许可与署名

## 项目代码来源

本项目是 Microsoft Rewards Script 的本地扩展版，保留原引擎与活动能力，并增加 macOS 原生部署、监控、持久恢复、测试和界面改进。

- 原始上游：[TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script)，本项目继承链对应 **v4**，作者署名 **Netsky**。
- 直接基准：[chiihero/Microsoft-Rewards-Script](https://github.com/chiihero/Microsoft-Rewards-Script)，**V4-china v4.3.3**，提交 `1763135896905d1c08f65d058cdf10860a3b591e`。中文日志、查询源、国内通知等继承自该分支及其贡献者。
- 相关原作者与贡献者署名保留在源文件、包元数据及[上游文档档案](docs/upstream-v4-china.md)中。

项目许可为 **GPL-3.0-or-later**，全文见 [LICENSE](LICENSE)。分发修改版时应保留适用的许可和署名，并满足相应源码提供要求。

## 第三方依赖

Node.js、React、Vite、TypeScript、Patchright、Impit、指纹生成库及其他依赖保留各自许可。准确版本与依赖关系以 `package-lock.json` 和 `monitor/web/package-lock.json` 为准；这些组件不因主项目采用 GPL 而失去其各自署名。

Chromium 由 Patchright 安装工具另行获取，未随公开源码打包。Microsoft Rewards、Bing 等名称和商标属于其各自权利人。本项目不是 Microsoft 官方产品。

## 文档与截图

公开界面截图使用合成演示账号与测试数据。文档中的账号、运行标识和请求键均为示例，不提供真实账号或登录状态。
