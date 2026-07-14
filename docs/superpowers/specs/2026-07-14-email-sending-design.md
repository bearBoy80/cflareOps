# Email 发送功能设计

日期：2026-07-14
状态：待用户审阅

## 目标

在 cloudflareOps 中实现邮件发送能力，长期支撑三个用途：手动发送面板、系统告警通知、定期用量报告。**本期只实现基础层 + 手动发送面板**（含发送域名管理、发送记录）；告警和定期报告是后续独立子项目，届时直接复用本期的 `sendEmail()` 服务（定期报告需要额外的 cron 触发器，Cloudflare Pages 不支持 cron，后续单独设计）。

核心决策（已与用户确认）：

- **双 provider 可选**：Resend（官方 `resend` SDK）和 Cloudflare Email Sending（走 CfClient，`cloudflare@6.5.0` 已含 `emailSending.send()`）。统一 `EmailProvider` 接口，便于以后扩展 SMTP 等。
- **按域名配置发送服务**：每个发送域名存一条配置（域名 → 用哪个 provider + 对应凭证），发送时选域名、发件地址的 local 部分自由填写。不按具体发件地址预注册（Resend/CF 验证的是域名而非单个地址，地址级配置是多余的一层）。
- **内容格式三选一 + 自动降级**：markdown / html / txt 选其一编写；markdown 渲染成 HTML 正文并附纯文本副本（副本 = markdown 原文），html 仅发 HTML，txt 仅发纯文本。
- **配置存 D1 + 加密，UI 管理**：Resend API key 用现有 AES-GCM 加密存储；Cloudflare 类型直接引用已添加的 `cf_accounts` 账号复用其 token。
- **发送记录持久化**（含正文原文），方便后期查看。
- **发送前预览**：三种格式都支持，预览与实际发出的渲染结果一致。

## 数据模型（`migrations/0002_email.sql`）

### `email_domains` 发送域名配置表

**为什么按域名而不是按发件地址建模**：Resend 和 CF Email Sending 的验证单位都是域名——域名通过验证（DNS/DKIM）后，该域名下任意 `xxx@域名` 都可以发。若按具体地址预注册，每换一个 local 部分都要先建配置，是 provider 模型之外多出来的一层限制。按域名配置后，发送时选域名 + 自由填写 local 部分即可。

| 列 | 类型/约束 | 说明 | 为什么 |
|---|---|---|---|
| `id` | TEXT PRIMARY KEY | `crypto.randomUUID()` | 与 `cf_accounts` 一致的主键风格 |
| `owner_email` | TEXT NOT NULL | 用户数据隔离 | 项目铁律：所有用户数据查询强制过滤 |
| `domain` | TEXT NOT NULL，`UNIQUE(owner_email, domain)` | 发送域名，如 `mail.example.com` | 一个域名只能绑定一个 provider，避免同域名两条配置发信行为不确定；唯一约束限定在用户内，不同用户可各自配置同名域名 |
| `provider` | TEXT NOT NULL CHECK (`IN ('resend','cloudflare')`) | 该域名用哪个服务发 | CHECK 兜底防脏数据；字符串枚举便于以后加 `'smtp'` 等新值（改 CHECK 即可，无需改表结构） |
| `api_key_ciphertext` | TEXT | 仅 resend：AES-GCM 加密的 API key | 凭证不明文落库（复用 `crypto.ts`，与 `cf_accounts.token` 同一套加密）；每个域名独立存 key 是因为不同域名可能挂在不同 Resend 账号下 |
| `api_key_hash` | TEXT | 仅 resend：SHA-256 | 密文因 IV 随机不可比对，需要 hash 做去重和 UI 识别展示（只露前几位），永不解密回显 |
| `cf_account_id` | TEXT REFERENCES `cf_accounts(id)` ON DELETE CASCADE | 仅 cloudflare：域名所属 CF 账号 | 复用该账号已存的加密 token，不重复存凭证（一处轮换处处生效）；CASCADE 与现有缓存表一致——账号删了，其发送配置成为孤儿没有意义 |
| `created_at` | TEXT NOT NULL | ISO 时间 | 与现有表一致 |

凭证列按 provider 二选一必填（应用层校验，SQL 不加跨列 CHECK——与项目「复杂约束放应用层」的现状一致）。

### `email_log` 发送记录表

**为什么要有这张表**：用户明确要求发送记录可后期回看；同时告警/定期报告（后续阶段）复用 `sendEmail()` 后，这张表天然成为全部出信的审计流水。

