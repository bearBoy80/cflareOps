# Email 发送功能设计

日期：2026-07-14
状态：待用户审阅

## 目标

在 cloudflareOps 中实现邮件发送能力，长期支撑三个用途：手动发送面板、系统告警通知、定期用量报告。**本期只实现基础层 + 手动发送面板**（含发件人管理、发送记录）；告警和定期报告是后续独立子项目，届时直接复用本期的 `sendEmail()` 服务（定期报告需要额外的 cron 触发器，Cloudflare Pages 不支持 cron，后续单独设计）。

核心决策（已与用户确认）：

- **双 provider 可选**：Resend（官方 `resend` SDK）和 Cloudflare Email Sending（走 CfClient，`cloudflare@6.5.0` 已含 `emailSending.send()`）。统一 `EmailProvider` 接口，便于以后扩展 SMTP 等。
- **多发件域名可选**：每个「发件身份」（provider + 发件地址 + 凭证）存为一条配置，发送时下拉选择。
- **内容格式三选一 + 自动降级**：markdown / html / txt 选其一编写；markdown 渲染成 HTML 正文并附纯文本副本（副本 = markdown 原文），html 仅发 HTML，txt 仅发纯文本。
- **配置存 D1 + 加密，UI 管理**：Resend API key 用现有 AES-GCM 加密存储；Cloudflare 类型直接引用已添加的 `cf_accounts` 账号复用其 token。
- **发送记录持久化**（含正文原文），方便后期查看。
- **发送前预览**：三种格式都支持，预览与实际发出的渲染结果一致。

## 数据模型（`migrations/0002_email.sql`）

### `email_senders` 发件身份表

| 列 | 类型/约束 | 说明 |
|---|---|---|
| `id` | TEXT PRIMARY KEY | `crypto.randomUUID()` |
| `owner_email` | TEXT NOT NULL | 用户数据隔离，所有查询强制过滤 |
| `label` | TEXT NOT NULL | 用户起的显示名，如「运维通知」 |
| `provider` | TEXT NOT NULL CHECK (`provider IN ('resend','cloudflare')`) | |
| `from_address` | TEXT NOT NULL | 发件地址（多域名 = 多条记录） |
| `from_name` | TEXT | 发件显示名，可空 |
| `api_key_ciphertext` | TEXT | 仅 resend：AES-GCM 加密的 API key（`crypto.ts` 现有函数） |
| `api_key_hash` | TEXT | 仅 resend：SHA-256，用于同一用户内去重与识别展示 |
| `cf_account_id` | TEXT REFERENCES `cf_accounts(id)` ON DELETE CASCADE | 仅 cloudflare：复用该账号已存的加密 token；删 CF 账号则级联删除发件身份 |
| `created_at` | TEXT NOT NULL | ISO 时间 |

约束：`provider='resend'` 时 `api_key_ciphertext`/`api_key_hash` 必填；`provider='cloudflare'` 时 `cf_account_id` 必填（应用层校验，SQL 层不加复杂 CHECK）。

### `email_log` 发送记录表

| 列 | 类型/约束 | 说明 |
|---|---|---|
| `id` | TEXT PRIMARY KEY | UUID |
| `owner_email` | TEXT NOT NULL | 隔离 |
| `sender_id` | TEXT REFERENCES `email_senders(id)` ON DELETE SET NULL | 删发件人不丢历史 |
| `provider` / `from_address` | TEXT NOT NULL | 冗余快照，sender 删改后记录仍完整 |
| `recipients_json` | TEXT NOT NULL | `{to: string[], cc: string[], bcc: string[]}` |
| `subject` | TEXT NOT NULL | |
| `format` | TEXT NOT NULL | `'markdown' \| 'html' \| 'text'` |
| `content` | TEXT NOT NULL | **正文原文**（源内容而非渲染结果；回看时用同一 `render.ts` 重新渲染） |
| `status` | TEXT NOT NULL | `'sent' \| 'failed'` |
| `message_id` | TEXT | provider 返回的消息 ID，失败为 NULL |
| `error` | TEXT | 失败原因，成功为 NULL |
| `created_at` | TEXT NOT NULL | 发送时间，建索引按时间倒序分页 |

## 服务层（`src/server/email/`）

```
src/server/email/
  types.ts                 EmailFormat, EmailMessage {to, cc, bcc, subject, format, content}, SendResult, EmailSender
  render.ts                renderBody(format, content) → { html?: string, text?: string }
  providers/resend.ts      官方 resend SDK；错误归一化为 {status, messages}（对齐 CfApiError 形状）
  providers/cloudflare.ts  不直接 fetch —— 走 CfClient 新增的 sendEmail() 方法（维持 CfClient 边界约定）
  index.ts                 sendEmail(ctx, senderId, msg)：查 sender（owner_email 过滤，查不到 NotFoundError）
                           → 解密凭证 → renderBody → 分发 provider → 成败都写 email_log → 返回 SendResult
```

### 渲染规则（`render.ts`，marked 库）

| 格式 | html 正文 | text 正文 |
|---|---|---|
| markdown | `marked.parse(content)`（GFM） | markdown 原文（本身即可读纯文本，零成本降级） |
| html | content 原样 | 无 |
| text | 无 | content 原样 |

