# Codex Reset Notifier · Codex 重置与预告通知

[![CI](https://github.com/mancitygalaxy/codex-reset-notifier/actions/workflows/ci.yml/badge.svg)](https://github.com/mancitygalaxy/codex-reset-notifier/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**分别提醒 Codex 重置的预告与重置本身，并区分直接重置和发放重置卡。**

项目在 Cloudflare Workers 云端每 5 分钟检查公开公告，通过企业微信群机器人推送，也可同步到飞书群。预告与实际重置各自去重、分别发送，可以使用不同机器人。电脑关机后，云端仍按配置运行。

这是一个独立社区工具，使用 [Codex Resets](https://codex-resets.com/) 的公开数据。它不读取你的 Codex 登录信息、个人额度或对话，也不调用 OpenAI 模型生成接口。它依据公开公告发送提醒，不核验每个账户是否到账。

## 会收到哪些提醒

| 发生什么 | 收到什么 | 使用哪个机器人 |
| --- | --- | --- |
| 上游出现明确重置预告 | 重置预告，附预计北京时间；时间不明时写“时间待定” | 预告机器人 |
| 预计时间、重置类型或“之前／左右”等时间含义变化 | 预告更新 | 预告机器人 |
| 上游记录已直接重置额度 | 实际重置提醒 | 重置机器人 |
| 上游记录已发放重置卡 | 发卡提醒，说明需要按需手动使用 | 重置机器人 |

**收到预告后，后续真正重置时仍会再提醒一次。** 两者使用不同的去重记录，即使源自同一条公告也不会互相覆盖。预计时间到了仍须等待后续确认，不会自动变成“已经重置”。上游的 `watch` 概率预测不作为明确预告发送。

### 两条独立通知的样子

下面是虚构示例，时间和链接不代表真实公告。飞书使用相同信息生成富文本消息。

**第一条：提前收到预告**

> ⏰ Codex 重置预告，先报个信～
>
> 接下来预计直接重置额度。
>
> 预计重置时间：2026-10-25 10:00 左右（北京时间）
>
> 原公告：A reset is coming at the announced time.
>
> [查看原公告](https://example.invalid/reset-announcement)

**第二条：后续收到实际重置提醒**

> 🚲 Codex 又重置啦，使劲蹬～！！
>
> 这次是直接重置额度。
>
> 重置时间：2026-10-25 10:12:00（北京时间）
>
> 原公告：Usage limits have been reset.
>
> [查看原公告](https://example.invalid/reset-confirmation)

如果这次发的是重置卡，标题会改为“🎫 Codex 发重置卡啦，留着按需用！”，正文明确说明“这次发的是重置卡，留着按需使用。”

## 部署前准备

- Node.js 22 或更新版本、npm 和一个 Cloudflare 账号。
- 企业微信群里的两个机器人 Webhook，分别用于重置和预告。也可以为两个配置填写同一个 Webhook，在同一机器人下分别收两类消息。
- 如需飞书同步，再准备飞书群的两个自定义机器人 Webhook。机器人若启用关键词校验，请包含 `Codex`。当前不支持飞书 Webhook 的签名校验模式。

本仓库只发布源码、示例配置和测试。你需要使用自己的 Cloudflare 资源和机器人凭据；GitHub Actions 只负责检查代码，不运行通知定时任务，也不自动部署。

## 快速部署

以下命令从仓库根目录开始执行，后续操作均在 `cloudflare-worker` 目录中完成。

### 1. 安装依赖并复制配置

```bash
git clone https://github.com/mancitygalaxy/codex-reset-notifier.git
cd codex-reset-notifier/cloudflare-worker
npm ci
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler login
```

Windows PowerShell 可把 `cp` 换成 `Copy-Item`。

### 2. 创建自己的去重存储

```bash
npx wrangler kv namespace create RESET_STATE
```

把命令返回的 namespace ID 填到 `wrangler.jsonc` 的 `kv_namespaces[0].id`，替换 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`。不要复制其他部署的 ID。`name` 也可以改成你自己的 Worker 名称。

示例配置关闭公开访问入口，只保留每 5 分钟运行一次的 Cron。正常部署保留这个设置即可。

### 3. 配置企业微信机器人

```bash
npx wrangler secret put WECOM_WEBHOOK_URL
npx wrangler secret put WECOM_SCHEDULED_WEBHOOK_URL
```

分别在交互提示中粘贴“实际重置／发卡”和“预告／预告更新”机器人的完整 Webhook。凭据存入 Cloudflare Secrets，不写进源码、配置文件或命令参数。首次配置时，Wrangler 可能询问是否创建同名 Worker，按提示创建后继续。

### 4. 可选：同时推送飞书群

在 `wrangler.jsonc` 的 `vars` 中设置：

```json
{
  "FEISHU_ENABLED": "true",
  "FEISHU_DELIVERY_MODE": "group_webhook",
  "FEISHU_GROUP_ID": "oc_mygroup"
}
```

`FEISHU_GROUP_ID` 是稳定的去重标识，格式为 `oc_` 加字母或数字。`oc_mygroup` 是示例，可自行更换；实际收件群由 Webhook 决定，这个标识不用于寻址。更换标识相当于启用一个新的群通道，首次会重新静默登记当前记录。

再配置两个飞书机器人：

```bash
npx wrangler secret put FEISHU_WEBHOOK_URL
npx wrangler secret put FEISHU_SCHEDULED_WEBHOOK_URL
```

分别用于实际重置／发卡与预告／预告更新。群模式只调用群机器人，不需要飞书应用 ID、应用密钥或个人收件人 ID。

### 5. 检查并部署

```bash
npm test
npm run build:check
npm run deploy
npx wrangler tail
```

`build:check` 使用临时示例配置做本地构建检查，不部署、不访问你的真实 KV，也不发消息。正式部署使用你填写的 `wrangler.jsonc`。等待自然定时运行后，检查日志中的 `Baseline initialized` 或 `No new reset or scheduled announcement`。

**首次没有消息可能是正常情况：** 企业微信首次只登记已发生历史，但会提醒当前有效预告；飞书群首次同时登记当前历史和预告，不补发。后续的新预告、更新与实际重置按各自状态提醒。

有关底层配置，可查阅 [Cloudflare KV 入门](https://developers.cloudflare.com/kv/get-started/)、[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) 和 [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。

## 去重与失败处理

- 实际重置以公告 `tweet_id` 保存游标；预告以独立 `scheduled_notice:<tweet_id>` 记录预计时间、类型和截止语义。
- 只有目标平台明确返回成功，才保存该通道的已通知状态。失败后保留原状态，下一轮再次读取上游并重试；一个平台失败不阻止另一个平台完成投递。
- 时间换一种时区写法但对应同一时刻时不重发；预告短暂消失后恢复也不重复提醒。
- 后续已重置记录覆盖同一条或更早的预告时，不再发送旧预告。预告撤回本身目前不单独通知。
- 如果旧游标已不在上游历史列表里，只补最新一条，避免积压消息集中刷屏；更早的遗漏事件不保证全部补齐。
- 修改文案、重新部署或更换预告机器人时，保留原 KV 状态，已通知的公告不会主动重发。

当前没有独立的持久待发送队列；失败重试依赖上游仍能提供相关记录。若外部平台已经收件，但进程在保存成功状态前中断，后续可能重复通知。Workers KV 的最终一致性也可能造成重复；本工具不承诺严格只投递一次。

## 时间与数据边界

- 消息统一显示北京时间（UTC+8）。明确预告采用 `scheduled_for`，缺失时不猜时间。
- 实际提醒中的“重置时间／发卡时间”取上游 `announced_at`，属于公告记录时间，不能当成个人账户实际到账时刻。
- `regular` 表示直接重置额度；`banked` 表示发放可手动使用的重置卡，不能写成额度已自动重置。
- 数据来自第三方公开接口 `https://codex-resets.com/api/resets`；上游更新延迟、记录纠正或不可用会影响提醒。每 5 分钟检查不等于保证 5 分钟内收到所有原始公告。
- 本工具不查询个人用量、不领取或使用重置卡、不自动继续 Codex 对话。

## 配置与源码

| 文件 | 用途 |
| --- | --- |
| `cloudflare-worker/wrangler.example.jsonc` | 可公开的部署模板，复制后填写自己的 KV ID |
| `cloudflare-worker/.dev.vars.example` | 本地配置字段示例，不包含真实凭据 |
| `cloudflare-worker/src/index.js` | 上游读取、两类通知、时间换算、分流与去重 |
| `cloudflare-worker/src/feishu.js` | 飞书群富文本投递，以及可选的应用私聊兼容方式 |
| `cloudflare-worker/test/` | 固定示例、模拟 KV 和模拟消息接口的自动测试 |
| `.github/workflows/ci.yml` | Node.js 22 / 24 测试和构建检查 |

本地测试不会发送真实通知。`.dev.vars.example` 仅说明字段；如果自行启动 Worker 并填入真实 Webhook，触发定时处理会真实发送。

需要飞书应用私聊兼容方式时，设置 `FEISHU_DELIVERY_MODE=app`，并使用 Secrets 配置 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_RECEIVER_OPEN_ID`。该路径使用 `im:message:send_as_bot` 发送权限；请自行确认应用授权与收件范围，群机器人部署不需要这些字段。

## 安全与许可

真实 `wrangler.jsonc`、`.dev.vars`、`.env`、缓存和运行记录均已加入忽略规则。提交前仍需检查实际暂存文件；忽略规则不能清除已经进入 Git 历史的凭据。问题反馈请遵循 [安全说明](SECURITY.md)。

本项目代码使用 [MIT License](LICENSE)。许可证不覆盖 Codex Resets 数据、原始公告或第三方商标；请尊重上游服务和原始内容的使用规则。感谢 [Codex Resets](https://codex-resets.com/) 提供公开的结构化数据。