| 列 | 类型/约束 | 说明 | 为什么 |
|---|---|---|---|
| `id` | TEXT PRIMARY KEY | UUID | |
| `owner_email` | TEXT NOT NULL | 隔离 | 同上，铁律 |
| `domain_id` | TEXT REFERENCES `email_domains(id)` ON DELETE SET NULL | 来源域名配置 | SET NULL 而非 CASCADE：删配置不应抹掉发送历史（审计价值），与缓存表的 CASCADE 语义刻意不同——log 是事实记录不是缓存 |
| `provider` / `from_address` | TEXT NOT NULL | 冗余快照 | 配置删改后记录仍独立完整可读，不依赖 JOIN 存活 |
| `recipients_json` | TEXT NOT NULL | `{to, cc, bcc}` | 收件人数量不定，JSON 存单列避免子表（查询场景只有展示，无按收件人检索需求，YAGNI） |
| `subject` / `format` / `content` | TEXT NOT NULL | 主题、格式、**正文原文** | 存源内容而非渲染后 HTML：体积更小，回看时用同一 `render.ts` 重新渲染，与发送时所见一致 |
| `status` | TEXT NOT NULL | `'sent' \| 'failed'` | 失败也写记录，排障时能看到「发过但没成」 |
| `message_id` | TEXT | provider 消息 ID | 到 provider 后台对查投递状态的凭据，失败为 NULL |
| `error` | TEXT | 失败原因 | 结构化错误信息直接落库，排障不用翻日志 |
| `created_at` | TEXT NOT NULL，建索引 | 发送时间 | `(owner_email, created_at DESC)` 索引支撑记录页倒序分页 |

## 服务层（`src/server/email/`）

```
src/server/email/
  types.ts                 EmailFormat, EmailMessage {from, fromName, to, cc, bcc, subject, format, content},
                           SendResult, EmailDomain
  render.ts                renderBody(format, content) → { html?: string, text?: string }
  providers/resend.ts      官方 resend SDK；错误归一化为 {status, messages}（对齐 CfApiError 形状）
  providers/cloudflare.ts  不直接 fetch —— 走 CfClient 新增的 sendEmail() 方法（维持 CfClient 边界约定）
  index.ts                 sendEmail(ctx, domainId, msg)：查域名配置（owner_email 过滤，查不到 NotFoundError）
                           → 校验 msg.from 的域名部分 === 配置的 domain（防止用未配置的域名发信）
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

- `GET /api/email/domains` — 列表。**永不返回解密后的 key**，resend 只回 `api_key_hash` 前缀做识别（对齐 accounts 现有做法）。
- `POST /api/email/domains` — 新建：校验 `domain` 域名格式、同用户内唯一（重复 409）；resend key 加密入库；cloudflare 校验 `cf_account_id` 属当前用户（否则 404）。
- `PUT /api/email/domains/[id]` — 改 provider / 凭证（换 key 时重新加密）。
- `DELETE /api/email/domains/[id]` — 删除（log 中的历史经 SET NULL + 快照列保留）。
- `POST /api/email/send` — `{domainId, from, fromName?, to[], cc?, bcc?, subject, format, content}`：服务端校验 `from` 域名部分与配置一致、收件人邮箱格式、subject/content 非空；成败都写 `email_log`；provider 错误透传为结构化 JSON。
- `GET /api/email/log?page=&pageSize=` — 分页（owner_email 过滤，`created_at` 倒序），列表不含 `content`。
- `GET /api/email/log/[id]` — 单条详情（含 `content`）。

## UI（`/email` 页 + React island `EmailPanel`）

新页面 `src/pages/email.astro` + `src/pages/en/email.astro`，导航加入口。页内用现有 `DetailTabs`（URL `?tab=`，服务端读 searchParams 传 `initialTab` 防 hydration mismatch）分三个 tab：

1. **发送**：域名下拉 → 发件人 local 部分输入框（后缀自动带出 `@域名`）+ 可选显示名 → 收件人 to/cc/bcc（逗号分隔多个）→ 主题 → 格式切换（markdown/html/txt）→ 正文 textarea → **编辑/预览切换**。发送成功 toast，保留收件人、清空正文。
2. **域名**：已配置域名表格（域名、provider、凭证识别位）+ 新建/编辑表单；选 provider 后动态显示（resend → API key 输入框；cloudflare → 已有 CF 账号下拉）。
3. **记录**：分页表格（时间、发件地址、收件人、主题、状态、message_id），行点击看详情：`EmailPreview` 回看正文 + 失败错误信息。

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
- `email-domains-repo.test.ts` — CRUD、owner_email 隔离（A 看不到/删不掉 B 的域名）、同用户域名唯一、key 加密往返、`cf_accounts` 级联删除、删域名后 log SET NULL。
- `email-send-api.test.ts` — mock 两个 provider：参数组装（html/text 降级正确）、from 域名与配置不符 400、成功/失败均写 log、校验失败 400 不写 log、跨用户 domainId 404。
- `email-log-api.test.ts` — 分页与倒序、列表不含 content、详情含 content、隔离。

workerd 特有行为（SDK fetch 绑定等）测试覆盖不到，实现后用 `npm run preview` 人工验证一次真实发送。

## 后续阶段（不在本期）

1. **同步告警**：sync 失败/token 失效时调 `sendEmail()`，在现有 sync 请求内触发，无需 cron。
2. **定期用量报告**：需要独立 cron 触发器（Pages 不支持 cron，需单独部署带 cron trigger 的 Worker 或外部定时器调用 API），届时单独设计。