- markdown 库选 **`marked`**（~39KB、零依赖、workerd 与浏览器通用；GFM 表格/任务列表够用）。否决 markdown-it（体积大、插件用不上）与 remark 链（过重）。
- `marked` 不做 sanitize：发出的邮件由收件方客户端处理（正常邮件模型）；**本项目 UI 内的一切预览/回看不直接注入 DOM**，见 UI 节的 sandbox iframe。
- 渲染异常（marked 抛错）按 400 处理，不调 provider、不写 log。

### CfClient 扩展（`src/server/cf/client.ts`）

新增 `sendEmail(accountId, params)` 包装 SDK `client.emailSending.send()`（支持 html/text/cc/bcc/from_name）。token 缺 Email Sending 权限时遵守现有约定：**仅该动作 403，不影响只读视图**。

### 新依赖

`resend`、`marked`（均为纯 JS/fetch 实现，workerd 兼容）。

## API 路由（`src/pages/api/email/**`）

所有路由开头 `appContext(locals)`；错误走 `ConfigError` / `NotFoundError` / `CfApiError` 现有体系。

- `GET /api/email/senders` — 列表。**永不返回解密后的 key**，resend 只回 `api_key_hash` 前缀做识别（对齐 accounts 现有做法）。
- `POST /api/email/senders` — 新建：校验 `from_address` 邮箱格式；resend key 加密入库、`api_key_hash` 按用户去重（重复 409）；cloudflare 校验 `cf_account_id` 属当前用户（否则 404）。
- `PUT /api/email/senders/[id]` — 改 label / from / 凭证（换 key 时重新加密+去重）。
- `DELETE /api/email/senders/[id]` — 删除。
- `POST /api/email/send` — `{senderId, to[], cc?, bcc?, subject, format, content}`：服务端校验收件人邮箱格式、subject/content 非空；成败都写 `email_log`；provider 错误透传为结构化 JSON。
- `GET /api/email/log?page=&pageSize=` — 分页（owner_email 过滤，`created_at` 倒序），列表不含 `content`。
- `GET /api/email/log/[id]` — 单条详情（含 `content`）。

## UI（`/email` 页 + React island `EmailPanel`）

新页面 `src/pages/email.astro` + `src/pages/en/email.astro`，导航加入口。页内用现有 `DetailTabs`（URL `?tab=`，服务端读 searchParams 传 `initialTab` 防 hydration mismatch）分三个 tab：

1. **发送**：sender 下拉（label + from 地址）→ 收件人 to/cc/bcc（逗号分隔多个）→ 主题 → 格式切换（markdown/html/txt）→ 正文 textarea → **编辑/预览切换**。发送成功 toast，保留收件人、清空正文。
2. **发件人**：senders 表格 + 新建/编辑表单；选 provider 后动态显示（resend → API key 输入框；cloudflare → 已有 CF 账号下拉）。
3. **记录**：分页表格（时间、发件人、收件人、主题、状态、message_id），行点击看详情：`EmailPreview` 回看正文 + 失败错误信息。

### `EmailPreview` 组件（预览 = 回看，同一组件）

- markdown：浏览器端用**同一版本 `marked`** 渲染 → 装进 sandbox iframe（预览与服务端实际发出的正文一致）
- html：用户 HTML 原样装进 sandbox iframe
- text：等宽 `<pre>` 展示
- iframe 用 `srcdoc` + `sandbox=""`（禁脚本禁同源），**杜绝 `dangerouslySetInnerHTML` 直接注入**（防存储型自 XSS）

### 移动端

遵守 CLAUDE.md 手机端规则：表格包 `overflow-x-auto`、次要列 `hidden sm:table-cell` 逐级隐藏、含汉字小按钮 `whitespace-nowrap`、表单窄屏 `flex-col` 堆叠、tab 内容全宽垂直堆叠；500px 视口零整页横滚验收。

### i18n

全部新字符串进 `src/i18n/index.ts`（zh + en），英文页面在 `src/pages/en/**`。

## 错误处理

- provider 错误归一化为 `{status, messages}`；Resend 错误映射为与 `CfApiError` 同形状后统一走 `handleCfError` 风格的映射。
- 发送失败仍写 log（`status='failed'` + `error`），保证记录完整。
- CF token 缺 Email Sending scope → 该动作 403，带可本地化的稳定错误 `code`。
- 校验失败（邮箱格式、空 subject/content、渲染异常）→ 400，不写 log、不调 provider。

## 测试（Vitest，Node 环境，`createTestDb()` 跑真实迁移）

- `render.test.ts` — 三种格式的渲染输出与降级规则；markdown GFM 基本元素。
- `email-senders-repo.test.ts` — CRUD、owner_email 隔离（A 看不到/删不掉 B 的 sender）、key 加密往返、hash 去重、`cf_accounts` 级联删除。
- `email-send-api.test.ts` — mock 两个 provider：参数组装（html/text 降级正确）、成功/失败均写 log、校验失败 400 不写 log、跨用户 senderId 404。
- `email-log-api.test.ts` — 分页与倒序、列表不含 content、详情含 content、隔离。

workerd 特有行为（SDK fetch 绑定等）测试覆盖不到，实现后用 `npm run preview` 人工验证一次真实发送。

## 后续阶段（不在本期）

1. **同步告警**：sync 失败/token 失效时调 `sendEmail()`，在现有 sync 请求内触发，无需 cron。
2. **定期用量报告**：需要独立 cron 触发器（Pages 不支持 cron，需单独部署带 cron trigger 的 Worker 或外部定时器调用 API），届时单独设计。
