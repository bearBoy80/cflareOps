# Email 发送功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手动发送邮件面板：按域名配置双 provider（Resend / Cloudflare Email Sending），markdown/html/txt 三格式 + 自动降级，发送记录持久化，发送前预览。

**Architecture:** 数据层新增 `email_domains`（域名 → provider + 凭证）与 `email_log`（发送事实记录）两张 D1 表；服务层 `src/server/email/` 统一 `sendEmail()` 编排（查配置 → 校验 from 域名 → 渲染 → 分发 provider → 成败都写 log）；Cloudflare 走 CfClient 新增的 `sendEmail()` 方法，Resend 走官方 SDK 并把错误归一化为 `CfApiError`；UI 为 `/email` 页 + `EmailPanel` island（发送 / 域名 / 记录三 tab），预览与回看共用 sandbox iframe 组件。

**Tech Stack:** Astro 5 SSR + React 19 islands、D1 (SQLite)、cloudflare@6.5.0 SDK（`emailSending.send()`，URL `/accounts/:id/email/sending/send`）、`resend` SDK、`marked`（markdown 渲染，服务端与浏览器共用同一版本）、Vitest + better-sqlite3 测试替身。

**规格来源:** `docs/superpowers/specs/2026-07-14-email-sending-design.md`

**对规格的一处修正（实现时必须遵循本计划）:** 规格中 `email_domains.cf_account_id REFERENCES cf_accounts(id)` 与项目既有命名冲突——全库惯例是 `account_id` = 本系统账号记录 id（FK），`cf_account_id` = CF 侧账号 id（见 zones / workers_scripts 表）。且 SDK `emailSending.send()` 的 `account_id` 参数需要的是 **CF 侧账号 id**（一个 token 可见多个 CF 账号），单存 FK 不够。因此本计划拆成两列：`account_id TEXT REFERENCES cf_accounts(id) ON DELETE CASCADE`（复用其 token）+ `cf_account_id TEXT`（CF 侧账号 id，配置时选定）。为此新增 `GET /api/accounts/[id]/cf-accounts` 端点供 UI 下拉选择。

## Global Constraints

- 导入一律用路径别名：`@/*` → `src/*`，`@tests/*` → `tests/*`；同目录 `./` 可用；禁止 `../`。
- 所有用户数据查询必须按 `owner_email = ?` 过滤（本计划中即 `appContext(locals)` 返回的 `userEmail`）。
- Cloudflare API 只能经 `src/server/cf/client.ts` 的 `CfClient`；业务代码不得直接 fetch `api.cloudflare.com`。
- 凭证（Resend API key）用 `src/server/crypto.ts` 的 AES-GCM 加密入库；**永不日志/永不返回解密后的 key**，API 只回 `api_key_hash` 前 8 位识别位。
- API 错误：抛 `ConfigError` / `NotFoundError` / `CfApiError`，或 `jsonError(message, status, code)` 带稳定机器码；新校验失败必须给稳定 `code` 供前端本地化。
- 新用户可见字符串全部进 `src/i18n/index.ts` 的 zh 与 en 两张表；英文页面镜像在 `src/pages/en/**`。
- 移动端规则（CLAUDE.md「手机端 UI 设计规则」）：卡片内 `<table>` 必须包 `<div className="overflow-x-auto">`；次要列 `hidden sm:table-cell` 逐级隐藏；含汉字小按钮加 `whitespace-nowrap`；多输入表单行 `flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start`，输入 `w-full sm:w-48` 或 `sm:flex-1`；tab 内容全宽垂直堆叠、禁止两列网格；验收 = 500px 视口 `document.scrollingElement.scrollWidth === window.innerWidth`。
- 测试在 Node 下跑（`createTestDb()` 执行真实迁移文件）；workerd 特有行为（SDK fetch 绑定）最后用 `npm run preview` 人工验证。
- 每个任务收尾命令：`pnpm exec vitest run <file>`（单文件）；提交前 `pnpm run check`（Biome 自动修复）+ `pnpm run typecheck`。node_modules 由 pnpm 管理，统一用 `pnpm exec` / `pnpm run`。
- 提交信息用 Conventional Commits（`feat:` / `test:` / `build:`），中文正文可选，末行 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

## File Structure

```
migrations/0002_email.sql                     新建  email_domains + email_log 表
src/server/db/emailDomains.ts                 新建  发送域名配置 repo（全部 owner_email 过滤）
src/server/db/emailLog.ts                     新建  发送记录 repo（插入 / 分页列表不含 content / 单条详情）
src/server/email/types.ts                     新建  EmailFormat / EmailMessage / SendResult / ProviderSendParams / EmailValidationError
src/server/email/render.ts                    新建  renderBody(format, content) → {html?, text?}
src/server/email/providers/resend.ts          新建  sendViaResend（官方 SDK，错误归一化为 CfApiError）
src/server/email/providers/cloudflare.ts      新建  sendViaCloudflare（走 CfClient.sendEmail）
src/server/email/index.ts                     新建  sendEmail(ctx, domainId, msg) 编排
src/server/cf/client.ts                       修改  新增 sendEmail() 方法（SDK emailSending.send 包装）
src/pages/api/email/domains/index.ts          新建  GET 列表 / POST 新建
src/pages/api/email/domains/[id].ts           新建  PUT 改 provider/凭证 / DELETE
src/pages/api/email/send.ts                   新建  POST 发送
src/pages/api/email/log/index.ts              新建  GET 分页列表（不含 content）
src/pages/api/email/log/[id].ts               新建  GET 单条详情（含 content）
src/pages/api/accounts/[id]/cf-accounts.ts    新建  GET 该账号 token 可见的 CF 侧账号列表（UI 下拉用）
src/components/ui/EmailPreview.tsx            新建  sandbox iframe 预览/回看组件
src/components/EmailPanel.tsx                 新建  三 tab island（发送 / 域名 / 记录）
src/pages/email.astro                         新建  zh 页面
src/pages/en/email.astro                      新建  en 镜像页面
src/layouts/MainLayout.astro                  修改  导航加「邮件」入口
src/i18n/index.ts                             修改  email.* / nav.email 字符串（zh + en）
package.json                                  修改  依赖 + pnpm add marked resend
tests/unit/email-domains-repo.test.ts         新建  schema 语义 + domains repo
tests/unit/email-log-repo.test.ts             新建  log repo（分页/倒序/列表无 content/隔离）
tests/unit/email-render.test.ts               新建  三格式渲染与降级
tests/unit/cf-client.test.ts                  修改  追加 sendEmail 用例
tests/unit/email-providers.test.ts            新建  两个 provider 的参数组装与错误归一化
tests/unit/email-send-service.test.ts         新建  sendEmail() 编排（成败写 log、from 校验、跨用户 404）
tests/unit/email-domains-api.test.ts          新建  domains 路由（校验/409/404/凭证不回显）
tests/unit/email-send-api.test.ts             新建  send 路由（400 不写 log、403 code）
tests/unit/email-log-api.test.ts              新建  log 路由（分页、详情、隔离）
```

任务依赖：Task 1 → 2 → 3 顺序（同一迁移/表）；Task 4、5 相互独立；Task 6 依赖 4、5；Task 7 依赖 2、3、4、6；Task 8–11 依赖 7（路由层）；Task 12–14 依赖 8–11（UI）；Task 15 收尾。

---

### Task 1: 迁移 `0002_email.sql` + schema 语义测试

**Files:**
- Create: `migrations/0002_email.sql`
- Test: `tests/unit/email-domains-repo.test.ts`

**Interfaces:**
- Consumes: 现有表 `cf_accounts(id)`（FK 目标）；`tests/helpers/d1.ts` 的 `createTestDb()`（自动按文件名序执行新迁移）。
- Produces: 表 `email_domains(id, owner_email, domain, provider, api_key_ciphertext, api_key_hash, account_id, cf_account_id, created_at)` 与 `email_log(id, owner_email, domain_id, provider, from_address, recipients_json, subject, format, content, status, message_id, error, created_at)`，后续所有任务的 SQL 以此为准。

- [ ] **Step 1: 写失败的 schema 语义测试**

创建 `tests/unit/email-domains-repo.test.ts`：

```ts
import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import { deleteAccount, insertAccount } from '@/server/db/accounts';
import type { Db } from '@/server/db/types';

const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';
const TS = '2026-07-14T00:00:00.000Z';

async function seedAccount(db: Db, id = 'a1', ownerEmail = ALICE): Promise<void> {
  await insertAccount(db, {
    id,
    ownerEmail,
    name: `acct-${id}`,
    tokenEncrypted: 'enc',
    tokenHash: `hash-${id}`,
  });
}

function insertDomainRaw(db: Db, id: string, owner: string, domain: string, provider = 'resend') {
  return db
    .prepare('INSERT INTO email_domains (id, owner_email, domain, provider, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, owner, domain, provider, TS)
    .run();
}

function insertLogRaw(db: Db, id: string, owner: string, domainId: string | null) {
  return db
    .prepare(
      `INSERT INTO email_log (id, owner_email, domain_id, provider, from_address, recipients_json,
         subject, format, content, status, message_id, error, created_at)
       VALUES (?, ?, ?, 'resend', 'no-reply@mail.example.com', '{"to":["a@b.co"],"cc":[],"bcc":[]}',
         'subj', 'text', 'body', 'sent', 'mid-1', NULL, ?)`,
    )
    .bind(id, owner, domainId, TS)
    .run();
}

describe('0002_email schema semantics', () => {
  it('enforces UNIQUE(owner_email, domain) but allows the same domain for different users', async () => {
    const db = createTestDb();
    await insertDomainRaw(db, 'd1', ALICE, 'mail.example.com');
    await expect(insertDomainRaw(db, 'd2', ALICE, 'mail.example.com')).rejects.toThrow(/UNIQUE/i);
    await expect(insertDomainRaw(db, 'd3', BOB, 'mail.example.com')).resolves.toBeTruthy();
  });

  it('rejects unknown provider values via CHECK', async () => {
    const db = createTestDb();
    await expect(insertDomainRaw(db, 'd1', ALICE, 'mail.example.com', 'smtp')).rejects.toThrow(/CHECK/i);
  });

  it('deleting the cf account cascades its email domains', async () => {
    const db = createTestDb();
    await seedAccount(db, 'a1');
    await db
      .prepare(
        'INSERT INTO email_domains (id, owner_email, domain, provider, account_id, cf_account_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind('d1', ALICE, 'mail.example.com', 'cloudflare', 'a1', 'cf-tag-1', TS)
      .run();
    await deleteAccount(db, ALICE, 'a1');
    const row = await db.prepare('SELECT COUNT(*) AS cnt FROM email_domains').first<{ cnt: number }>();
    expect(row?.cnt).toBe(0);
  });

  it('deleting a domain sets email_log.domain_id to NULL and keeps the log row', async () => {
    const db = createTestDb();
    await insertDomainRaw(db, 'd1', ALICE, 'mail.example.com');
    await insertLogRaw(db, 'l1', ALICE, 'd1');
    await db.prepare('DELETE FROM email_domains WHERE id = ?').bind('d1').run();
    const log = await db
      .prepare('SELECT domain_id, from_address FROM email_log WHERE id = ?')
      .bind('l1')
      .first<{ domain_id: string | null; from_address: string }>();
    expect(log).not.toBeNull();
    expect(log?.domain_id).toBeNull();
    expect(log?.from_address).toBe('no-reply@mail.example.com');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run tests/unit/email-domains-repo.test.ts`
Expected: FAIL，错误含 `no such table: email_domains`

- [ ] **Step 3: 写迁移文件**

创建 `migrations/0002_email.sql`：

```sql
-- email_domains 发送域名配置表：域名 → provider + 凭证。
-- 按域名而非发件地址建模：Resend / CF Email Sending 的验证单位是域名，
-- 域名验证通过后任意 local 部分都可发，发送时自由填写 @ 前部分。
CREATE TABLE IF NOT EXISTS email_domains (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  domain TEXT NOT NULL,                   -- 发送域名，如 mail.example.com（小写存储）
  provider TEXT NOT NULL CHECK (provider IN ('resend', 'cloudflare')),
  api_key_ciphertext TEXT,                -- 仅 resend：AES-GCM 加密的 API key（crypto.ts，同 cf_accounts.token）
  api_key_hash TEXT,                      -- 仅 resend：SHA-256，去重与 UI 识别展示用，永不解密回显
  account_id TEXT REFERENCES cf_accounts(id) ON DELETE CASCADE,  -- 仅 cloudflare：本系统账号记录 id（复用其加密 token）
  cf_account_id TEXT,                     -- 仅 cloudflare：CF 侧账号 id（emailSending.send 的 account_id 参数）
  created_at TEXT NOT NULL,
  -- 一个域名在同一用户内只绑一个 provider（发信行为确定）；不同用户可各自配置同名域名
  UNIQUE(owner_email, domain)
);

CREATE INDEX IF NOT EXISTS idx_email_domains_owner ON email_domains(owner_email);

-- email_log 发送记录：事实/审计记录而非缓存 —— domain_id 用 SET NULL（删配置不抹历史），
-- provider / from_address 为冗余快照，配置删改后记录仍独立完整可读。
CREATE TABLE IF NOT EXISTS email_log (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  domain_id TEXT REFERENCES email_domains(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,                 -- 'resend' | 'cloudflare' 发送时快照
  from_address TEXT NOT NULL,             -- 完整发件地址快照
  recipients_json TEXT NOT NULL,          -- {to: string[], cc: string[], bcc: string[]}
  subject TEXT NOT NULL,
  format TEXT NOT NULL,                   -- 'markdown' | 'html' | 'text'
  content TEXT NOT NULL,                  -- 正文原文（回看时用同一 render.ts 重新渲染）
  status TEXT NOT NULL,                   -- 'sent' | 'failed'（失败也写记录）
  message_id TEXT,                        -- provider 消息 ID，失败为 NULL
  error TEXT,                             -- 失败原因
  created_at TEXT NOT NULL
);

-- 记录页按用户倒序分页
CREATE INDEX IF NOT EXISTS idx_email_log_owner_created ON email_log(owner_email, created_at DESC);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run tests/unit/email-domains-repo.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: 本地应用迁移 + 提交**

```bash
npm run db:migrate
git add migrations/0002_email.sql tests/unit/email-domains-repo.test.ts
git commit -m "feat: add email_domains and email_log D1 tables"
```

---
### Task 2: 发送域名 repo `src/server/db/emailDomains.ts`

**Files:**
- Create: `src/server/db/emailDomains.ts`
- Test: `tests/unit/email-domains-repo.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的 `email_domains` 表；`@/server/db/types` 的 `Db`。
- Produces（后续任务按此签名调用）:
  - `interface EmailDomainRow { id: string; owner_email: string; domain: string; provider: 'resend' | 'cloudflare'; api_key_ciphertext: string | null; api_key_hash: string | null; account_id: string | null; cf_account_id: string | null; created_at: string }`
  - `interface EmailDomainPublic { id: string; domain: string; provider: 'resend' | 'cloudflare'; apiKeyHint: string | null; accountId: string | null; cfAccountId: string | null; createdAt: string }`
  - `toPublic(r: EmailDomainRow): EmailDomainPublic`
  - `insertEmailDomain(db, input: { id; ownerEmail; domain; provider; apiKeyCiphertext; apiKeyHash; accountId; cfAccountId }): Promise<void>`（同用户同域名重复时 `throw new Error('domain already configured')`）
  - `listEmailDomains(db, ownerEmail): Promise<EmailDomainRow[]>`
  - `getEmailDomain(db, ownerEmail, id): Promise<EmailDomainRow | null>`
  - `updateEmailDomain(db, ownerEmail, id, input: { provider; apiKeyCiphertext; apiKeyHash; accountId; cfAccountId }): Promise<void>`
  - `deleteEmailDomain(db, ownerEmail, id): Promise<void>`

