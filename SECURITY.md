# 安全说明

本项目通过 Cloudflare Secrets 读取机器人凭据。运行代码只需要公开的重置公告和你配置的通知目标，不需要 Codex 登录态、OpenAI API Key、个人用量或对话记录。

## 报告问题

安全问题请通过 GitHub 的 [私密漏洞报告](https://github.com/mancitygalaxy/codex-reset-notifier/security/advisories/new) 联系维护者。普通功能问题可提交 Issue。

报告中请提供复现条件和已脱敏的错误信息。不要在公开 Issue、日志截图或附件中贴出 Webhook、访问令牌、群与个人标识、Cloudflare 账户信息或真实运行状态。

如果凭据已经泄露，请先在对应平台轮换凭据。删除文件或后来加入 `.gitignore` 不会清除 Git 历史中的旧内容。

## 运行边界

- 重置数据来自第三方公开接口；一条公开公告不代表已经核验某个账户到账。
- 项目按配置向目标机器人发送消息，不从上游内容接受新的收件目标或执行指令。
- 示例配置没有公开 HTTP 入口，GitHub Actions 不持有生产凭据，也不执行实际部署。
- 单元测试拦截网络请求，使用固定示例和模拟消息接口。

公开报告请使用可复现的示例数据，不要上传生产配置或去重存储的完整导出。

## 开发依赖

当前对 Miniflare 的 `undici` 使用 `overrides` 固定到 `7.30.1`，修复开发工具链中的已知漏洞。升级 Wrangler 时请重新核对上游依赖，运行 `npm audit`、测试和构建检查，再决定是否移除覆盖。