- [ ] **Step 1: 追加失败的 repo 测试**

在 `tests/unit/email-domains-repo.test.ts` 文件顶部追加导入：

```ts
import { encryptSecret, decryptSecret, importEncryptionKey, sha256Hex } from '@/server/crypto';
import {
  deleteEmailDomain,
  getEmailDomain,
  insertEmailDomain,
  listEmailDomains,
  toPublic,
  updateEmailDomain,
} from '@/server/db/emailDomains';
```

文件末尾追加：

```ts
describe('emailDomains repo', () => {
  const HEX_KEY = 'c'.repeat(64);

  function resendInput(id: string, domain: string, ownerEmail = ALICE) {
    return {
      id,
      ownerEmail,
      domain,
      provider: 'resend' as const,
      apiKeyCiphertext: `ct-${id}`,
      apiKeyHash: `hash-${id}`,
      accountId: null,
      cfAccountId: null,
    };
  }

  it('insert + get + list roundtrip, scoped by owner_email', async () => {
    const db = createTestDb();
    await insertEmailDomain(db, resendInput('d1', 'mail.example.com'));
    await insertEmailDomain(db, resendInput('d2', 'news.example.com', BOB));

    const aliceRows = await listEmailDomains(db, ALICE);
    expect(aliceRows.map((r) => r.id)).toEqual(['d1']);

    expect(await getEmailDomain(db, ALICE, 'd1')).toMatchObject({ domain: 'mail.example.com', provider: 'resend' });
    // 隔离：ALICE 拿不到 BOB 的配置
    expect(await getEmailDomain(db, ALICE, 'd2')).toBeNull();
  });

  it('rejects a duplicate domain for the same user with a stable error message', async () => {
    const db = createTestDb();
    await insertEmailDomain(db, resendInput('d1', 'mail.example.com'));
    await expect(insertEmailDomain(db, resendInput('d2', 'mail.example.com'))).rejects.toThrow(
      'domain already configured',
    );
  });

  it('update switches provider and swaps credential columns', async () => {
    const db = createTestDb();
    await seedAccount(db, 'a1');
    await insertEmailDomain(db, resendInput('d1', 'mail.example.com'));
    await updateEmailDomain(db, ALICE, 'd1', {
      provider: 'cloudflare',
      apiKeyCiphertext: null,
      apiKeyHash: null,
      accountId: 'a1',
      cfAccountId: 'cf-tag-1',
    });
    const row = await getEmailDomain(db, ALICE, 'd1');
    expect(row).toMatchObject({ provider: 'cloudflare', account_id: 'a1', cf_account_id: 'cf-tag-1' });
    expect(row?.api_key_ciphertext).toBeNull();
  });

  it('delete is owner-scoped: BOB cannot delete ALICE domain', async () => {
    const db = createTestDb();
    await insertEmailDomain(db, resendInput('d1', 'mail.example.com'));
    await deleteEmailDomain(db, BOB, 'd1');
    expect(await getEmailDomain(db, ALICE, 'd1')).not.toBeNull();
    await deleteEmailDomain(db, ALICE, 'd1');
    expect(await getEmailDomain(db, ALICE, 'd1')).toBeNull();
  });

  it('toPublic exposes only an 8-char hash hint, never ciphertext', async () => {
    const db = createTestDb();
    const key = await importEncryptionKey(HEX_KEY);
    const apiKey = 're_secret_123';
    await insertEmailDomain(db, {
      ...resendInput('d1', 'mail.example.com'),
      apiKeyCiphertext: await encryptSecret(apiKey, key),
      apiKeyHash: await sha256Hex(apiKey),
    });
    const row = (await getEmailDomain(db, ALICE, 'd1'))!;
    // 加密往返：密文可解回原文（发送时用）
    expect(await decryptSecret(row.api_key_ciphertext!, key)).toBe(apiKey);
    const pub = toPublic(row);
    expect(pub.apiKeyHint).toHaveLength(8);
    expect(JSON.stringify(pub)).not.toContain(row.api_key_ciphertext);
    expect(JSON.stringify(pub)).not.toContain(apiKey);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run tests/unit/email-domains-repo.test.ts`
Expected: FAIL，`Cannot find module '@/server/db/emailDomains'`（或找不到导出）

- [ ] **Step 3: 实现 repo**

创建 `src/server/db/emailDomains.ts`：

```ts
import type { Db } from './types';

export interface EmailDomainRow {
  id: string;
  owner_email: string;
  domain: string;
  provider: 'resend' | 'cloudflare';
  api_key_ciphertext: string | null;
  api_key_hash: string | null;
  account_id: string | null;
  cf_account_id: string | null;
  created_at: string;
}

export interface EmailDomainPublic {
  id: string;
  domain: string;
  provider: 'resend' | 'cloudflare';
  apiKeyHint: string | null;
  accountId: string | null;
  cfAccountId: string | null;
  createdAt: string;
}

/** 对外形状：resend 凭证只暴露 hash 前 8 位识别位，永不返回密文/明文 */
export function toPublic(r: EmailDomainRow): EmailDomainPublic {
  return {
    id: r.id,
    domain: r.domain,
    provider: r.provider,
    apiKeyHint: r.api_key_hash ? r.api_key_hash.slice(0, 8) : null,
    accountId: r.account_id,
    cfAccountId: r.cf_account_id,
    createdAt: r.created_at,
  };
}

export interface EmailDomainInput {
  id: string;
  ownerEmail: string;
  domain: string;
  provider: 'resend' | 'cloudflare';
  apiKeyCiphertext: string | null;
  apiKeyHash: string | null;
  accountId: string | null;
  cfAccountId: string | null;
}

export async function insertEmailDomain(db: Db, input: EmailDomainInput): Promise<void> {
  const existing = await db
    .prepare('SELECT id FROM email_domains WHERE owner_email = ? AND domain = ?')
    .bind(input.ownerEmail, input.domain)
    .first();
  if (existing) throw new Error('domain already configured');
  await db
    .prepare(
      `INSERT INTO email_domains (id, owner_email, domain, provider, api_key_ciphertext, api_key_hash,
         account_id, cf_account_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.ownerEmail,
      input.domain,
      input.provider,
      input.apiKeyCiphertext,
      input.apiKeyHash,
      input.accountId,
      input.cfAccountId,
      new Date().toISOString(),
    )
    .run();
}

export async function listEmailDomains(db: Db, ownerEmail: string): Promise<EmailDomainRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM email_domains WHERE owner_email = ? ORDER BY created_at')
    .bind(ownerEmail)
    .all<EmailDomainRow>();
  return results;
}

export async function getEmailDomain(db: Db, ownerEmail: string, id: string): Promise<EmailDomainRow | null> {
  return db
    .prepare('SELECT * FROM email_domains WHERE id = ? AND owner_email = ?')
    .bind(id, ownerEmail)
    .first<EmailDomainRow>();
}

export async function updateEmailDomain(
  db: Db,
  ownerEmail: string,
  id: string,
  input: {
    provider: 'resend' | 'cloudflare';
    apiKeyCiphertext: string | null;
    apiKeyHash: string | null;
    accountId: string | null;
    cfAccountId: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE email_domains SET provider = ?, api_key_ciphertext = ?, api_key_hash = ?,
         account_id = ?, cf_account_id = ?
       WHERE id = ? AND owner_email = ?`,
    )
    .bind(input.provider, input.apiKeyCiphertext, input.apiKeyHash, input.accountId, input.cfAccountId, id, ownerEmail)
    .run();
}

export async function deleteEmailDomain(db: Db, ownerEmail: string, id: string): Promise<void> {
  await db.prepare('DELETE FROM email_domains WHERE id = ? AND owner_email = ?').bind(id, ownerEmail).run();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run tests/unit/email-domains-repo.test.ts`
Expected: PASS（9 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/server/db/emailDomains.ts tests/unit/email-domains-repo.test.ts
git commit -m "feat: add email domains repository (owner-scoped)"
```

---

### Task 3: 发送记录 repo `src/server/db/emailLog.ts`

**Files:**
- Create: `src/server/db/emailLog.ts`
- Test: `tests/unit/email-log-repo.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `email_log` 表。
- Produces:
  - `interface EmailRecipients { to: string[]; cc: string[]; bcc: string[] }`
  - `interface EmailLogInput { id: string; ownerEmail: string; domainId: string | null; provider: string; fromAddress: string; recipients: EmailRecipients; subject: string; format: string; content: string; status: 'sent' | 'failed'; messageId: string | null; error: string | null }`
  - `interface EmailLogListItem { id: string; provider: string; fromAddress: string; recipients: EmailRecipients; subject: string; format: string; status: string; messageId: string | null; error: string | null; createdAt: string }`（**不含 content**）
  - `interface EmailLogDetail extends EmailLogListItem { content: string }`
  - `insertEmailLog(db, input: EmailLogInput): Promise<void>`
  - `listEmailLogs(db, ownerEmail, opts: { page: number; pageSize: number }): Promise<{ logs: EmailLogListItem[]; total: number }>`（`created_at DESC`）
  - `getEmailLog(db, ownerEmail, id): Promise<EmailLogDetail | null>`

- [ ] **Step 1: 写失败的测试**

创建 `tests/unit/email-log-repo.test.ts`：

```ts
import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import { getEmailLog, insertEmailLog, listEmailLogs } from '@/server/db/emailLog';
import type { Db } from '@/server/db/types';

const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';

function logInput(id: string, ownerEmail = ALICE, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ownerEmail,
    domainId: null,
    provider: 'resend',
    fromAddress: 'no-reply@mail.example.com',
    recipients: { to: ['a@b.co'], cc: [], bcc: [] },
    subject: `subject-${id}`,
    format: 'markdown',
    content: `# body ${id}`,
    status: 'sent' as const,
    messageId: `mid-${id}`,
    error: null,
    ...overrides,
  };
}

/** 不同用户用不同 id 前缀，避免主键冲突 */
async function seedLogs(db: Db, n: number, ownerEmail = ALICE): Promise<void> {
  const prefix = ownerEmail === ALICE ? 'l' : 'b';
  for (let i = 1; i <= n; i++) {
    await insertEmailLog(db, logInput(`${prefix}${i}`, ownerEmail));
  }
}

describe('emailLog repo', () => {
  it('lists newest first with paging, excluding content', async () => {
    const db = createTestDb();
    await seedLogs(db, 3);
    const page1 = await listEmailLogs(db, ALICE, { page: 1, pageSize: 2 });
    expect(page1.total).toBe(3);
    expect(page1.logs).toHaveLength(2);
    // 倒序：后插入的 l3 在最前（同秒插入时按 created_at 字符串稳定排序，l3 >= l1）
    expect(page1.logs[0].subject >= page1.logs[1].subject).toBe(true);
    for (const log of page1.logs) {
      expect('content' in log).toBe(false);
      expect(log.recipients.to).toEqual(['a@b.co']);
    }
    const page2 = await listEmailLogs(db, ALICE, { page: 2, pageSize: 2 });
    expect(page2.logs).toHaveLength(1);
  });

  it('detail includes content and failure fields', async () => {
    const db = createTestDb();
    await insertEmailLog(db, logInput('l1', ALICE, { status: 'failed', messageId: null, error: 'boom' }));
    const detail = await getEmailLog(db, ALICE, 'l1');
    expect(detail).toMatchObject({ content: '# body l1', status: 'failed', error: 'boom', messageId: null });
  });

  it('is owner-scoped for both list and detail', async () => {
    const db = createTestDb();
    await seedLogs(db, 2, ALICE);
    await seedLogs(db, 1, BOB);
    expect((await listEmailLogs(db, BOB, { page: 1, pageSize: 10 })).total).toBe(1);
    expect(await getEmailLog(db, BOB, 'l1')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run tests/unit/email-log-repo.test.ts`
Expected: FAIL，`Cannot find module '@/server/db/emailLog'`

- [ ] **Step 3: 实现 repo**

创建 `src/server/db/emailLog.ts`：

```ts
import type { Db } from './types';

export interface EmailRecipients {
  to: string[];
  cc: string[];
  bcc: string[];
}

export interface EmailLogInput {
  id: string;
  ownerEmail: string;
  domainId: string | null;
  provider: string;
  fromAddress: string;
  recipients: EmailRecipients;
  subject: string;
  format: string;
  content: string;
  status: 'sent' | 'failed';
  messageId: string | null;
  error: string | null;
}

export interface EmailLogListItem {
  id: string;
  provider: string;
  fromAddress: string;
  recipients: EmailRecipients;
  subject: string;
  format: string;
  status: string;
  messageId: string | null;
  error: string | null;
  createdAt: string;
}

export interface EmailLogDetail extends EmailLogListItem {
  content: string;
}

interface LogRow {
  id: string;
  provider: string;
  from_address: string;
  recipients_json: string;
  subject: string;
  format: string;
  status: string;
  message_id: string | null;
  error: string | null;
  created_at: string;
}

function parseRecipients(json: string): EmailRecipients {
  try {
    const r = JSON.parse(json) as Partial<EmailRecipients>;
    return { to: r.to ?? [], cc: r.cc ?? [], bcc: r.bcc ?? [] };
  } catch {
    return { to: [], cc: [], bcc: [] };
  }
}

function toItem(r: LogRow): EmailLogListItem {
  return {
    id: r.id,
    provider: r.provider,
    fromAddress: r.from_address,
    recipients: parseRecipients(r.recipients_json),
    subject: r.subject,
    format: r.format,
    status: r.status,
    messageId: r.message_id,
    error: r.error,
    createdAt: r.created_at,
  };
}

export async function insertEmailLog(db: Db, input: EmailLogInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO email_log (id, owner_email, domain_id, provider, from_address, recipients_json,
         subject, format, content, status, message_id, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.ownerEmail,
      input.domainId,
      input.provider,
      input.fromAddress,
      JSON.stringify(input.recipients),
      input.subject,
      input.format,
      input.content,
      input.status,
      input.messageId,
      input.error,
      new Date().toISOString(),
    )
    .run();
}

/** 列表不含 content：正文可能很大，回看单条时再取 */
export async function listEmailLogs(
  db: Db,
  ownerEmail: string,
  opts: { page: number; pageSize: number },
): Promise<{ logs: EmailLogListItem[]; total: number }> {
  const countRow = await db
    .prepare('SELECT COUNT(*) AS cnt FROM email_log WHERE owner_email = ?')
    .bind(ownerEmail)
    .first<{ cnt: number }>();
  const { results } = await db
    .prepare(
      `SELECT id, provider, from_address, recipients_json, subject, format, status, message_id, error, created_at
       FROM email_log WHERE owner_email = ?
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .bind(ownerEmail, opts.pageSize, (opts.page - 1) * opts.pageSize)
    .all<LogRow>();
  return { logs: results.map(toItem), total: countRow?.cnt ?? 0 };
}

export async function getEmailLog(db: Db, ownerEmail: string, id: string): Promise<EmailLogDetail | null> {
  const row = await db
    .prepare('SELECT * FROM email_log WHERE id = ? AND owner_email = ?')
    .bind(id, ownerEmail)
    .first<LogRow & { content: string }>();
  if (!row) return null;
  return { ...toItem(row), content: row.content };
}
```

（`ORDER BY created_at DESC, id DESC`：同毫秒插入的行以 id 兜底稳定排序。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run tests/unit/email-log-repo.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/server/db/emailLog.ts tests/unit/email-log-repo.test.ts
git commit -m "feat: add email send log repository"
```

---
### Task 4: email 类型 + 渲染 `src/server/email/{types,render}.ts`（引入 `marked`）

**Files:**
- Create: `src/server/email/types.ts`
- Create: `src/server/email/render.ts`
- Modify: `package.json`（`pnpm add marked`）
- Test: `tests/unit/email-render.test.ts`

**Interfaces:**
- Produces:
  - `type EmailFormat = 'markdown' | 'html' | 'text'`
  - `interface EmailMessage { from: string; fromName?: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string; format: EmailFormat; content: string }`
  - `interface SendResult { logId: string; status: 'sent' | 'failed'; messageId: string | null; error: string | null }`
  - `interface ProviderSendParams { from: string; fromName?: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string; html?: string; text?: string }`
  - `interface ProviderSendOk { messageId: string | null }`
  - `class EmailValidationError extends Error { code: string }`
  - `renderBody(format: EmailFormat, content: string): { html?: string; text?: string }`

- [ ] **Step 1: 安装 marked**

```bash
pnpm add marked
```

Expected: `package.json` dependencies 新增 `"marked": "^…"`；无 build script 警告（marked 纯 JS）。

- [ ] **Step 2: 写失败的渲染测试**

创建 `tests/unit/email-render.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { renderBody } from '@/server/email/render';

describe('renderBody', () => {
  it('markdown renders html and keeps raw markdown as the text fallback', () => {
    const src = '# Hi\n\n- a\n- b';
    const r = renderBody('markdown', src);
    expect(r.html).toContain('<h1');
    expect(r.html).toContain('<li>a</li>');
    expect(r.text).toBe(src);
  });

  it('markdown supports GFM tables', () => {
    const r = renderBody('markdown', '| a | b |\n| - | - |\n| 1 | 2 |');
    expect(r.html).toContain('<table>');
    expect(r.html).toContain('<td>1</td>');
  });

  it('html passes through unchanged with no text part', () => {
    const r = renderBody('html', '<p>hi</p>');
    expect(r.html).toBe('<p>hi</p>');
    expect(r.text).toBeUndefined();
  });

  it('text passes through unchanged with no html part', () => {
    const r = renderBody('text', 'plain body');
    expect(r.text).toBe('plain body');
    expect(r.html).toBeUndefined();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm exec vitest run tests/unit/email-render.test.ts`
Expected: FAIL，`Cannot find module '@/server/email/render'`

- [ ] **Step 4: 实现 types.ts 与 render.ts**

创建 `src/server/email/types.ts`：

```ts
export type EmailFormat = 'markdown' | 'html' | 'text';

export interface EmailMessage {
  from: string; // 完整发件地址 local@domain
  fromName?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  format: EmailFormat;
  content: string;
}

export interface SendResult {
  logId: string;
  status: 'sent' | 'failed';
  messageId: string | null;
  error: string | null;
}

/** provider 无关的发送参数：正文已由 renderBody 展开为 html/text */
export interface ProviderSendParams {
  from: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string;
  text?: string;
}

export interface ProviderSendOk {
  messageId: string | null;
}

/** 发送前校验失败（from 域名不符 / 渲染异常）：路由映射 400，不调 provider、不写 log */
export class EmailValidationError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'EmailValidationError';
  }
}
```

创建 `src/server/email/render.ts`：

```ts
import { marked } from 'marked';
import type { EmailFormat } from './types';

/**
 * 三格式 → 邮件正文。markdown 的纯文本副本即原文（markdown 本身可读，零成本降级）；
 * html / text 原样透传不做转换。marked 不 sanitize：发出的邮件由收件方客户端处理；
 * 本项目 UI 内的预览/回看一律走 sandbox iframe（EmailPreview），不直接注入 DOM。
 */
export function renderBody(format: EmailFormat, content: string): { html?: string; text?: string } {
  switch (format) {
    case 'markdown':
      // async: false 保证同步返回 string（marked 默认开启 GFM）
      return { html: marked.parse(content, { async: false }), text: content };
    case 'html':
      return { html: content };
    case 'text':
      return { text: content };
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm exec vitest run tests/unit/email-render.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 6: 提交**

```bash
git add package.json pnpm-lock.yaml src/server/email/types.ts src/server/email/render.ts tests/unit/email-render.test.ts
git commit -m "feat: add email body renderer (markdown/html/text with fallback)"
```

---

### Task 5: CfClient 新增 `sendEmail()`

**Files:**
- Modify: `src/server/cf/client.ts`（在 `purgePagesBuildCache` 方法之后追加）
- Test: `tests/unit/cf-client.test.ts`（文件末尾追加用例）

**Interfaces:**
- Consumes: SDK `this.sdk.emailSending.send()`（POST `/accounts/:id/email/sending/send`，cloudflare@6.5.0 已含）；类内已有 `wrap()` 错误归一化。
- Produces: `CfClient.sendEmail(cfAccountId: string, params: { from: string | { address: string; name: string }; to: string[]; cc?: string[]; bcc?: string[]; subject: string; html?: string; text?: string }): Promise<{ messageId: string }>`。错误按现有约定抛 `CfApiError`（token 缺 Email Sending 权限 → status 403，由路由映射「仅该动作 403」）。

- [ ] **Step 1: 追加失败的测试**

在 `tests/unit/cf-client.test.ts` 最外层 `describe('CfClient (official SDK adapter)')` 内追加：

```ts
it('sendEmail posts to /email/sending/send and returns message_id', async () => {
  let seenUrl = '';
  let seenBody: Record<string, unknown> = {};
  const fetchImpl: typeof fetch = async (input, init) => {
    seenUrl = String(input);
    seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({
      success: true,
      errors: [],
      messages: [],
      result: { message_id: 'mid-1', delivered: ['to@x.co'], permanent_bounces: [], queued: [] },
    });
  };
  const r = await new CfClient('tok', fetchImpl).sendEmail('cf-acct-1', {
    from: { address: 'no-reply@mail.example.com', name: 'Ops' },
    to: ['to@x.co'],
    subject: 'Hello',
    html: '<p>hi</p>',
    text: 'hi',
  });
  expect(r.messageId).toBe('mid-1');
  expect(seenUrl).toContain('/accounts/cf-acct-1/email/sending/send');
  expect(seenBody.subject).toBe('Hello');
  expect(seenBody.html).toBe('<p>hi</p>');
  expect(seenBody.text).toBe('hi');
  expect(seenBody.from).toEqual({ address: 'no-reply@mail.example.com', name: 'Ops' });
  expect('cc' in seenBody).toBe(false);
});

it('sendEmail maps a 403 (missing Email Sending scope) to CfApiError', async () => {
  const fetchImpl: typeof fetch = async () =>
    jsonResponse(
      { success: false, errors: [{ code: 10000, message: 'Authentication error' }], messages: [], result: null },
      403,
    );
  const client = new CfClient('tok', fetchImpl);
  await expect(client.sendEmail('cf-1', { from: 'a@b.co', to: ['c@d.co'], subject: 's', text: 'x' })).rejects.toThrow(
    CfApiError,
  );
  await expect(
    client.sendEmail('cf-1', { from: 'a@b.co', to: ['c@d.co'], subject: 's', text: 'x' }),
  ).rejects.toMatchObject({ status: 403 });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run tests/unit/cf-client.test.ts`
Expected: FAIL，`sendEmail is not a function`（既有用例保持 PASS）

- [ ] **Step 3: 实现方法**

在 `src/server/cf/client.ts` 的 `purgePagesBuildCache` 方法之后追加：

```ts
  /**
   * Email Sending 发信（POST /accounts/:id/email/sending/send，SDK emailSending.send）。
   * cc/bcc/html/text 仅在有值时带上（端点要求 html/text 至少一个非空，由服务层 renderBody 保证）。
   * token 缺 Email Sending 权限 → CfApiError 403，由路由映射为仅该动作 403，不影响只读视图。
   */
  sendEmail(
    cfAccountId: string,
    params: {
      from: string | { address: string; name: string };
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      html?: string;
      text?: string;
    },
  ): Promise<{ messageId: string }> {
    return this.wrap(async () => {
      const r = await this.sdk.emailSending.send({
        account_id: cfAccountId,
        from: params.from,
        to: params.to,
        subject: params.subject,
        ...(params.cc?.length ? { cc: params.cc } : {}),
        ...(params.bcc?.length ? { bcc: params.bcc } : {}),
        ...(params.html ? { html: params.html } : {}),
        ...(params.text ? { text: params.text } : {}),
      });
      return { messageId: r.message_id };
    });
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run tests/unit/cf-client.test.ts`
Expected: PASS（全部用例，含新增 2 个）

- [ ] **Step 5: 提交**

```bash
git add src/server/cf/client.ts tests/unit/cf-client.test.ts
git commit -m "feat: add CfClient.sendEmail wrapping the Email Sending API"
```

---

### Task 6: 两个 provider 适配器（引入 `resend`）

**Files:**
- Create: `src/server/email/providers/resend.ts`
- Create: `src/server/email/providers/cloudflare.ts`
- Modify: `package.json`（`pnpm add resend`）
- Test: `tests/unit/email-providers.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `ProviderSendParams` / `ProviderSendOk`；Task 5 的 `CfClient.sendEmail`；`CfApiError`。
- Produces:
  - `interface ResendClient { emails: { send(payload: Record<string, unknown>): Promise<{ data: { id: string } | null; error: { name: string; message: string } | null }> } }`
  - `sendViaResend(apiKey: string, params: ProviderSendParams, makeClient?: (apiKey: string) => ResendClient): Promise<ProviderSendOk>`
  - `sendViaCloudflare(client: Pick<CfClient, 'sendEmail'>, cfAccountId: string, params: ProviderSendParams): Promise<ProviderSendOk>`

- [ ] **Step 1: 安装 resend**

```bash
pnpm add resend
```

Expected: `package.json` dependencies 新增 `"resend": "^…"`。

- [ ] **Step 2: 写失败的测试**

创建 `tests/unit/email-providers.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { CfApiError } from '@/server/cf/client';
import { sendViaCloudflare } from '@/server/email/providers/cloudflare';
import { sendViaResend } from '@/server/email/providers/resend';
import type { ProviderSendParams } from '@/server/email/types';

const PARAMS: ProviderSendParams = {
  from: 'no-reply@mail.example.com',
  fromName: 'Ops',
  to: ['a@b.co'],
  cc: ['c@d.co'],
  subject: 'Hi',
  html: '<p>hi</p>',
  text: 'hi',
};

describe('sendViaResend', () => {
  it('assembles the payload (display-name from, omits empty bcc) and returns the message id', async () => {
    let seen: Record<string, unknown> = {};
    const r = await sendViaResend('key-1', PARAMS, () => ({
      emails: {
        async send(payload) {
          seen = payload;
          return { data: { id: 'rid-1' }, error: null };
        },
      },
    }));
    expect(r.messageId).toBe('rid-1');
    expect(seen.from).toBe('Ops <no-reply@mail.example.com>');
    expect(seen.to).toEqual(['a@b.co']);
    expect(seen.cc).toEqual(['c@d.co']);
    expect('bcc' in seen).toBe(false);
    expect(seen.html).toBe('<p>hi</p>');
    expect(seen.text).toBe('hi');
  });

  it('uses the bare address when no display name is given', async () => {
    let seen: Record<string, unknown> = {};
    await sendViaResend('key-1', { ...PARAMS, fromName: undefined }, () => ({
      emails: {
        async send(payload) {
          seen = payload;
          return { data: { id: 'rid-2' }, error: null };
        },
      },
    }));
    expect(seen.from).toBe('no-reply@mail.example.com');
  });

  it('normalizes {data:null, error} into CfApiError with a mapped status', async () => {
    const call = sendViaResend('bad-key', PARAMS, () => ({
      emails: {
        async send() {
          return { data: null, error: { name: 'invalid_api_key', message: 'API key is invalid' } };
        },
      },
    }));
    await expect(call).rejects.toThrow(CfApiError);
    await expect(
      sendViaResend('bad-key', PARAMS, () => ({
        emails: {
          async send() {
            return { data: null, error: { name: 'invalid_api_key', message: 'API key is invalid' } };
          },
        },
      })),
    ).rejects.toMatchObject({ status: 403, messages: ['API key is invalid'] });
  });

  it('defaults unknown resend error names to 502', async () => {
    await expect(
      sendViaResend('k', PARAMS, () => ({
        emails: {
          async send() {
            return { data: null, error: { name: 'something_new', message: 'boom' } };
          },
        },
      })),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe('sendViaCloudflare', () => {
  it('passes an address object when fromName is set and returns the message id', async () => {
    let seenAccount = '';
    let seenParams: Record<string, unknown> = {};
    const client = {
      async sendEmail(accountId: string, params: Record<string, unknown>) {
        seenAccount = accountId;
        seenParams = params;
        return { messageId: 'mid-9' };
      },
    };
    const r = await sendViaCloudflare(client, 'cf-tag-1', PARAMS);
    expect(r.messageId).toBe('mid-9');
    expect(seenAccount).toBe('cf-tag-1');
    expect(seenParams.from).toEqual({ address: 'no-reply@mail.example.com', name: 'Ops' });
    expect(seenParams.to).toEqual(['a@b.co']);
  });

  it('passes a plain string from when no display name is given', async () => {
    let seenParams: Record<string, unknown> = {};
    const client = {
      async sendEmail(_accountId: string, params: Record<string, unknown>) {
        seenParams = params;
        return { messageId: 'mid-10' };
      },
    };
    await sendViaCloudflare(client, 'cf-tag-1', { ...PARAMS, fromName: undefined });
    expect(seenParams.from).toBe('no-reply@mail.example.com');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm exec vitest run tests/unit/email-providers.test.ts`
Expected: FAIL，找不到 `@/server/email/providers/*` 模块

- [ ] **Step 4: 实现两个 provider**

创建 `src/server/email/providers/resend.ts`：

```ts
import { Resend } from 'resend';
import { CfApiError } from '@/server/cf/client';
import type { ProviderSendOk, ProviderSendParams } from '@/server/email/types';

/** Resend 官方错误名 → HTTP 状态（对齐 resend.com/docs/api-reference/errors），未知名归 502（上游错误） */
const RESEND_ERROR_STATUS: Record<string, number> = {
  validation_error: 400,
  missing_required_field: 422,
  invalid_from_address: 422,
  invalid_attachment: 422,
  missing_api_key: 401,
  restricted_api_key: 401,
  invalid_api_key: 403,
  not_found: 404,
  rate_limit_exceeded: 429,
  daily_quota_exceeded: 429,
};

/** resend SDK 的最小结构面：便于测试注入替身（真实 Resend 实例结构兼容） */
export interface ResendClient {
  emails: {
    send(payload: Record<string, unknown>): Promise<{
      data: { id: string } | null;
      error: { name: string; message: string } | null;
    }>;
  };
}

export async function sendViaResend(
  apiKey: string,
  params: ProviderSendParams,
  makeClient: (apiKey: string) => ResendClient = (k) => new Resend(k) as unknown as ResendClient,
): Promise<ProviderSendOk> {
  const { data, error } = await makeClient(apiKey).emails.send({
    from: params.fromName ? `${params.fromName} <${params.from}>` : params.from,
    to: params.to,
    subject: params.subject,
    ...(params.cc?.length ? { cc: params.cc } : {}),
    ...(params.bcc?.length ? { bcc: params.bcc } : {}),
    ...(params.html ? { html: params.html } : {}),
    ...(params.text ? { text: params.text } : {}),
  });
  // resend SDK 不抛错而是返回 {data, error}：归一化为 CfApiError，与 CF 侧错误同走 handleCfError 映射
  if (error) throw new CfApiError(RESEND_ERROR_STATUS[error.name] ?? 502, [error.message]);
  return { messageId: data?.id ?? null };
}
```

创建 `src/server/email/providers/cloudflare.ts`：

```ts
import type { CfClient } from '@/server/cf/client';
import type { ProviderSendOk, ProviderSendParams } from '@/server/email/types';

/** 不直接 fetch：Cloudflare API 只经 CfClient（sendEmail 方法），维持项目边界约定 */
export async function sendViaCloudflare(
  client: Pick<CfClient, 'sendEmail'>,
  cfAccountId: string,
  params: ProviderSendParams,
): Promise<ProviderSendOk> {
  const r = await client.sendEmail(cfAccountId, {
    from: params.fromName ? { address: params.from, name: params.fromName } : params.from,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject,
    html: params.html,
    text: params.text,
  });
  return { messageId: r.messageId ?? null };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm exec vitest run tests/unit/email-providers.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 6: 提交**

```bash
git add package.json pnpm-lock.yaml src/server/email/providers tests/unit/email-providers.test.ts
git commit -m "feat: add resend and cloudflare email provider adapters"
```

---
### Task 7: 发送编排服务 `src/server/email/index.ts`

**Files:**
- Create: `src/server/email/index.ts`
- Test: `tests/unit/email-send-service.test.ts`

**Interfaces:**
- Consumes: Task 2 `getEmailDomain`；Task 3 `insertEmailLog`；Task 4 `renderBody` / `EmailMessage` / `SendResult` / `EmailValidationError`；Task 6 两个 provider；`@/server/db/accounts` 的 `getAccount`；`@/server/crypto` 的 `decryptSecret`；`@/server/context` 的 `NotFoundError`。
- Produces:
  - `interface SendDeps { makeCfClient?: (token: string) => Pick<CfClient, 'sendEmail'>; resend?: typeof sendViaResend }`（测试注入口，风格同 `syncAllZones` 的 `makeClient` 参数）
  - `sendEmail(ctx: { db: Db; key: CryptoKey; userEmail: string }, domainId: string, msg: EmailMessage, deps?: SendDeps): Promise<SendResult>`
  - 行为契约：域名配置查不到（含跨用户）→ 抛 `NotFoundError`；from 域名 ≠ 配置域名 → 抛 `EmailValidationError('…', 'fromDomainMismatch')`；渲染抛错 → `EmailValidationError('…', 'renderFailed')`（以上均**不写 log**）；provider 成功 → 写 `status='sent'` log 并返回 `SendResult`；provider 抛错 → 写 `status='failed'` log（含 error 文本）后**原样重抛**（路由层映射 HTTP 状态）。

- [ ] **Step 1: 写失败的测试**

创建 `tests/unit/email-send-service.test.ts`：

```ts
import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import { CfApiError } from '@/server/cf/client';
import { NotFoundError } from '@/server/context';
import { encryptSecret, importEncryptionKey, sha256Hex } from '@/server/crypto';
import { insertAccount } from '@/server/db/accounts';
import { insertEmailDomain } from '@/server/db/emailDomains';
import type { Db } from '@/server/db/types';
import { sendEmail } from '@/server/email';
import { EmailValidationError, type EmailMessage } from '@/server/email/types';

const HEX_KEY = 'd'.repeat(64);
const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';

async function setup(): Promise<{ db: Db; key: CryptoKey }> {
  const db = createTestDb();
  const key = await importEncryptionKey(HEX_KEY);
  await insertAccount(db, {
    id: 'a1',
    ownerEmail: ALICE,
    name: 'acct',
    tokenEncrypted: await encryptSecret('cf-token-1', key),
    tokenHash: await sha256Hex('cf-token-1'),
  });
  await insertEmailDomain(db, {
    id: 'dom-resend',
    ownerEmail: ALICE,
    domain: 'mail.example.com',
    provider: 'resend',
    apiKeyCiphertext: await encryptSecret('re_key_1', key),
    apiKeyHash: await sha256Hex('re_key_1'),
    accountId: null,
    cfAccountId: null,
  });
  await insertEmailDomain(db, {
    id: 'dom-cf',
    ownerEmail: ALICE,
    domain: 'cf.example.com',
    provider: 'cloudflare',
    apiKeyCiphertext: null,
    apiKeyHash: null,
    accountId: 'a1',
    cfAccountId: 'cf-tag-1',
  });
  return { db, key };
}

function msg(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    from: 'no-reply@mail.example.com',
    to: ['a@b.co'],
    subject: 'Hi',
    format: 'markdown',
    content: '# hello',
    ...overrides,
  };
}

async function countLogs(db: Db): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS cnt FROM email_log').first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

describe('sendEmail service', () => {
  it('resend path: decrypts the key, renders markdown with text fallback, logs sent', async () => {
    const { db, key } = await setup();
    let seenKey = '';
    let seenParams: Record<string, unknown> = {};
    const result = await sendEmail({ db, key, userEmail: ALICE }, 'dom-resend', msg(), {
      resend: async (apiKey, params) => {
        seenKey = apiKey;
        seenParams = params as unknown as Record<string, unknown>;
        return { messageId: 'rid-1' };
      },
    });
    expect(seenKey).toBe('re_key_1');
    expect(seenParams.html).toContain('<h1');
    expect(seenParams.text).toBe('# hello');
    expect(result).toMatchObject({ status: 'sent', messageId: 'rid-1', error: null });
    const log = await db
      .prepare('SELECT status, message_id, provider, content FROM email_log WHERE id = ?')
      .bind(result.logId)
      .first<{ status: string; message_id: string; provider: string; content: string }>();
    expect(log).toMatchObject({ status: 'sent', message_id: 'rid-1', provider: 'resend', content: '# hello' });
  });

  it("cloudflare path: decrypts the account token and sends via the domain's cf_account_id", async () => {
    const { db, key } = await setup();
    let seenToken = '';
    let seenCfAccount = '';
    const result = await sendEmail(
      { db, key, userEmail: ALICE },
      'dom-cf',
      msg({ from: 'ops@cf.example.com' }),
      {
        makeCfClient: (token) => ({
          async sendEmail(cfAccountId) {
            seenToken = token;
            seenCfAccount = cfAccountId;
            return { messageId: 'mid-1' };
          },
        }),
      },
    );
    expect(seenToken).toBe('cf-token-1');
    expect(seenCfAccount).toBe('cf-tag-1');
    expect(result.status).toBe('sent');
  });

  it('rejects a cross-user domainId with NotFoundError and writes no log', async () => {
    const { db, key } = await setup();
    await expect(sendEmail({ db, key, userEmail: BOB }, 'dom-resend', msg())).rejects.toThrow(NotFoundError);
    expect(await countLogs(db)).toBe(0);
  });

  it('rejects a from address on a different domain (400, no provider call, no log)', async () => {
    const { db, key } = await setup();
    let called = false;
    const call = sendEmail({ db, key, userEmail: ALICE }, 'dom-resend', msg({ from: 'x@other.com' }), {
      resend: async () => {
        called = true;
        return { messageId: 'nope' };
      },
    });
    await expect(call).rejects.toThrow(EmailValidationError);
    await expect(
      sendEmail({ db, key, userEmail: ALICE }, 'dom-resend', msg({ from: 'x@other.com' })),
    ).rejects.toMatchObject({ code: 'fromDomainMismatch' });
    expect(called).toBe(false);
    expect(await countLogs(db)).toBe(0);
  });

  it('matches the from domain case-insensitively', async () => {
    const { db, key } = await setup();
    const result = await sendEmail({ db, key, userEmail: ALICE }, 'dom-resend', msg({ from: 'Ops@MAIL.Example.COM' }), {
      resend: async () => ({ messageId: 'rid-2' }),
    });
    expect(result.status).toBe('sent');
  });

  it('logs a failed attempt and rethrows when the provider errors', async () => {
    const { db, key } = await setup();
    const boom = new CfApiError(403, ['missing Email Sending scope']);
    const call = sendEmail({ db, key, userEmail: ALICE }, 'dom-resend', msg(), {
      resend: async () => {
        throw boom;
      },
    });
    await expect(call).rejects.toBe(boom);
    const log = await db
      .prepare('SELECT status, error, message_id FROM email_log WHERE owner_email = ?')
      .bind(ALICE)
      .first<{ status: string; error: string; message_id: string | null }>();
    expect(log).toMatchObject({ status: 'failed', message_id: null });
    expect(log?.error).toContain('missing Email Sending scope');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run tests/unit/email-send-service.test.ts`
Expected: FAIL，`Cannot find module '@/server/email'`（目录 index 不存在）

- [ ] **Step 3: 实现服务**

创建 `src/server/email/index.ts`：

```ts
import { CfClient } from '@/server/cf/client';
import { NotFoundError } from '@/server/context';
import { decryptSecret } from '@/server/crypto';
import { getAccount } from '@/server/db/accounts';
import { getEmailDomain } from '@/server/db/emailDomains';
import { insertEmailLog } from '@/server/db/emailLog';
import type { Db } from '@/server/db/types';
import { sendViaCloudflare } from './providers/cloudflare';
import { sendViaResend } from './providers/resend';
import { renderBody } from './render';
import { EmailValidationError, type EmailMessage, type SendResult } from './types';

/** 测试注入口：风格同 syncAllZones 的 makeClient 参数 */
export interface SendDeps {
  makeCfClient?: (token: string) => Pick<CfClient, 'sendEmail'>;
  resend?: typeof sendViaResend;
}

export async function sendEmail(
  ctx: { db: Db; key: CryptoKey; userEmail: string },
  domainId: string,
  msg: EmailMessage,
  deps: SendDeps = {},
): Promise<SendResult> {
  const row = await getEmailDomain(ctx.db, ctx.userEmail, domainId);
  if (!row) throw new NotFoundError('sending domain not found');

  // from 的域名部分必须等于配置域名：防止借该配置的凭证用未验证域名发信
  const fromDomain = msg.from.split('@')[1]?.toLowerCase();
  if (fromDomain !== row.domain.toLowerCase()) {
    throw new EmailValidationError('from address does not match the configured domain', 'fromDomainMismatch');
  }

  // 渲染异常按 400 校验错误处理：不调 provider、不写 log
  let body: { html?: string; text?: string };
  try {
    body = renderBody(msg.format, msg.content);
  } catch (e) {
    throw new EmailValidationError(e instanceof Error ? e.message : 'failed to render body', 'renderFailed');
  }

  const params = {
    from: msg.from,
    fromName: msg.fromName,
    to: msg.to,
    cc: msg.cc,
    bcc: msg.bcc,
    subject: msg.subject,
    html: body.html,
    text: body.text,
  };

  const logId = crypto.randomUUID();
  const writeLog = (status: 'sent' | 'failed', messageId: string | null, error: string | null) =>
    insertEmailLog(ctx.db, {
      id: logId,
      ownerEmail: ctx.userEmail,
      domainId: row.id,
      provider: row.provider,
      fromAddress: msg.from,
      recipients: { to: msg.to, cc: msg.cc ?? [], bcc: msg.bcc ?? [] },
      subject: msg.subject,
      format: msg.format,
      content: msg.content,
      status,
      messageId,
      error,
    });

  try {
    let messageId: string | null;
    if (row.provider === 'resend') {
      const apiKey = await decryptSecret(row.api_key_ciphertext!, ctx.key);
      ({ messageId } = await (deps.resend ?? sendViaResend)(apiKey, params));
    } else {
      const account = await getAccount(ctx.db, ctx.userEmail, row.account_id!);
      if (!account) throw new NotFoundError('cloudflare account for this domain not found');
      const token = await decryptSecret(account.token_encrypted, ctx.key);
      const client = (deps.makeCfClient ?? ((t: string) => new CfClient(t)))(token);
      ({ messageId } = await sendViaCloudflare(client, row.cf_account_id!, params));
    }
    await writeLog('sent', messageId, null);
    return { logId, status: 'sent', messageId, error: null };
  } catch (e) {
    // 失败也写记录（审计完整），再向上重抛给路由映射 HTTP 状态
    await writeLog('failed', null, e instanceof Error ? e.message : String(e));
    throw e;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run tests/unit/email-send-service.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/server/email/index.ts tests/unit/email-send-service.test.ts
git commit -m "feat: add sendEmail orchestration (validate, render, dispatch, log)"
```

---
### Task 8: 域名管理 API `/api/email/domains`

**Files:**
- Create: `src/pages/api/email/domains/index.ts`
- Create: `src/pages/api/email/domains/[id].ts`
- Test: `tests/unit/email-domains-api.test.ts`

**Interfaces:**
- Consumes: `appContext` / `jsonError`；Task 2 repo；`@/server/crypto`；`@/server/db/accounts` 的 `getAccount`。
- Produces（前端按此调用）:
  - `GET /api/email/domains` → `{ domains: EmailDomainPublic[] }`
  - `POST /api/email/domains` body `{ domain, provider: 'resend'|'cloudflare', apiKey?, accountId?, cfAccountId? }` → 201 `{ domain: { id, domain, provider } }`；错误 code：`invalidDomain`(400)、`fieldsRequired`(400)、`accountNotFound`(404)、`duplicateDomain`(409)
  - `PUT /api/email/domains/[id]` body 同 POST 去掉 domain → `{ ok: true }`；resend 且 apiKey 留空且原 provider 也是 resend 时保留旧 key；错误 code：`domainNotFound`(404) 等同上
  - `DELETE /api/email/domains/[id]` → 204

- [ ] **Step 1: 写失败的测试**

创建 `tests/unit/email-domains-api.test.ts`：

```ts
import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import { DELETE, PUT } from '@/pages/api/email/domains/[id]';
import { GET, POST } from '@/pages/api/email/domains/index';
import { insertAccount } from '@/server/db/accounts';
import { getEmailDomain } from '@/server/db/emailDomains';
import type { Db } from '@/server/db/types';

const HEX_KEY = 'e'.repeat(64);
const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';

function ctx(db: unknown, opts: { method?: string; body?: unknown; userEmail?: string; id?: string } = {}) {
  return {
    locals: { userEmail: opts.userEmail ?? ALICE, runtime: { env: { DB: db, ENCRYPTION_KEY: HEX_KEY } } },
    request: new Request('http://localhost/api/email/domains', {
      method: opts.method ?? 'GET',
      ...(opts.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) } : {}),
    }),
    params: opts.id ? { id: opts.id } : {},
  } as unknown as Parameters<typeof POST>[0];
}

async function createResendDomain(db: Db, domain = 'mail.example.com'): Promise<string> {
  const res = await POST(ctx(db, { method: 'POST', body: { domain, provider: 'resend', apiKey: 're_key_1' } }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { domain: { id: string } };
  return body.domain.id;
}

describe('email domains API', () => {
  it('POST validates domain format', async () => {
    const db = createTestDb();
    const res = await POST(ctx(db, { method: 'POST', body: { domain: 'not a domain', provider: 'resend', apiKey: 'k' } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalidDomain');
  });

  it('POST requires provider-specific credentials', async () => {
    const db = createTestDb();
    const noKey = await POST(ctx(db, { method: 'POST', body: { domain: 'mail.example.com', provider: 'resend' } }));
    expect(noKey.status).toBe(400);
    const noAcct = await POST(
      ctx(db, { method: 'POST', body: { domain: 'mail.example.com', provider: 'cloudflare' } }),
    );
    expect(noAcct.status).toBe(400);
  });

  it('POST rejects a cloudflare accountId owned by another user with 404', async () => {
    const db = createTestDb();
    await insertAccount(db, { id: 'a1', ownerEmail: BOB, name: 'bob', tokenEncrypted: 'x', tokenHash: 'h1' });
    const res = await POST(
      ctx(db, {
        method: 'POST',
        body: { domain: 'mail.example.com', provider: 'cloudflare', accountId: 'a1', cfAccountId: 'cf-1' },
      }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('accountNotFound');
  });

  it('POST stores the resend key encrypted and GET never returns it', async () => {
    const db = createTestDb();
    const id = await createResendDomain(db);
    const row = (await getEmailDomain(db, ALICE, id))!;
    expect(row.api_key_ciphertext).not.toContain('re_key_1');
    const res = await GET(ctx(db));
    const text = await res.text();
    expect(text).not.toContain('re_key_1');
    expect(text).not.toContain(row.api_key_ciphertext);
    expect(text).toContain('"apiKeyHint"');
  });

  it('POST returns 409 duplicateDomain for the same user, 201 for another user', async () => {
    const db = createTestDb();
    await createResendDomain(db);
    const dup = await POST(
      ctx(db, { method: 'POST', body: { domain: 'MAIL.example.com', provider: 'resend', apiKey: 'k2' } }),
    );
    expect(dup.status).toBe(409);
    const other = await POST(
      ctx(db, {
        method: 'POST',
        body: { domain: 'mail.example.com', provider: 'resend', apiKey: 'k2' },
        userEmail: BOB,
      }),
    );
    expect(other.status).toBe(201);
  });

  it('PUT keeps the old resend key when apiKey is blank, replaces it when provided', async () => {
    const db = createTestDb();
    const id = await createResendDomain(db);
    const before = (await getEmailDomain(db, ALICE, id))!;
    const keep = await PUT(ctx(db, { method: 'PUT', id, body: { provider: 'resend' } }));
    expect(keep.status).toBe(200);
    expect((await getEmailDomain(db, ALICE, id))!.api_key_hash).toBe(before.api_key_hash);
    const swap = await PUT(ctx(db, { method: 'PUT', id, body: { provider: 'resend', apiKey: 're_key_2' } }));
    expect(swap.status).toBe(200);
    expect((await getEmailDomain(db, ALICE, id))!.api_key_hash).not.toBe(before.api_key_hash);
  });

  it('PUT/DELETE are owner-scoped (BOB gets 404 on ALICE domain)', async () => {
    const db = createTestDb();
    const id = await createResendDomain(db);
    const put = await PUT(ctx(db, { method: 'PUT', id, userEmail: BOB, body: { provider: 'resend', apiKey: 'k' } }));
    expect(put.status).toBe(404);
    const del = await DELETE(ctx(db, { method: 'DELETE', id, userEmail: BOB }));
    expect(del.status).toBe(404);
    const delOk = await DELETE(ctx(db, { method: 'DELETE', id }));
    expect(delOk.status).toBe(204);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run tests/unit/email-domains-api.test.ts`
Expected: FAIL，找不到 `@/pages/api/email/domains/*` 模块

- [ ] **Step 3: 实现路由**

创建 `src/pages/api/email/domains/index.ts`：

```ts
import type { APIRoute } from 'astro';
import { appContext, jsonError } from '@/server/context';
import { encryptSecret, sha256Hex } from '@/server/crypto';
import { getAccount } from '@/server/db/accounts';
import { insertEmailDomain, listEmailDomains, toPublic } from '@/server/db/emailDomains';

export const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export interface DomainBody {
  domain?: string;
  provider?: string;
  apiKey?: string;
  accountId?: string;
  cfAccountId?: string;
}

/** POST/PUT 共用的 provider 凭证校验；通过时返回 null，否则返回错误 Response */
export function validateProviderFields(body: DomainBody): Response | null {
  if (body.provider !== 'resend' && body.provider !== 'cloudflare') {
    return jsonError('provider must be resend or cloudflare', 400, 'fieldsRequired');
  }
  if (body.provider === 'cloudflare' && (!body.accountId || !body.cfAccountId)) {
    return jsonError('accountId and cfAccountId are required for cloudflare', 400, 'fieldsRequired');
  }
  return null;
}

export const GET: APIRoute = async ({ locals }) => {
  const { db, userEmail } = await appContext(locals);
  const rows = await listEmailDomains(db, userEmail);
  return Response.json({ domains: rows.map(toPublic) });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const body = (await request.json().catch(() => null)) as DomainBody | null;
  const domain = body?.domain?.trim().toLowerCase();
  if (!body || !domain || !DOMAIN_RE.test(domain)) return jsonError('invalid domain', 400, 'invalidDomain');
  const invalid = validateProviderFields(body);
  if (invalid) return invalid;
  if (body.provider === 'resend' && !body.apiKey?.trim()) {
    return jsonError('apiKey is required for resend', 400, 'fieldsRequired');
  }

  const { db, key, userEmail } = await appContext(locals);
  if (body.provider === 'cloudflare' && !(await getAccount(db, userEmail, body.accountId!))) {
    return jsonError('Account not found', 404, 'accountNotFound');
  }
  const apiKey = body.apiKey?.trim();
  const id = crypto.randomUUID();
  try {
    await insertEmailDomain(db, {
      id,
      ownerEmail: userEmail,
      domain,
      provider: body.provider as 'resend' | 'cloudflare',
      apiKeyCiphertext: body.provider === 'resend' ? await encryptSecret(apiKey!, key) : null,
      apiKeyHash: body.provider === 'resend' ? await sha256Hex(apiKey!) : null,
      accountId: body.provider === 'cloudflare' ? body.accountId! : null,
      cfAccountId: body.provider === 'cloudflare' ? body.cfAccountId! : null,
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes('already configured')) {
      return jsonError('This domain is already configured', 409, 'duplicateDomain');
    }
    throw e;
  }
  return Response.json({ domain: { id, domain, provider: body.provider } }, { status: 201 });
};
```

创建 `src/pages/api/email/domains/[id].ts`：

```ts
import type { APIRoute } from 'astro';
import { appContext, jsonError } from '@/server/context';
import { encryptSecret, sha256Hex } from '@/server/crypto';
import { getAccount } from '@/server/db/accounts';
import { deleteEmailDomain, getEmailDomain, updateEmailDomain } from '@/server/db/emailDomains';
import { type DomainBody, validateProviderFields } from './index';

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const body = (await request.json().catch(() => null)) as DomainBody | null;
  if (!body) return jsonError('provider is required', 400, 'fieldsRequired');
  const invalid = validateProviderFields(body);
  if (invalid) return invalid;

  const { db, key, userEmail } = await appContext(locals);
  const row = await getEmailDomain(db, userEmail, params.id!);
  if (!row) return jsonError('Sending domain not found', 404, 'domainNotFound');

  if (body.provider === 'resend') {
    const apiKey = body.apiKey?.trim();
    // 换 key 时重新加密；留空且原来就是 resend → 保留旧凭证
    if (!apiKey && row.provider !== 'resend') return jsonError('apiKey is required for resend', 400, 'fieldsRequired');
    await updateEmailDomain(db, userEmail, row.id, {
      provider: 'resend',
      apiKeyCiphertext: apiKey ? await encryptSecret(apiKey, key) : row.api_key_ciphertext,
      apiKeyHash: apiKey ? await sha256Hex(apiKey) : row.api_key_hash,
      accountId: null,
      cfAccountId: null,
    });
  } else {
    if (!(await getAccount(db, userEmail, body.accountId!))) {
      return jsonError('Account not found', 404, 'accountNotFound');
    }
    await updateEmailDomain(db, userEmail, row.id, {
      provider: 'cloudflare',
      apiKeyCiphertext: null,
      apiKeyHash: null,
      accountId: body.accountId!,
      cfAccountId: body.cfAccountId!,
    });
  }
  return Response.json({ ok: true });
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  const { db, userEmail } = await appContext(locals);
  if (!(await getEmailDomain(db, userEmail, params.id!))) {
    return jsonError('Sending domain not found', 404, 'domainNotFound');
  }
  // email_log.domain_id ON DELETE SET NULL + 快照列：发送历史保留
  await deleteEmailDomain(db, userEmail, params.id!);
  return new Response(null, { status: 204 });
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run tests/unit/email-domains-api.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/pages/api/email/domains tests/unit/email-domains-api.test.ts
git commit -m "feat: add email sending domain management API"
```

---

### Task 9: 发送 API `POST /api/email/send`

**Files:**
- Create: `src/pages/api/email/send.ts`
- Test: `tests/unit/email-send-api.test.ts`

**Interfaces:**
- Consumes: Task 7 `sendEmail` / `SendDeps`；`EmailValidationError`；`CfApiError`；`handleCfError`。
- Produces: `POST /api/email/send` body `{ domainId, from, fromName?, to: string[], cc?: string[], bcc?: string[], subject, format, content }` → 200 `SendResult`。错误 code：`fieldsRequired`(400)、`invalidRecipient`(400)、`fromDomainMismatch`/`renderFailed`(400，来自服务层)、`emailSendForbidden`(403，CF token 缺 Email Sending 权限)；其余 CfApiError 4xx 原样 / 5xx → 502（`handleCfError`）；跨用户 domainId → 404。
- 路由层测试注入：模块导出 `let deps: SendDeps` 不可行（Astro 路由无注入点）——测试用 `__setSendDeps` 钩子；见 Step 3 实现（模块级 `let testDeps`，仅测试环境赋值）。

- [ ] **Step 1: 写失败的测试**

创建 `tests/unit/email-send-api.test.ts`：

```ts
import { createTestDb } from '@tests/helpers/d1';
import { afterEach, describe, expect, it } from 'vitest';
import { POST, __setSendDeps } from '@/pages/api/email/send';
import { CfApiError } from '@/server/cf/client';
import { encryptSecret, importEncryptionKey, sha256Hex } from '@/server/crypto';
import { insertEmailDomain } from '@/server/db/emailDomains';
import type { Db } from '@/server/db/types';

const HEX_KEY = 'f'.repeat(64);
const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';

function ctx(db: unknown, body: unknown, userEmail = ALICE) {
  return {
    locals: { userEmail, runtime: { env: { DB: db, ENCRYPTION_KEY: HEX_KEY } } },
    request: new Request('http://localhost/api/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params: {},
  } as unknown as Parameters<typeof POST>[0];
}

async function seedResendDomain(db: Db): Promise<void> {
  const key = await importEncryptionKey(HEX_KEY);
  await insertEmailDomain(db, {
    id: 'dom-1',
    ownerEmail: ALICE,
    domain: 'mail.example.com',
    provider: 'resend',
    apiKeyCiphertext: await encryptSecret('re_key_1', key),
    apiKeyHash: await sha256Hex('re_key_1'),
    accountId: null,
    cfAccountId: null,
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    domainId: 'dom-1',
    from: 'no-reply@mail.example.com',
    to: ['a@b.co'],
    subject: 'Hi',
    format: 'markdown',
    content: '# hello',
    ...overrides,
  };
}

async function countLogs(db: Db): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS cnt FROM email_log').first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

afterEach(() => __setSendDeps(undefined));

describe('POST /api/email/send', () => {
  it('sends via the injected provider and returns the SendResult', async () => {
    const db = createTestDb();
    await seedResendDomain(db);
    __setSendDeps({ resend: async () => ({ messageId: 'rid-1' }) });
    const res = await POST(ctx(db, validBody()));
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toMatchObject({ status: 'sent', messageId: 'rid-1' });
    expect(await countLogs(db)).toBe(1);
  });

  it('400 fieldsRequired for missing to/subject/content/bad format, without logging', async () => {
    const db = createTestDb();
    await seedResendDomain(db);
    for (const bad of [{ to: [] }, { subject: ' ' }, { content: '' }, { format: 'rtf' }]) {
      const res = await POST(ctx(db, validBody(bad)));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('fieldsRequired');
    }
    expect(await countLogs(db)).toBe(0);
  });

  it('400 invalidRecipient names the bad address', async () => {
    const db = createTestDb();
    await seedResendDomain(db);
    const res = await POST(ctx(db, validBody({ cc: ['not-an-email'] })));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('invalidRecipient');
    expect(body.error).toContain('not-an-email');
  });

  it('400 fromDomainMismatch comes from the service layer, no log', async () => {
    const db = createTestDb();
    await seedResendDomain(db);
    const res = await POST(ctx(db, validBody({ from: 'x@other.com' })));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('fromDomainMismatch');
    expect(await countLogs(db)).toBe(0);
  });

  it('404 for a cross-user domainId', async () => {
    const db = createTestDb();
    await seedResendDomain(db);
    const res = await POST(ctx(db, validBody(), BOB));
    expect(res.status).toBe(404);
    expect(await countLogs(db)).toBe(0);
  });

  it('provider 403 maps to emailSendForbidden and the failure is logged', async () => {
    const db = createTestDb();
    await seedResendDomain(db);
    __setSendDeps({
      resend: async () => {
        throw new CfApiError(403, ['missing Email Sending scope']);
      },
    });
    const res = await POST(ctx(db, validBody()));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('emailSendForbidden');
    expect(await countLogs(db)).toBe(1);
    const log = await db.prepare('SELECT status FROM email_log').first<{ status: string }>();
    expect(log?.status).toBe('failed');
  });

  it('provider 5xx maps to 502 via handleCfError', async () => {
    const db = createTestDb();
    await seedResendDomain(db);
    __setSendDeps({
      resend: async () => {
        throw new CfApiError(500, ['upstream down']);
      },
    });
    const res = await POST(ctx(db, validBody()));
    expect(res.status).toBe(502);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run tests/unit/email-send-api.test.ts`
Expected: FAIL，找不到 `@/pages/api/email/send`

- [ ] **Step 3: 实现路由**

创建 `src/pages/api/email/send.ts`：

```ts
import type { APIRoute } from 'astro';
import { CfApiError } from '@/server/cf/client';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { type SendDeps, sendEmail } from '@/server/email';
import { EmailValidationError, type EmailFormat } from '@/server/email/types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FORMATS: readonly string[] = ['markdown', 'html', 'text'];

/** 仅测试用：注入假 provider（生产代码不调用）。Astro 路由没有构造注入点，用模块级钩子。 */
let testDeps: SendDeps | undefined;
export function __setSendDeps(deps: SendDeps | undefined): void {
  testDeps = deps;
}

interface SendBody {
  domainId?: string;
  from?: string;
  fromName?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  format?: string;
  content?: string;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const body = (await request.json().catch(() => null)) as SendBody | null;
  const to = Array.isArray(body?.to) ? body.to : [];
  const cc = Array.isArray(body?.cc) ? body.cc : [];
  const bcc = Array.isArray(body?.bcc) ? body.bcc : [];
  if (
    !body?.domainId ||
    !body.from?.trim() ||
    to.length === 0 ||
    !body.subject?.trim() ||
    !body.content?.trim() ||
    !FORMATS.includes(body.format ?? '')
  ) {
    return jsonError('domainId, from, to, subject, format and content are required', 400, 'fieldsRequired');
  }
  const bad = [body.from, ...to, ...cc, ...bcc].find((r) => !EMAIL_RE.test(r));
  if (bad !== undefined) return jsonError(`invalid email address: ${bad}`, 400, 'invalidRecipient');

  const ctx = await appContext(locals);
  try {
    const result = await sendEmail(
      ctx,
      body.domainId,
      {
        from: body.from.trim(),
        fromName: body.fromName?.trim() || undefined,
        to,
        cc: cc.length ? cc : undefined,
        bcc: bcc.length ? bcc : undefined,
        subject: body.subject.trim(),
        format: body.format as EmailFormat,
        content: body.content,
      },
      testDeps ?? {},
    );
    return Response.json(result);
  } catch (e) {
    if (e instanceof EmailValidationError) return jsonError(e.message, 400, e.code);
    // CF token 缺 Email Sending 权限等 403：仅该动作失败，带稳定 code 供前端本地化提示
    if (e instanceof CfApiError && e.status === 403) return jsonError(e.message, 403, 'emailSendForbidden');
    return handleCfError(e);
  }
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run tests/unit/email-send-api.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/pages/api/email/send.ts tests/unit/email-send-api.test.ts
git commit -m "feat: add email send API endpoint"
```

---
### Task 10: 记录 API `/api/email/log`

**Files:**
- Create: `src/pages/api/email/log/index.ts`
- Create: `src/pages/api/email/log/[id].ts`
- Test: `tests/unit/email-log-api.test.ts`

**Interfaces:**
- Consumes: Task 3 `listEmailLogs` / `getEmailLog`。
- Produces:
  - `GET /api/email/log?page=&pageSize=` → `{ logs: EmailLogListItem[], total, page, pageSize }`（默认 pageSize 20，上限 100，不含 content）
  - `GET /api/email/log/[id]` → `{ log: EmailLogDetail }`（含 content）；查不到/跨用户 → 404 `logNotFound`

- [ ] **Step 1: 写失败的测试**

创建 `tests/unit/email-log-api.test.ts`：

```ts
import { createTestDb } from '@tests/helpers/d1';
import { describe, expect, it } from 'vitest';
import { GET as getDetail } from '@/pages/api/email/log/[id]';
import { GET as getList } from '@/pages/api/email/log/index';
import { insertEmailLog } from '@/server/db/emailLog';
import type { Db } from '@/server/db/types';

const HEX_KEY = 'a'.repeat(64);
const ALICE = 'alice@ops.dev';
const BOB = 'bob@ops.dev';

function ctx(db: unknown, opts: { url?: string; userEmail?: string; id?: string } = {}) {
  return {
    locals: { userEmail: opts.userEmail ?? ALICE, runtime: { env: { DB: db, ENCRYPTION_KEY: HEX_KEY } } },
    request: new Request(opts.url ?? 'http://localhost/api/email/log'),
    params: opts.id ? { id: opts.id } : {},
  } as unknown as Parameters<typeof getList>[0];
}

async function seed(db: Db, id: string, ownerEmail = ALICE): Promise<void> {
  await insertEmailLog(db, {
    id,
    ownerEmail,
    domainId: null,
    provider: 'resend',
    fromAddress: 'no-reply@mail.example.com',
    recipients: { to: ['a@b.co'], cc: [], bcc: [] },
    subject: `s-${id}`,
    format: 'markdown',
    content: `# secret-body-${id}`,
    status: 'sent',
    messageId: `mid-${id}`,
    error: null,
  });
}

describe('email log API', () => {
  it('lists with paging metadata and never includes content', async () => {
    const db = createTestDb();
    for (let i = 1; i <= 3; i++) await seed(db, `l${i}`);
    const res = await getList(ctx(db, { url: 'http://localhost/api/email/log?page=1&pageSize=2' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: unknown[]; total: number; page: number; pageSize: number };
    expect(body).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(body.logs).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain('secret-body');
  });

  it('detail includes content; cross-user detail is 404', async () => {
    const db = createTestDb();
    await seed(db, 'l1');
    const ok = await getDetail(ctx(db, { id: 'l1' }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { log: { content: string } }).log.content).toBe('# secret-body-l1');
    const denied = await getDetail(ctx(db, { id: 'l1', userEmail: BOB }));
    expect(denied.status).toBe(404);
  });

  it('list is owner-scoped', async () => {
    const db = createTestDb();
    await seed(db, 'l1', ALICE);
    await seed(db, 'b1', BOB);
    const res = await getList(ctx(db, { userEmail: BOB }));
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run tests/unit/email-log-api.test.ts`
Expected: FAIL，找不到 `@/pages/api/email/log/*`

- [ ] **Step 3: 实现路由**

创建 `src/pages/api/email/log/index.ts`：

```ts
import type { APIRoute } from 'astro';
import { appContext } from '@/server/context';
import { listEmailLogs } from '@/server/db/emailLog';

export const GET: APIRoute = async ({ locals, request }) => {
  const { db, userEmail } = await appContext(locals);
  const url = new URL(request.url);
  const rawPage = parseInt(url.searchParams.get('page') ?? '1', 10);
  const rawPageSize = parseInt(url.searchParams.get('pageSize') ?? '20', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1 ? Math.min(100, rawPageSize) : 20;
  const { logs, total } = await listEmailLogs(db, userEmail, { page, pageSize });
  return Response.json({ logs, total, page, pageSize });
};
```

创建 `src/pages/api/email/log/[id].ts`：

```ts
import type { APIRoute } from 'astro';
import { appContext, jsonError } from '@/server/context';
import { getEmailLog } from '@/server/db/emailLog';

export const GET: APIRoute = async ({ params, locals }) => {
  const { db, userEmail } = await appContext(locals);
  const log = await getEmailLog(db, userEmail, params.id!);
  if (!log) return jsonError('Log not found', 404, 'logNotFound');
  return Response.json({ log });
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run tests/unit/email-log-api.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/pages/api/email/log tests/unit/email-log-api.test.ts
git commit -m "feat: add email send log API"
```

---

### Task 11: CF 侧账号列表 API `GET /api/accounts/[id]/cf-accounts`

**Files:**
- Create: `src/pages/api/accounts/[id]/cf-accounts.ts`
- Test: `tests/unit/email-domains-api.test.ts`（追加 describe）

UI 在 provider=cloudflare 时需要「本系统账号 → 该 token 可见的 CF 侧账号」两级下拉；此端点解密 token 后调 `CfClient.listAccounts()`。（Astro 支持 `[id].ts` 与 `[id]/cf-accounts.ts` 并存。）

**Interfaces:**
- Consumes: `getAccount`、`decryptSecret`、`CfClient.listAccounts()`（已有方法）、`handleCfError`。
- Produces: `GET /api/accounts/[id]/cf-accounts` → `{ cfAccounts: { id: string; name: string }[] }`；跨用户/不存在 → 404 `accountNotFound`；CF 错误经 `handleCfError` 映射。

- [ ] **Step 1: 追加失败的测试**

在 `tests/unit/email-domains-api.test.ts` 末尾追加（导入区补 `import { GET as getCfAccounts } from '@/pages/api/accounts/[id]/cf-accounts';`）：

```ts
describe('GET /api/accounts/[id]/cf-accounts', () => {
  it("returns 404 for another user's account without touching the CF API", async () => {
    const db = createTestDb();
    await insertAccount(db, { id: 'a1', ownerEmail: BOB, name: 'bob', tokenEncrypted: 'x', tokenHash: 'h1' });
    const res = await getCfAccounts(ctx(db, { id: 'a1' }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('accountNotFound');
  });
});
```

（成功路径需要真实 CF API，走 Task 5 已测的 `listAccounts`；此处只锁隔离行为。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run tests/unit/email-domains-api.test.ts`
Expected: FAIL，找不到 `@/pages/api/accounts/[id]/cf-accounts`

- [ ] **Step 3: 实现路由**

创建 `src/pages/api/accounts/[id]/cf-accounts.ts`：

```ts
import type { APIRoute } from 'astro';
import { CfClient } from '@/server/cf/client';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { decryptSecret } from '@/server/crypto';
import { getAccount } from '@/server/db/accounts';

/** 该账号 token 可见的 CF 侧账号列表：email 域名配置（provider=cloudflare）的二级下拉用 */
export const GET: APIRoute = async ({ params, locals }) => {
  const { db, key, userEmail } = await appContext(locals);
  const account = await getAccount(db, userEmail, params.id!);
  if (!account) return jsonError('Account not found', 404, 'accountNotFound');
  try {
    const token = await decryptSecret(account.token_encrypted, key);
    const cfAccounts = await new CfClient(token).listAccounts();
    return Response.json({ cfAccounts });
  } catch (e) {
    return handleCfError(e);
  }
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run tests/unit/email-domains-api.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 5: 提交**

```bash
git add 'src/pages/api/accounts/[id]/cf-accounts.ts' tests/unit/email-domains-api.test.ts
git commit -m "feat: add per-account CF account list endpoint"
```

---

### Task 12: i18n 字符串 + 导航入口

**Files:**
- Modify: `src/i18n/index.ts`（zh 表 `} as const;` 之前、en 表结尾 `};` 之前各追加一组）
- Modify: `src/layouts/MainLayout.astro`

**Interfaces:**
- Produces: `MessageKey` 新增 `nav.email` 与全部 `email.*` 键（zh/en 两表键集必须一致，`Record<MessageKey, string>` 会静态检查 en 表漏键）。

- [ ] **Step 1: zh 表追加（在 `'config.internal': …,` 行之后、`} as const;` 之前）**

```ts
  'nav.email': '邮件',
  'email.pageTitle': '邮件发送',
  'email.tabSend': '发送',
  'email.tabDomains': '域名',
  'email.tabLog': '记录',
  'email.sendTitle': '发送邮件',
  'email.domainLabel': '发送域名',
  'email.noDomains': '尚未配置发送域名，请先到「域名」标签添加',
  'email.fromLocalPlaceholder': '发件人（@ 前部分）',
  'email.fromNamePlaceholder': '显示名（可选）',
  'email.toPlaceholder': '收件人，多个用英文逗号分隔',
  'email.ccPlaceholder': '抄送（可选，逗号分隔）',
  'email.bccPlaceholder': '密送（可选，逗号分隔）',
  'email.subjectPlaceholder': '主题',
  'email.formatMarkdown': 'Markdown',
  'email.formatHtml': 'HTML',
  'email.formatText': '纯文本',
  'email.contentPlaceholder': '正文内容',
  'email.editMode': '编辑',
  'email.previewMode': '预览',
  'email.send': '发送',
  'email.sending': '发送中…',
  'email.sent': '邮件已发送',
  'email.domainsTitle': '发送域名',
  'email.addDomainTitle': '添加发送域名',
  'email.domainPlaceholder': '域名（如 mail.example.com）',
  'email.providerLabel': '发送服务',
  'email.apiKeyPlaceholder': 'Resend API Key',
  'email.newApiKeyPlaceholder': '新 API Key（留空则不更换）',
  'email.accountLabel': '账号',
  'email.cfAccountLabel': 'CF 侧账号',
  'email.colDomain': '域名',
  'email.colProvider': '服务',
  'email.colCredential': '凭证',
  'email.colCreated': '添加时间',
  'email.colActions': '操作',
  'email.add': '添加',
  'email.edit': '编辑',
  'email.delete': '删除',
  'email.save': '保存',
  'email.editDomainTitle': '编辑发送域名',
  'email.domainAdded': '发送域名已添加',
  'email.domainUpdated': '发送域名已更新',
  'email.domainDeleted': '发送域名已删除',
  'email.confirmDeleteDomain': '确认删除发送域名 {domain}？发送记录会保留。',
  'email.emptyDomains': '尚未配置发送域名',
  'email.logTitle': '发送记录',
  'email.colTime': '时间',
  'email.colFrom': '发件地址',
  'email.colTo': '收件人',
  'email.colSubject': '主题',
  'email.colStatus': '状态',
  'email.statusSent': '已发送',
  'email.statusFailed': '失败',
  'email.emptyLog': '暂无发送记录',
  'email.logDetailTitle': '发送详情',
  'email.logError': '错误信息',
  'email.errFieldsRequired': '请填写所有必填字段',
  'email.errInvalidDomain': '域名格式不正确',
  'email.errDuplicateDomain': '该域名已配置过',
  'email.errDomainNotFound': '发送域名不存在',
  'email.errInvalidRecipient': '收件人邮箱格式不正确',
  'email.errFromDomainMismatch': '发件地址与所选域名不一致',
  'email.errRenderFailed': '正文渲染失败，请检查内容',
  'email.errScopeMissing': 'Token 缺少 Email Sending 权限，发送失败（其余功能不受影响）',
  'email.errLogNotFound': '记录不存在',
```

- [ ] **Step 2: en 表追加（`'config.internal': …,` 之后、`};` 之前）**

```ts
  'nav.email': 'Email',
  'email.pageTitle': 'Email',
  'email.tabSend': 'Compose',
  'email.tabDomains': 'Domains',
  'email.tabLog': 'Log',
  'email.sendTitle': 'Send email',
  'email.domainLabel': 'Sending domain',
  'email.noDomains': 'No sending domain configured yet — add one in the Domains tab',
  'email.fromLocalPlaceholder': 'Sender (part before @)',
  'email.fromNamePlaceholder': 'Display name (optional)',
  'email.toPlaceholder': 'To — separate multiple with commas',
  'email.ccPlaceholder': 'Cc (optional, comma-separated)',
  'email.bccPlaceholder': 'Bcc (optional, comma-separated)',
  'email.subjectPlaceholder': 'Subject',
  'email.formatMarkdown': 'Markdown',
  'email.formatHtml': 'HTML',
  'email.formatText': 'Plain text',
  'email.contentPlaceholder': 'Body content',
  'email.editMode': 'Edit',
  'email.previewMode': 'Preview',
  'email.send': 'Send',
  'email.sending': 'Sending…',
  'email.sent': 'Email sent',
  'email.domainsTitle': 'Sending domains',
  'email.addDomainTitle': 'Add sending domain',
  'email.domainPlaceholder': 'Domain (e.g. mail.example.com)',
  'email.providerLabel': 'Provider',
  'email.apiKeyPlaceholder': 'Resend API key',
  'email.newApiKeyPlaceholder': 'New API key (leave blank to keep)',
  'email.accountLabel': 'Account',
  'email.cfAccountLabel': 'Cloudflare account',
  'email.colDomain': 'Domain',
  'email.colProvider': 'Provider',
  'email.colCredential': 'Credential',
  'email.colCreated': 'Added',
  'email.colActions': 'Actions',
  'email.add': 'Add',
  'email.edit': 'Edit',
  'email.delete': 'Delete',
  'email.save': 'Save',
  'email.editDomainTitle': 'Edit sending domain',
  'email.domainAdded': 'Sending domain added',
  'email.domainUpdated': 'Sending domain updated',
  'email.domainDeleted': 'Sending domain deleted',
  'email.confirmDeleteDomain': 'Delete sending domain {domain}? Send history is kept.',
  'email.emptyDomains': 'No sending domains yet',
  'email.logTitle': 'Send log',
  'email.colTime': 'Time',
  'email.colFrom': 'From',
  'email.colTo': 'To',
  'email.colSubject': 'Subject',
  'email.colStatus': 'Status',
  'email.statusSent': 'Sent',
  'email.statusFailed': 'Failed',
  'email.emptyLog': 'No send records yet',
  'email.logDetailTitle': 'Send detail',
  'email.logError': 'Error',
  'email.errFieldsRequired': 'Please fill in all required fields',
  'email.errInvalidDomain': 'Invalid domain format',
  'email.errDuplicateDomain': 'This domain is already configured',
  'email.errDomainNotFound': 'Sending domain not found',
  'email.errInvalidRecipient': 'Invalid recipient email address',
  'email.errFromDomainMismatch': 'Sender address does not match the selected domain',
  'email.errRenderFailed': 'Failed to render the body content',
  'email.errScopeMissing': 'The token lacks the Email Sending permission — send failed (other features unaffected)',
  'email.errLogNotFound': 'Record not found',
```

- [ ] **Step 3: 导航入口**

`src/layouts/MainLayout.astro` 顶部 lucide 导入行追加 `Mail`（保持字母序）：

```ts
import { BarChart3, Check, ChevronDown, Database, Globe, Languages, LayoutDashboard, LogOut, Mail, Menu, PanelLeft, UserRound, Users, Workflow } from 'lucide-react';
```

`nav` 数组 `usage` 条目之后追加：

```ts
  { href: localizePath(locale, '/email'), label: t(locale, 'nav.email'), Icon: Mail },
```

- [ ] **Step 4: 校验**

Run: `pnpm run typecheck && pnpm exec vitest run tests/unit/i18n.test.ts`
Expected: typecheck PASS（en 表漏键会在这里报错）；i18n 测试 PASS

- [ ] **Step 5: 提交**

```bash
git add src/i18n/index.ts src/layouts/MainLayout.astro
git commit -m "feat: add email i18n strings and nav entry"
```

---
### Task 13: 预览组件 `src/components/ui/EmailPreview.tsx`

**Files:**
- Create: `src/components/ui/EmailPreview.tsx`

**Interfaces:**
- Consumes: `marked`（与服务端 render.ts 同一依赖同一版本，预览与实际发出一致）；`EmailFormat`（type-only 导入服务端类型，构建时擦除）。
- Produces: `EmailPreview({ format, content }: { format: EmailFormat; content: string })` 默认导出，发送前预览与记录回看共用。

- [ ] **Step 1: 实现组件**

创建 `src/components/ui/EmailPreview.tsx`：

```tsx
import { marked } from 'marked';
import { useMemo } from 'react';
import type { EmailFormat } from '@/server/email/types';

/**
 * 预览 = 回看共用组件。存储的用户内容（markdown 渲染产物 / 原样 HTML）一律装进
 * sandbox iframe（srcdoc + sandbox=""，禁脚本禁同源）展示，杜绝 dangerouslySetInnerHTML
 * 直接注入导致的存储型自 XSS。markdown 用与服务端 render.ts 同一版本 marked，
 * 预览所见即实际发出的 HTML 正文。
 */
export default function EmailPreview({ format, content }: { format: EmailFormat; content: string }) {
  const html = useMemo(() => {
    if (format === 'markdown') return marked.parse(content, { async: false });
    if (format === 'html') return content;
    return null;
  }, [format, content]);

  if (format === 'text') {
    return (
      <pre className="max-h-96 min-h-48 overflow-auto whitespace-pre-wrap rounded border border-base-300 bg-base-200/40 p-3 font-mono text-sm">
        {content}
      </pre>
    );
  }
  return (
    <iframe
      title="email-preview"
      sandbox=""
      srcDoc={`<!doctype html><meta charset="utf-8"><body style="margin:16px;font-family:system-ui,sans-serif;line-height:1.6;word-break:break-word">${html}</body>`}
      className="h-96 w-full rounded border border-base-300 bg-white"
    />
  );
}
```

- [ ] **Step 2: 校验 + 提交**

Run: `pnpm run typecheck`
Expected: PASS

```bash
git add src/components/ui/EmailPreview.tsx
git commit -m "feat: add sandboxed email preview component"
```

---

### Task 14: `EmailPanel` island + `/email` 页面（zh + en）

**Files:**
- Create: `src/components/EmailPanel.tsx`
- Create: `src/pages/email.astro`
- Create: `src/pages/en/email.astro`

**Interfaces:**
- Consumes: Task 8–11 的全部 API；Task 12 的 i18n 键；Task 13 `EmailPreview`；现有 `DetailTabs`/`useDetailTab`、`TablePagination`、`ToastProvider`/`useToast`、`ConfirmDialogProvider`/`useConfirm`、`relativeTime`。
- Produces: `EmailPanel({ locale, initialTab })` 默认导出；页面 `/email` 与 `/en/email`（`?tab=` 由服务端读出传 `initialTab` 防 hydration mismatch）。

移动端要点（Global Constraints 的具体落点）：所有表格包 `overflow-x-auto`；域名表的「凭证/添加时间」列 `hidden sm:table-cell` / `hidden md:table-cell`；记录表的「发件地址/收件人」列同规则；btn-xs/btn-sm 含汉字按钮加 `whitespace-nowrap`；表单行 `flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start`，输入 `w-full sm:w-48` 或 `sm:flex-1`；tab 内容全宽垂直堆叠。

- [ ] **Step 1: 实现 EmailPanel**

创建 `src/components/EmailPanel.tsx`：

```tsx
import { Eye, Mail, Pencil, Plus, Send, SquarePen, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { type Locale, type MessageKey, t } from '@/i18n';
import { relativeTime } from '@/lib/time';
import type { EmailFormat } from '@/server/email/types';
import { ConfirmDialogProvider, useConfirm } from './ui/ConfirmDialog';
import DetailTabs, { useDetailTab } from './ui/DetailTabs';
import EmailPreview from './ui/EmailPreview';
import TablePagination from './ui/TablePagination';
import { ToastProvider, useToast } from './ui/ToastProvider';

const TAB_KEYS = ['send', 'domains', 'log'] as const;
type TabKey = (typeof TAB_KEYS)[number];

const FORMAT_KEYS: Record<EmailFormat, MessageKey> = {
  markdown: 'email.formatMarkdown',
  html: 'email.formatHtml',
  text: 'email.formatText',
};

const ERROR_CODE_KEYS: Record<string, MessageKey> = {
  fieldsRequired: 'email.errFieldsRequired',
  invalidDomain: 'email.errInvalidDomain',
  duplicateDomain: 'email.errDuplicateDomain',
  domainNotFound: 'email.errDomainNotFound',
  invalidRecipient: 'email.errInvalidRecipient',
  fromDomainMismatch: 'email.errFromDomainMismatch',
  renderFailed: 'email.errRenderFailed',
  emailSendForbidden: 'email.errScopeMissing',
  logNotFound: 'email.errLogNotFound',
  accountNotFound: 'accounts.errNotFound',
};

interface DomainItem {
  id: string;
  domain: string;
  provider: 'resend' | 'cloudflare';
  apiKeyHint: string | null;
  accountId: string | null;
  cfAccountId: string | null;
  createdAt: string;
}

interface AccountItem {
  id: string;
  name: string;
}

interface LogItem {
  id: string;
  provider: string;
  fromAddress: string;
  recipients: { to: string[]; cc: string[]; bcc: string[] };
  subject: string;
  format: EmailFormat;
  status: string;
  messageId: string | null;
  error: string | null;
  createdAt: string;
}

interface LogDetail extends LogItem {
  content: string;
}

function splitEmails(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function useApiErrorText(locale: Locale) {
  return useCallback(
    (data: { error?: string; code?: string } | null): string => {
      const key = data?.code ? ERROR_CODE_KEYS[data.code] : undefined;
      if (key) return t(locale, key);
      return data?.error ?? t(locale, 'common.requestFailed');
    },
    [locale],
  );
}

/* ---------------- 发送 tab ---------------- */

function SendTab({ locale, domains }: { locale: Locale; domains: DomainItem[] }) {
  const [domainId, setDomainId] = useState('');
  const [fromLocal, setFromLocal] = useState('');
  const [fromName, setFromName] = useState('');
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState('');
  const [format, setFormat] = useState<EmailFormat>('markdown');
  const [content, setContent] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const { showToast } = useToast();
  const apiErrorText = useApiErrorText(locale);

  const selected = domains.find((d) => d.id === domainId) ?? domains[0];
  const effectiveDomainId = selected?.id ?? '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setSending(true);
    try {
      const res = await fetch('/api/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domainId: effectiveDomainId,
          from: `${fromLocal.trim()}@${selected.domain}`,
          fromName: fromName.trim() || undefined,
          to: splitEmails(to),
          cc: splitEmails(cc),
          bcc: splitEmails(bcc),
          subject,
          format,
          content,
        }),
      });
      if (res.ok) {
        showToast(t(locale, 'email.sent'), 'success');
        // 保留收件人与主题便于连发，清空正文
        setContent('');
        setPreviewing(false);
      } else {
        const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        showToast(apiErrorText(data), 'error');
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setSending(false);
    }
  }

  if (domains.length === 0) {
    return (
      <div className="card flex flex-col items-center gap-4 border border-base-300 bg-base-100 p-12">
        <Mail size={48} strokeWidth={1.75} className="opacity-40" />
        <p className="text-sm opacity-60">{t(locale, 'email.noDomains')}</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="card border border-base-300 bg-base-100 p-4">
      <fieldset className="fieldset">
        <legend className="fieldset-legend">{t(locale, 'email.sendTitle')}</legend>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
          <select
            className="select select-bordered select-sm w-full sm:w-56"
            value={effectiveDomainId}
            onChange={(e) => setDomainId(e.target.value)}
            title={t(locale, 'email.domainLabel')}
          >
            {domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.domain}（{d.provider}）
              </option>
            ))}
          </select>
          <label className="input input-bordered input-sm flex w-full items-center gap-1 sm:w-72">
            <input
              type="text"
              className="min-w-0 grow"
              placeholder={t(locale, 'email.fromLocalPlaceholder')}
              value={fromLocal}
              onChange={(e) => setFromLocal(e.target.value)}
              required
            />
            <span className="shrink-0 whitespace-nowrap font-mono text-xs opacity-60">@{selected.domain}</span>
          </label>
          <input
            className="input input-bordered input-sm w-full sm:w-48"
            placeholder={t(locale, 'email.fromNamePlaceholder')}
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
          />
        </div>
        <div className="mt-2 flex flex-col gap-2">
          <input
            className="input input-bordered input-sm w-full"
            placeholder={t(locale, 'email.toPlaceholder')}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            required
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="input input-bordered input-sm w-full sm:flex-1"
              placeholder={t(locale, 'email.ccPlaceholder')}
              value={cc}
              onChange={(e) => setCc(e.target.value)}
            />
            <input
              className="input input-bordered input-sm w-full sm:flex-1"
              placeholder={t(locale, 'email.bccPlaceholder')}
              value={bcc}
              onChange={(e) => setBcc(e.target.value)}
            />
          </div>
          <input
            className="input input-bordered input-sm w-full"
            placeholder={t(locale, 'email.subjectPlaceholder')}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            required
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="join">
            {(Object.keys(FORMAT_KEYS) as EmailFormat[]).map((f) => (
              <button
                key={f}
                type="button"
                className={`btn join-item btn-xs whitespace-nowrap${format === f ? ' btn-active' : ''}`}
                onClick={() => setFormat(f)}
              >
                {t(locale, FORMAT_KEYS[f])}
              </button>
            ))}
          </div>
          <div className="join">
            <button
              type="button"
              className={`btn join-item btn-xs whitespace-nowrap${previewing ? '' : ' btn-active'}`}
              onClick={() => setPreviewing(false)}
            >
              <SquarePen size={14} strokeWidth={1.75} />
              {t(locale, 'email.editMode')}
            </button>
            <button
              type="button"
              className={`btn join-item btn-xs whitespace-nowrap${previewing ? ' btn-active' : ''}`}
              onClick={() => setPreviewing(true)}
            >
              <Eye size={14} strokeWidth={1.75} />
              {t(locale, 'email.previewMode')}
            </button>
          </div>
        </div>
        <div className="mt-2">
          {previewing ? (
            <EmailPreview format={format} content={content} />
          ) : (
            <textarea
              className="textarea textarea-bordered h-96 w-full font-mono text-sm"
              placeholder={t(locale, 'email.contentPlaceholder')}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              required
            />
          )}
        </div>
        <div className="mt-3">
          <button className="btn btn-primary btn-sm whitespace-nowrap" disabled={sending} type="submit">
            {sending ? <span className="loading loading-spinner loading-xs" /> : <Send size={14} strokeWidth={1.75} />}
            {sending ? t(locale, 'email.sending') : t(locale, 'email.send')}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

/* ---------------- 域名 tab ---------------- */

interface DomainFormValue {
  domain: string;
  provider: 'resend' | 'cloudflare';
  apiKey: string;
  accountId: string;
  cfAccountId: string;
}

function DomainFields({
  locale,
  value,
  onChange,
  accounts,
  editing,
}: {
  locale: Locale;
  value: DomainFormValue;
  onChange: (v: DomainFormValue) => void;
  accounts: AccountItem[];
  editing: boolean;
}) {
  const [cfAccounts, setCfAccounts] = useState<AccountItem[]>([]);

  // 选定本系统账号后拉取该 token 可见的 CF 侧账号
  useEffect(() => {
    if (value.provider !== 'cloudflare' || !value.accountId) {
      setCfAccounts([]);
      return;
    }
    let cancelled = false;
    void fetch(`/api/accounts/${value.accountId}/cf-accounts`)
      .then((res) => (res.ok ? res.json() : { cfAccounts: [] }))
      .then((data: { cfAccounts: AccountItem[] }) => {
        if (!cancelled) setCfAccounts(data.cfAccounts);
      })
      .catch(() => {
        if (!cancelled) setCfAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [value.provider, value.accountId]);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
      <input
        className="input input-bordered input-sm w-full sm:w-56"
        placeholder={t(locale, 'email.domainPlaceholder')}
        value={value.domain}
        onChange={(e) => onChange({ ...value, domain: e.target.value })}
        disabled={editing}
        required={!editing}
      />
      <select
        className="select select-bordered select-sm w-full sm:w-40"
        value={value.provider}
        onChange={(e) => onChange({ ...value, provider: e.target.value as 'resend' | 'cloudflare' })}
        title={t(locale, 'email.providerLabel')}
      >
        <option value="resend">Resend</option>
        <option value="cloudflare">Cloudflare</option>
      </select>
      {value.provider === 'resend' ? (
        <input
          className="input input-bordered input-sm w-full sm:flex-1"
          type="password"
          placeholder={t(locale, editing ? 'email.newApiKeyPlaceholder' : 'email.apiKeyPlaceholder')}
          value={value.apiKey}
          onChange={(e) => onChange({ ...value, apiKey: e.target.value })}
          required={!editing}
        />
      ) : (
        <>
          <select
            className="select select-bordered select-sm w-full sm:w-48"
            value={value.accountId}
            onChange={(e) => onChange({ ...value, accountId: e.target.value, cfAccountId: '' })}
            title={t(locale, 'email.accountLabel')}
            required
          >
            <option value="">{t(locale, 'email.accountLabel')}…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            className="select select-bordered select-sm w-full sm:w-56"
            value={value.cfAccountId}
            onChange={(e) => onChange({ ...value, cfAccountId: e.target.value })}
            title={t(locale, 'email.cfAccountLabel')}
            required
          >
            <option value="">{t(locale, 'email.cfAccountLabel')}…</option>
            {cfAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}

const EMPTY_FORM: DomainFormValue = { domain: '', provider: 'resend', apiKey: '', accountId: '', cfAccountId: '' };

function DomainsTab({
  locale,
  domains,
  onChanged,
}: {
  locale: Locale;
  domains: DomainItem[];
  onChanged: () => Promise<void>;
}) {
  const [form, setForm] = useState<DomainFormValue>(EMPTY_FORM);
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<DomainItem | null>(null);
  const [editForm, setEditForm] = useState<DomainFormValue>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();
  const confirm = useConfirm();
  const apiErrorText = useApiErrorText(locale);

  useEffect(() => {
    void fetch('/api/accounts?pageSize=100')
      .then((res) => (res.ok ? res.json() : { accounts: [] }))
      .then((data: { accounts: AccountItem[] }) => setAccounts(data.accounts))
      .catch(() => setAccounts([]));
  }, []);

  function domainBody(v: DomainFormValue): Record<string, unknown> {
    return v.provider === 'resend'
      ? { provider: 'resend', ...(v.apiKey.trim() ? { apiKey: v.apiKey.trim() } : {}) }
      : { provider: 'cloudflare', accountId: v.accountId, cfAccountId: v.cfAccountId };
  }

  async function addDomain(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch('/api/email/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: form.domain.trim(), ...domainBody(form) }),
      });
      if (res.ok) {
        setForm(EMPTY_FORM);
        showToast(t(locale, 'email.domainAdded'), 'success');
        await onChanged();
      } else {
        const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        showToast(apiErrorText(data), 'error');
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setBusy(false);
    }
  }

  function openEdit(d: DomainItem) {
    setEditForm({
      domain: d.domain,
      provider: d.provider,
      apiKey: '',
      accountId: d.accountId ?? '',
      cfAccountId: d.cfAccountId ?? '',
    });
    setEditing(d);
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/email/domains/${editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(domainBody(editForm)),
      });
      if (res.ok) {
        setEditing(null);
        showToast(t(locale, 'email.domainUpdated'), 'success');
        await onChanged();
      } else {
        const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        showToast(apiErrorText(data), 'error');
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function removeDomain(d: DomainItem) {
    const ok = await confirm({
      title: t(locale, 'email.confirmDeleteDomain', { domain: d.domain }),
      confirmLabel: t(locale, 'common.confirm'),
      cancelLabel: t(locale, 'common.cancel'),
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/email/domains/${d.id}`, { method: 'DELETE' });
      if (res.ok) {
        showToast(t(locale, 'email.domainDeleted'), 'success');
        await onChanged();
      } else {
        const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        showToast(apiErrorText(data), 'error');
      }
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={addDomain} className="card border border-base-300 bg-base-100 p-4">
        <fieldset className="fieldset">
          <legend className="fieldset-legend">{t(locale, 'email.addDomainTitle')}</legend>
          <DomainFields locale={locale} value={form} onChange={setForm} accounts={accounts} editing={false} />
          <div className="mt-2">
            <button className="btn btn-primary btn-sm whitespace-nowrap" disabled={busy} type="submit">
              <Plus size={14} strokeWidth={1.75} />
              {t(locale, 'email.add')}
            </button>
          </div>
        </fieldset>
      </form>

      <div className="card border border-base-300 bg-base-100 p-4">
        <h2 className="mb-3 font-semibold">{t(locale, 'email.domainsTitle')}</h2>
        {domains.length === 0 ? (
          <p className="py-8 text-center text-sm opacity-60">{t(locale, 'email.emptyDomains')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>{t(locale, 'email.colDomain')}</th>
                  <th>{t(locale, 'email.colProvider')}</th>
                  <th className="hidden sm:table-cell">{t(locale, 'email.colCredential')}</th>
                  <th className="hidden md:table-cell">{t(locale, 'email.colCreated')}</th>
                  <th>{t(locale, 'email.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {domains.map((d) => (
                  <tr key={d.id}>
                    <td className="font-mono">{d.domain}</td>
                    <td>
                      <span className="badge badge-ghost badge-sm shrink-0 whitespace-nowrap">{d.provider}</span>
                    </td>
                    <td className="hidden font-mono text-xs opacity-60 sm:table-cell">
                      {d.provider === 'resend' ? `sha256:${d.apiKeyHint ?? '—'}` : (d.cfAccountId ?? '—')}
                    </td>
                    <td className="hidden font-mono text-xs md:table-cell" title={d.createdAt}>
                      {relativeTime(d.createdAt, locale) || '—'}
                    </td>
                    <td className="space-x-2 whitespace-nowrap">
                      <button className="btn btn-xs whitespace-nowrap" onClick={() => openEdit(d)} type="button">
                        <Pencil size={14} strokeWidth={1.75} />
                        {t(locale, 'email.edit')}
                      </button>
                      <button
                        className="btn btn-error btn-xs whitespace-nowrap"
                        onClick={() => void removeDomain(d)}
                        type="button"
                      >
                        <Trash2 size={14} strokeWidth={1.75} />
                        {t(locale, 'email.delete')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <dialog open className="modal modal-open">
          <div className="modal-box max-w-2xl border border-base-300">
            <h3 className="mb-1 font-semibold">{t(locale, 'email.editDomainTitle')}</h3>
            <p className="mb-4 font-mono text-xs opacity-60">{editing.domain}</p>
            <form onSubmit={saveEdit} className="flex flex-col gap-3">
              <DomainFields locale={locale} value={editForm} onChange={setEditForm} accounts={accounts} editing />
              <div className="modal-action mt-2">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>
                  {t(locale, 'common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary btn-sm whitespace-nowrap" disabled={saving}>
                  {saving && <span className="loading loading-spinner loading-xs" />}
                  {t(locale, 'email.save')}
                </button>
              </div>
            </form>
          </div>
          <form method="dialog" className="modal-backdrop" onSubmit={() => setEditing(null)}>
            <button type="submit" aria-label={t(locale, 'common.cancel')} />
          </form>
        </dialog>
      )}
    </div>
  );
}

/* ---------------- 记录 tab ---------------- */

function LogTab({ locale }: { locale: Locale }) {
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<LogDetail | null>(null);
  const { showToast } = useToast();
  const apiErrorText = useApiErrorText(locale);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const reload = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      const res = await fetch(`/api/email/log?${params.toString()}`);
      if (!res.ok) return;
      const data = (await res.json()) as { logs: LogItem[]; total: number };
      setLogs(data.logs);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function openDetail(id: string) {
    try {
      const res = await fetch(`/api/email/log/${id}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        showToast(apiErrorText(data), 'error');
        return;
      }
      const data = (await res.json()) as { log: LogDetail };
      setDetail(data.log);
    } catch {
      showToast(t(locale, 'common.requestFailed'), 'error');
    }
  }

  return (
    <div className="card border border-base-300 bg-base-100 p-4">
      <h2 className="mb-3 font-semibold">{t(locale, 'email.logTitle')}</h2>
      {loading ? (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <tbody>
              {Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  <td>
                    <div className="skeleton h-8" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : total === 0 ? (
        <p className="py-8 text-center text-sm opacity-60">{t(locale, 'email.emptyLog')}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>{t(locale, 'email.colTime')}</th>
                  <th className="hidden sm:table-cell">{t(locale, 'email.colFrom')}</th>
                  <th className="hidden md:table-cell">{t(locale, 'email.colTo')}</th>
                  <th>{t(locale, 'email.colSubject')}</th>
                  <th>{t(locale, 'email.colStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr
                    key={log.id}
                    className="cursor-pointer hover:bg-base-200/60"
                    onClick={() => void openDetail(log.id)}
                  >
                    <td className="whitespace-nowrap font-mono text-xs" title={log.createdAt}>
                      {relativeTime(log.createdAt, locale) || '—'}
                    </td>
                    <td className="hidden font-mono text-xs sm:table-cell">{log.fromAddress}</td>
                    <td className="hidden font-mono text-xs md:table-cell">{log.recipients.to.join(', ')}</td>
                    <td>
                      <span className="block max-w-xs truncate">{log.subject}</span>
                    </td>
                    <td>
                      <span
                        className={`badge badge-sm shrink-0 whitespace-nowrap ${
                          log.status === 'sent' ? 'badge-success' : 'badge-error'
                        }`}
                      >
                        {t(locale, log.status === 'sent' ? 'email.statusSent' : 'email.statusFailed')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePagination
            locale={locale}
            total={total}
            page={page}
            pageCount={pageCount}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(n) => {
              setPage(1);
              setPageSize(n);
            }}
          />
        </>
      )}

      {detail && (
        <dialog open className="modal modal-open">
          <div className="modal-box max-w-3xl border border-base-300">
            <h3 className="mb-1 font-semibold">{t(locale, 'email.logDetailTitle')}</h3>
            <p className="mb-1 font-mono text-xs opacity-60">
              {detail.fromAddress} → {detail.recipients.to.join(', ')}
            </p>
            <p className="mb-3 min-w-0 break-all font-semibold text-sm">{detail.subject}</p>
            {detail.error && (
              <div className="alert alert-error mb-3 text-sm">
                <span className="min-w-0 break-all">
                  {t(locale, 'email.logError')}: {detail.error}
                </span>
              </div>
            )}
            <EmailPreview format={detail.format} content={detail.content} />
            {detail.messageId && (
              <p className="mt-2 font-mono text-xs opacity-60">Message ID: {detail.messageId}</p>
            )}
            <div className="modal-action">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDetail(null)}>
                {t(locale, 'common.cancel')}
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop" onSubmit={() => setDetail(null)}>
            <button type="submit" aria-label={t(locale, 'common.cancel')} />
          </form>
        </dialog>
      )}
    </div>
  );
}

/* ---------------- Panel ---------------- */

function EmailPanelInner({ locale, initialTab }: { locale: Locale; initialTab?: string | null }) {
  const [active, switchTab] = useDetailTab(TAB_KEYS, initialTab);
  const [domains, setDomains] = useState<DomainItem[]>([]);

  const reloadDomains = useCallback(async () => {
    try {
      const res = await fetch('/api/email/domains');
      if (!res.ok) return;
      const data = (await res.json()) as { domains: DomainItem[] };
      setDomains(data.domains);
    } catch {
      /* 列表加载失败时发送 tab 显示空态引导 */
    }
  }, []);

  useEffect(() => {
    void reloadDomains();
  }, [reloadDomains]);

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'send', label: t(locale, 'email.tabSend') },
    { key: 'domains', label: t(locale, 'email.tabDomains') },
    { key: 'log', label: t(locale, 'email.tabLog') },
  ];

  return (
    <div className="space-y-4">
      <h1 className="min-w-0 flex-1 truncate font-semibold text-xl">{t(locale, 'email.pageTitle')}</h1>
      <DetailTabs tabs={tabs} active={active} onChange={(key) => switchTab(key as TabKey)} />
      {active === 'send' && <SendTab locale={locale} domains={domains} />}
      {active === 'domains' && <DomainsTab locale={locale} domains={domains} onChanged={reloadDomains} />}
      {active === 'log' && <LogTab locale={locale} />}
    </div>
  );
}

export default function EmailPanel({ locale, initialTab }: { locale: Locale; initialTab?: string | null }) {
  return (
    <ToastProvider>
      <ConfirmDialogProvider>
        <EmailPanelInner locale={locale} initialTab={initialTab} />
      </ConfirmDialogProvider>
    </ToastProvider>
  );
}
```

实现时的两处对齐检查（写代码前先看现有源码，以现状为准）：
1. `ConfirmDialog` 的 `confirm({...})` 参数名（`title`/`confirmLabel`/`cancelLabel`）以 `src/components/ui/ConfirmDialog.tsx` 实际签名为准。
2. `TablePagination` 的 props（`locale/total/page/pageCount/pageSize/onPageChange/onPageSizeChange`）以 `src/components/ui/TablePagination.tsx` 为准（AccountsPanel 的用法即模板）。

- [ ] **Step 2: 页面（zh + en）**

创建 `src/pages/email.astro` 与 `src/pages/en/email.astro`，内容完全相同（locale 由路径推导）：

```astro
---
import EmailPanel from '@/components/EmailPanel';
import { t } from '@/i18n';
import { localeFromPath } from '@/i18n/routing';
import MainLayout from '@/layouts/MainLayout.astro';
const locale = localeFromPath(Astro.url.pathname);
// 服务端读 ?tab= 传入 initialTab：SSR 与首次 hydration 一致，防 mismatch
const initialTab = Astro.url.searchParams.get('tab');
---
<MainLayout title={t(locale, 'email.pageTitle')} locale={locale}>
  <EmailPanel client:load locale={locale} initialTab={initialTab} />
</MainLayout>
```

- [ ] **Step 3: 校验**

Run: `pnpm run check && pnpm run typecheck && pnpm run test`
Expected: 全部 PASS

- [ ] **Step 4: 开发环境手动验证**

`npm run dev` 后逐项检查：
- `/email` 与 `/en/email` 可打开，导航高亮「邮件」
- 域名 tab：添加 resend 域名（凭证列只显示 hash 前缀）；添加 cloudflare 域名时两级下拉联动
- 发送 tab：域名下拉带出 `@域名` 后缀；三格式切换；编辑/预览切换（markdown 预览渲染、html 装 iframe、text 走 pre；预览中输入 `<script>alert(1)</script>` 不执行）
- 记录 tab：发送后出现记录，点行弹详情、正文回显
- 500px 视口：`document.scrollingElement.scrollWidth === window.innerWidth`（三个 tab 都查）；1440px 桌面回归

- [ ] **Step 5: 提交**

```bash
git add src/components/EmailPanel.tsx src/pages/email.astro src/pages/en/email.astro
git commit -m "feat: add email panel UI (compose, domains, log)"
```

---

### Task 15: 收尾验证

**Files:** 无新文件（必要时修复上游任务遗留问题）

- [ ] **Step 1: 全量门禁**

```bash
pnpm run check:ci && pnpm run typecheck && pnpm run test
```

Expected: 三项全 PASS（Biome 无 diff、tsc/astro check 无错、全部单测通过）

- [ ] **Step 2: 真实构建验证（workerd）**

```bash
npm run build && npm run preview
```

在 preview（workerd 运行时）里访问 `/email`：确认页面渲染、域名 CRUD 正常；若有真实 Resend key / 带 Email Sending 权限的 CF token，各发一封真实邮件验证（Node 单测覆盖不到 workerd 的 fetch 绑定行为）。缺权限的 CF token 应得到 403 toast（`email.errScopeMissing`），且其他页面只读功能不受影响。

- [ ] **Step 3: 提交遗留修复（如有）并结束**

```bash
git status   # 应为 clean；有修复则按 conventional commits 单独提交
```

---

## Self-Review 结论（已按此修订）

1. **Spec 覆盖**：数据模型（Task 1）、服务层含渲染/双 provider/CfClient 扩展（Task 4–7）、全部 API 路由（Task 8–11）、UI 三 tab + 预览 + i18n + 移动端（Task 12–14）、错误处理（403 稳定 code、失败写 log、400 不写 log，Task 7/9）、测试矩阵（spec 的 4 个测试文件拆成 7 个，覆盖同集合）、`npm run preview` 人工验证（Task 15）。规格的「cf_account_id 单列 FK」按计划头部说明修正为 `account_id`(FK) + `cf_account_id`(CF 侧 id) 双列，并新增 Task 11 端点支撑 UI。
2. **占位符扫描**：无 TBD/TODO；所有代码步骤给出完整代码；仅 Task 14 留了两处「以现有源码为准」的核对提示（ConfirmDialog/TablePagination 的既有签名），属于对既有代码的引用而非留白。
3. **类型一致性**：`EmailDomainRow/EmailDomainPublic`（Task 2）↔ 路由（Task 8）↔ UI `DomainItem`（Task 14）字段一致；`SendResult/EmailMessage/ProviderSendParams`（Task 4）贯穿 Task 6/7/9；`sendEmail` 服务签名（Task 7）与路由调用（Task 9）一致；`CfClient.sendEmail` 返回 `{ messageId }`（Task 5）与 `sendViaCloudflare`（Task 6）对齐。

