# 邮件「域名」tab 增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给邮件「域名」tab 加两处能力——发送域名列表服务端分页，以及添加表单的域名输入改成从 Cloudflare zones 模糊搜索的可编辑下拉（自由输入仍允许）。

**Architecture:** 后端 `listEmailDomains` 加分页（镜像 `listAccounts`），`GET /api/email/domains` 加 `page/pageSize` 返回 `{domains,total,page,pageSize}`；前端新增可复用 `SearchableCombobox`（自建 daisyUI，防抖拉 `/api/zones?search=`），`EmailPanel` 把发送 tab 的域名下拉与 DomainsTab 表格拆成两个数据通道（下拉拉 `?pageSize=100` 全量，表格自管分页挂 `TablePagination`）。

**Tech Stack:** Astro 5 SSR + React 19 islands、D1 (SQLite)、既有 `/api/zones` 服务端模糊搜索、`TablePagination` 复用组件、Vitest + better-sqlite3 测试替身。

**规格来源:** `docs/superpowers/specs/2026-07-15-email-domains-tab-enhancements-design.md`

## Global Constraints

- 导入一律用路径别名：`@/*` → `src/*`，`@tests/*` → `tests/*`；同目录 `./` 可用；禁止 `../`。
- 所有用户数据查询按 `owner_email = ?` 过滤（本次涉及的 `listEmailDomains` 与复用的 `/api/zones` 均已带）。
- Cloudflare API 只经 `CfClient`；本次不新增任何 CF 调用（zones 走已有缓存读端点）。
- 凭证永不返回：`GET /api/email/domains` 仍只回 `toPublic`（`apiKeyHint` = hash 前 8 位），分页改造不得改变这一点。
- 新用户可见字符串进 `src/i18n/index.ts` 的 zh 与 en 两表（键集必须一致，`Record<MessageKey,string>` 静态检查）。
- 移动端规则：combobox 输入 `w-full sm:w-56` + `max-w-full`，下拉面板 `w-full max-h-60 overflow-y-auto`；表格保持 `overflow-x-auto` + 次要列 `hidden sm:table-cell`/`hidden md:table-cell`；500px 视口 `document.scrollingElement.scrollWidth === window.innerWidth`。
- 测试在 Node 下跑（`createTestDb()` 执行真实迁移）；combobox 属 UI 无单测，用 `npm run preview` + 浏览器真机验收。
- 每个任务收尾：`pnpm exec vitest run <file>`（单文件）；提交前 `pnpm run check`（Biome 自动修复）+ `pnpm run typecheck`。统一用 `pnpm exec` / `pnpm run`。
- 提交信息用 Conventional Commits，末行 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

## File Structure

```
src/server/db/emailDomains.ts            修改  listEmailDomains 加分页，返回 {domains,total}
src/pages/api/email/domains/index.ts     修改  GET 加 page/pageSize，返回 {domains,total,page,pageSize}
src/components/ui/SearchableCombobox.tsx 新建  可复用可搜索下拉（防抖 fetchOptions + 键盘导航 + 外部点击关闭）
src/components/EmailPanel.tsx            修改  DomainsTab 分页 + 域名字段用 combobox；SendTab/panel 拉全量 ?pageSize=100
src/i18n/index.ts                        修改  combobox 两条文案（zh+en）
tests/unit/email-domains-repo.test.ts    修改  listEmailDomains 分页 + total 断言（含更新既有 roundtrip 用例）
tests/unit/email-domains-api.test.ts     修改  GET 分页元数据 + clamp + ?pageSize=100 全量断言
```

任务顺序：Task 1（repo 分页）→ Task 2（route 分页）→ Task 3（SearchableCombobox 组件）→ Task 4（i18n）→ Task 5（EmailPanel 接线：分页 + combobox）→ Task 6（收尾真机验收）。Task 1→2 有依赖（同函数契约）；Task 3、4 相互独立、也独立于 1/2；Task 5 依赖 2/3/4；Task 6 收尾。

---

### Task 1: `listEmailDomains` 服务端分页

**Files:**
- Modify: `src/server/db/emailDomains.ts:75-81`
- Test: `tests/unit/email-domains-repo.test.ts`

**Interfaces:**
- Consumes: 现有 `email_domains` 表、`EmailDomainRow`、`Db`。
- Produces（后续任务按此调用）:
  - `interface EmailDomainPage { domains: EmailDomainRow[]; total: number }`
  - `listEmailDomains(db, ownerEmail, opts?: { page?: number; pageSize?: number }): Promise<EmailDomainPage>`（`page` 默认 1、下限 1；`pageSize` 默认 20、范围 1..100；`ORDER BY created_at`）

- [ ] **Step 1: 更新既有 roundtrip 用例 + 加分页用例（先让测试反映新契约）**

编辑 `tests/unit/email-domains-repo.test.ts`：把第 111-112 行的旧断言

```ts
    const aliceRows = await listEmailDomains(db, ALICE);
    expect(aliceRows.map((r) => r.id)).toEqual(['d1']);
```

改为

```ts
    const alicePage = await listEmailDomains(db, ALICE);
    expect(alicePage.total).toBe(1);
    expect(alicePage.domains.map((r) => r.id)).toEqual(['d1']);
```

并在 `describe('emailDomains repo', () => {` 块内追加一个分页用例（`resendInput` helper 已在该文件定义）：

```ts
  it('paginates listEmailDomains and reports total scoped by owner_email', async () => {
    const db = createTestDb();
    for (let i = 1; i <= 5; i++) {
      await insertEmailDomain(db, resendInput(`d${i}`, `d${i}.example.com`));
    }
    await insertEmailDomain(db, resendInput('b1', 'bob.example.com', BOB));

    const page1 = await listEmailDomains(db, ALICE, { page: 1, pageSize: 2 });
    expect(page1.total).toBe(5); // 只算 ALICE，不含 BOB
    expect(page1.domains).toHaveLength(2);
    expect(page1.domains.map((r) => r.id)).toEqual(['d1', 'd2']); // ORDER BY created_at

    const page3 = await listEmailDomains(db, ALICE, { page: 3, pageSize: 2 });
    expect(page3.domains.map((r) => r.id)).toEqual(['d5']);

    // pageSize 超上限被 clamp 到 100（一页取回全部 5 条）
    const big = await listEmailDomains(db, ALICE, { page: 1, pageSize: 999 });
    expect(big.domains).toHaveLength(5);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run tests/unit/email-domains-repo.test.ts`
Expected: FAIL —— 既有 roundtrip 用例与新分页用例都报 `total`/`domains` 在 `EmailDomainRow[]` 上不存在（旧实现返回数组）。

- [ ] **Step 3: 实现分页（镜像 listAccounts）**

把 `src/server/db/emailDomains.ts` 的 `listEmailDomains`（第 75-81 行）替换为：

```ts
export interface EmailDomainPage {
  domains: EmailDomainRow[];
  total: number;
}

export async function listEmailDomains(
  db: Db,
  ownerEmail: string,
  opts?: { page?: number; pageSize?: number },
): Promise<EmailDomainPage> {
  const page = Math.max(1, opts?.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts?.pageSize ?? 20));

  const countRow = await db
    .prepare('SELECT COUNT(*) AS cnt FROM email_domains WHERE owner_email = ?')
    .bind(ownerEmail)
    .first<{ cnt: number }>();
  const total = countRow?.cnt ?? 0;

  const { results } = await db
    .prepare('SELECT * FROM email_domains WHERE owner_email = ? ORDER BY created_at LIMIT ? OFFSET ?')
    .bind(ownerEmail, pageSize, (page - 1) * pageSize)
    .all<EmailDomainRow>();
  return { domains: results, total };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run tests/unit/email-domains-repo.test.ts`
Expected: PASS（含更新后的 roundtrip 用例与新分页用例）

- [ ] **Step 5: 提交**

```bash
git add src/server/db/emailDomains.ts tests/unit/email-domains-repo.test.ts
git commit -m "feat: paginate listEmailDomains repository query"
```

---

### Task 2: `GET /api/email/domains` 分页

**Files:**
- Modify: `src/pages/api/email/domains/index.ts:28-31`
- Test: `tests/unit/email-domains-api.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `listEmailDomains(db, userEmail, {page,pageSize}) → {domains,total}`；现有 `toPublic`。
- Produces: `GET /api/email/domains?page=&pageSize=` → `{ domains: EmailDomainPublic[]; total: number; page: number; pageSize: number }`（默认 pageSize 20、上限 100；非法值回退默认；`?pageSize=100` 可取回全量供发送下拉）。

- [ ] **Step 1: 先看现状**

Read `src/pages/api/email/domains/index.ts` 的 `GET`（约第 28-31 行）：

```ts
export const GET: APIRoute = async ({ locals }) => {
  const { db, userEmail } = await appContext(locals);
  const rows = await listEmailDomains(db, userEmail);
  return Response.json({ domains: rows.map(toPublic) });
};
```

- [ ] **Step 2: 让 `ctx()` helper 支持 query 字符串**

打开 `tests/unit/email-domains-api.test.ts`，找到 `ctx()` helper（构造 `new Request('http://localhost/api/email/domains', …)`）。给 `opts` 增加可选 `query`，拼到 URL：

```ts
function ctx(db: unknown, opts: { method?: string; body?: unknown; userEmail?: string; id?: string; query?: string } = {}) {
  const url = `http://localhost/api/email/domains${opts.query ?? ''}`;
  return {
    locals: { userEmail: opts.userEmail ?? ALICE, runtime: { env: { DB: db, ENCRYPTION_KEY: HEX_KEY } } },
    request: new Request(url, {
      method: opts.method ?? 'GET',
      ...(opts.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) } : {}),
    }),
    params: opts.id ? { id: opts.id } : {},
  } as unknown as Parameters<typeof POST>[0];
}
```

（只加 `query` 字段与 `url` 拼接，其余保持不变——现有用例传的 `opts` 不含 `query`，行为不变。）

- [ ] **Step 3: 写真实分页断言**

在 `tests/unit/email-domains-api.test.ts` 末尾追加：

```ts
describe('GET /api/email/domains pagination', () => {
  it('returns paging metadata and paginates', async () => {
    const db = createTestDb();
    for (let i = 1; i <= 3; i++) await createResendDomain(db, `d${i}.example.com`);

    const res = await GET(ctx(db, { query: '?page=1&pageSize=2' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domains: unknown[]; total: number; page: number; pageSize: number };
    expect(body).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(body.domains).toHaveLength(2);
  });

  it('clamps invalid page/pageSize to defaults', async () => {
    const db = createTestDb();
    await createResendDomain(db, 'only.example.com');
    const res = await GET(ctx(db, { query: '?page=0&pageSize=-5' }));
    const body = (await res.json()) as { page: number; pageSize: number; total: number };
    expect(body).toMatchObject({ page: 1, pageSize: 20, total: 1 });
  });

  it('pageSize=100 returns the full list for the send dropdown', async () => {
    const db = createTestDb();
    for (let i = 1; i <= 5; i++) await createResendDomain(db, `d${i}.example.com`);
    const res = await GET(ctx(db, { query: '?pageSize=100' }));
    const body = (await res.json()) as { domains: unknown[]; total: number };
    expect(body.domains).toHaveLength(5);
    expect(body.total).toBe(5);
  });

  it('still never leaks credentials in the list', async () => {
    const db = createTestDb();
    await createResendDomain(db, 'secret.example.com');
    const text = await (await GET(ctx(db, { query: '?page=1&pageSize=20' }))).text();
    expect(text).toContain('"apiKeyHint"');
    expect(text).not.toContain('re_key_1');
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm exec vitest run tests/unit/email-domains-api.test.ts`
Expected: FAIL —— 新用例期望 `total/page/pageSize`，而现有 `GET` 只回 `{domains}`。既有用例仍应通过（helper 改动向后兼容）。

- [ ] **Step 5: 实现路由分页（镜像 /api/email/log 与 /api/accounts）**

把 `src/pages/api/email/domains/index.ts` 的 `GET` 替换为：

```ts
export const GET: APIRoute = async ({ locals, request }) => {
  const { db, userEmail } = await appContext(locals);
  const url = new URL(request.url);
  const rawPage = parseInt(url.searchParams.get('page') ?? '1', 10);
  const rawPageSize = parseInt(url.searchParams.get('pageSize') ?? '20', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1 ? Math.min(100, rawPageSize) : 20;
  const { domains, total } = await listEmailDomains(db, userEmail, { page, pageSize });
  return Response.json({ domains: domains.map(toPublic), total, page, pageSize });
};
```

（`GET` 签名从 `({ locals })` 改为 `({ locals, request })`。POST 不变。）

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm exec vitest run tests/unit/email-domains-api.test.ts`
Expected: PASS（新分页用例 + 既有全部用例）

- [ ] **Step 7: 提交**

```bash
git add src/pages/api/email/domains/index.ts tests/unit/email-domains-api.test.ts
git commit -m "feat: paginate the email domains list endpoint"
```

---

### Task 3: `SearchableCombobox` 组件

**Files:**
- Create: `src/components/ui/SearchableCombobox.tsx`

**Interfaces:**
- Consumes: 无（纯前端；`fetchOptions` 由调用方注入）。
- Produces:
  - `SearchableCombobox(props: { value: string; onChange: (v: string) => void; fetchOptions: (query: string) => Promise<string[]>; placeholder?: string; noMatchLabel?: string; disabled?: boolean; className?: string })` 默认导出。
  - 行为契约（Task 5 依赖）：输入即 `value`（始终可自由输入）；输入变化 300ms 防抖后调 `fetchOptions(value)`，结果列进下拉；↑/↓ 移高亮、Enter 选中、Esc 关闭、点击外部关闭；选项点击 → `onChange(option)` 且关闭。

- [ ] **Step 1: 实现组件（无单测，属 UI；类型 + lint 为门禁）**

创建 `src/components/ui/SearchableCombobox.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react';

/**
 * 可搜索可编辑下拉：输入框始终可自由输入（value 即输入原文），
 * 输入变化 300ms 防抖后调 fetchOptions(query) 拉候选并列进下拉面板。
 * 选建议只是把值填进输入框。键盘 ↑/↓/Enter/Esc + 外部点击关闭。
 * 数据源由调用方经 fetchOptions 注入（域名场景传「拉 zones 名」）。
 */
export default function SearchableCombobox({
  value,
  onChange,
  fetchOptions,
  placeholder,
  noMatchLabel,
  disabled,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  fetchOptions: (query: string) => Promise<string[]>;
  placeholder?: string;
  noMatchLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<string[]>([]);
  const [highlight, setHighlight] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);

  // 输入变化 → 300ms 防抖拉候选（打开时才拉，避免无谓请求）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void fetchOptions(value)
        .then((opts) => {
          if (!cancelled) {
            setOptions(opts);
            setHighlight(-1);
          }
        })
        .catch(() => {
          if (!cancelled) setOptions([]);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, open, fetchOptions]);

  // 点击组件外部 → 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function select(option: string) {
    onChange(option);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      setHighlight((h) => Math.min(h + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && highlight >= 0 && highlight < options.length) {
        e.preventDefault();
        select(options[highlight]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className={`relative ${className ?? ''}`}>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        className="input input-bordered input-sm w-full max-w-full"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && !disabled && (
        <ul
          role="listbox"
          className="menu absolute z-20 mt-1 max-h-60 w-full flex-nowrap overflow-y-auto rounded-box border border-base-300 bg-base-100 p-1 shadow"
        >
          {options.length === 0 ? (
            <li className="pointer-events-none px-3 py-2 text-sm opacity-50">{noMatchLabel}</li>
          ) : (
            options.map((opt, i) => (
              <li key={opt}>
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: 键盘交互由 input 的 onKeyDown 统一处理 */}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === highlight}
                  className={`justify-start font-mono text-sm ${i === highlight ? 'active' : ''}`}
                  // onMouseDown 而非 onClick：抢在 input blur 之前触发，避免面板先被关掉
                  onMouseDown={(e) => {
                    e.preventDefault();
                    select(opt);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                >
                  {opt}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 门禁校验**

Run: `pnpm run check && pnpm run typecheck`
Expected: PASS（0 error；若 Biome 对 `biome-ignore` 注释位置有要求，按其提示微调，保持 lint 干净）

- [ ] **Step 3: 提交**

```bash
git add src/components/ui/SearchableCombobox.tsx
git commit -m "feat: add searchable combobox component"
```

---

### Task 4: combobox i18n 文案

**Files:**
- Modify: `src/i18n/index.ts`（zh 表 `} as const;` 前、en 表 `};` 前各加两行；建议插在既有 `'email.domainPlaceholder'` 附近）

**Interfaces:**
- Produces: `MessageKey` 新增 `email.domainSearchPlaceholder`、`email.domainNoMatch`（zh/en 两表键集必须一致，`Record<MessageKey,string>` 会静态检查漏键）。

- [ ] **Step 1: zh 表追加（插在 `'email.domainPlaceholder': …,` 行之后）**

```ts
  'email.domainSearchPlaceholder': '域名（输入可搜索已同步的 Zone）',
  'email.domainNoMatch': '无匹配域名，可直接输入',
```

- [ ] **Step 2: en 表追加（插在 `'email.domainPlaceholder': …,` 行之后）**

```ts
  'email.domainSearchPlaceholder': 'Domain (type to search your zones)',
  'email.domainNoMatch': 'No matching zone — you can type any domain',
```

- [ ] **Step 3: 校验键集一致**

Run: `pnpm run typecheck && pnpm exec vitest run tests/unit/i18n.test.ts`
Expected: PASS（漏键会在 `Record<MessageKey,string>` 处报错）

- [ ] **Step 4: 提交**

```bash
git add src/i18n/index.ts
git commit -m "feat: add i18n strings for domain search combobox"
```

---

### Task 5: EmailPanel 接线（列表分页 + 域名 combobox）

**Files:**
- Modify: `src/components/EmailPanel.tsx`

**Interfaces:**
- Consumes: Task 2 `GET /api/email/domains?page=&pageSize=` → `{domains,total,page,pageSize}`；Task 3 `SearchableCombobox`；Task 4 i18n 键；现有 `TablePagination`、`/api/zones?search=`。
- Produces: 无（UI 终点）。

本任务改四处，按顺序做：

- [ ] **Step 1: 加导入 + 注入用的 zone 拉取函数**

在 `src/components/EmailPanel.tsx` 顶部导入区（第 8 行 `import EmailPreview …` 附近）加：

```tsx
import SearchableCombobox from './ui/SearchableCombobox';
```

在文件的 `splitEmails` helper 附近（模块级，`function useApiErrorText` 之前）加一个模块级函数：

```tsx
/** 域名 combobox 的候选源：当前用户已同步的 Cloudflare zones 名（去重）。zones 未同步则空。 */
async function fetchZoneNames(query: string): Promise<string[]> {
  const params = new URLSearchParams({ search: query, pageSize: '20' });
  const res = await fetch(`/api/zones?${params.toString()}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { zones: { name: string }[] };
  return [...new Set(data.zones.map((z) => z.name))];
}
```

- [ ] **Step 2: `DomainFields` 的域名字段——添加态用 combobox，编辑态保持只读输入**

把 `DomainFields`（第 316-324 行）里的域名 `<input>`：

```tsx
      <input
        className="input input-bordered input-sm w-full sm:w-56"
        placeholder={t(locale, 'email.domainPlaceholder')}
        value={value.domain}
        onChange={(e) => onChange({ ...value, domain: e.target.value })}
        disabled={editing}
        required={!editing}
      />
```

替换为（编辑态 domain 只读，沿用现状；添加态换成可搜索 combobox）：

```tsx
      {editing ? (
        <input
          className="input input-bordered input-sm w-full sm:w-56"
          placeholder={t(locale, 'email.domainPlaceholder')}
          value={value.domain}
          disabled
        />
      ) : (
        <SearchableCombobox
          className="w-full sm:w-56"
          value={value.domain}
          onChange={(domain) => onChange({ ...value, domain })}
          fetchOptions={fetchZoneNames}
          placeholder={t(locale, 'email.domainSearchPlaceholder')}
          noMatchLabel={t(locale, 'email.domainNoMatch')}
        />
      )}
```

（注意：添加态不再有原生 `required`——空域名由 POST 后端 `invalidDomain` 校验兜底，与既有错误提示一致。）

- [ ] **Step 3: `DomainsTab` 表格自管分页**

`DomainsTab`（第 381-585 行）改造。首先把签名去掉对 `domains` 的依赖，改为自管分页状态。将其 props 与开头 state（第 381-398 行）替换为：

```tsx
function DomainsTab({
  locale,
  onChanged,
}: {
  locale: Locale;
  onChanged: () => Promise<void>;
}) {
  const [domains, setDomains] = useState<DomainItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [form, setForm] = useState<DomainFormValue>(EMPTY_FORM);
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<DomainItem | null>(null);
  const [editForm, setEditForm] = useState<DomainFormValue>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();
  const confirm = useConfirm();
  const apiErrorText = useApiErrorText(locale);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const reload = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      const res = await fetch(`/api/email/domains?${params.toString()}`);
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      setLoadError(false);
      const data = (await res.json()) as { domains: DomainItem[]; total: number };
      if (data.domains.length === 0 && data.total > 0 && page > 1) {
        setPage(1);
        return;
      }
      setDomains(data.domains);
      setTotal(data.total);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize]);

  useEffect(() => {
    void reload();
  }, [reload]);
```

然后：本地的 `onChanged`（增删改后刷新）现在需要同时刷新本页与面板发送下拉。把 `addDomain`/`saveEdit`/`removeDomain` 里三处 `await onChanged();` 都替换为：

```ts
        await reload();
        await onChanged();
```

（`reload` 刷新本页表格；`onChanged` 刷新面板持有的发送下拉全量。三处调用点分别在第 425、461、484 行附近的 `if (res.ok) { … }` 内。）

- [ ] **Step 4: `DomainsTab` 渲染——loading/错误/空态 + 分页条**

把表格所在卡片（第 509-558 行的整个 `<div className="card …">…</div>`）替换为带 loading/错误/空态与分页的版本：

```tsx
      <div className="card border border-base-300 bg-base-100 p-4">
        <h2 className="mb-3 font-semibold">{t(locale, 'email.domainsTitle')}</h2>
        {loading ? (
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <tbody>
                {Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i}>
                    <td>
                      <div className="skeleton h-8" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : loadError ? (
          <div className="alert alert-error flex items-center gap-3">
            <span className="text-sm">{t(locale, 'common.requestFailed')}</span>
            <button className="btn btn-sm btn-ghost" onClick={() => void reload()}>
              {t(locale, 'common.retry')}
            </button>
          </div>
        ) : total === 0 ? (
          <p className="py-8 text-center text-sm opacity-60">{t(locale, 'email.emptyDomains')}</p>
        ) : (
          <>
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
      </div>
```

- [ ] **Step 5: 面板接线——发送下拉拉全量，DomainsTab 不再收 `domains`**

改 `EmailPanelInner`（第 743-777 行）：`reloadDomains` 拉全量 `?pageSize=100`，`DomainsTab` 去掉 `domains` prop。

把 `reloadDomains`（第 747-756 行）替换为：

```tsx
  const reloadDomains = useCallback(async () => {
    try {
      const res = await fetch('/api/email/domains?pageSize=100');
      if (!res.ok) return;
      const data = (await res.json()) as { domains: DomainItem[] };
      setDomains(data.domains);
    } catch {
      /* 列表加载失败时发送 tab 显示空态引导 */
    }
  }, []);
```

把第 773 行

```tsx
      {active === 'domains' && <DomainsTab locale={locale} domains={domains} onChanged={reloadDomains} />}
```

替换为

```tsx
      {active === 'domains' && <DomainsTab locale={locale} onChanged={reloadDomains} />}
```

（`SendTab` 仍收 `domains`（全量）作下拉与空态判断，不变。）

- [ ] **Step 6: 门禁 + 跑全量测试**

Run: `pnpm run check && pnpm run typecheck && pnpm run test`
Expected: 全部 PASS（Biome 无 diff、tsc/astro check 0 error、全部单测通过——含 Task 1/2 新增用例）

- [ ] **Step 7: 提交**

```bash
git add src/components/EmailPanel.tsx
git commit -m "feat: paginate domains list and add searchable domain input"
```

---

### Task 6: 收尾真机验收（workerd + 浏览器）

**Files:** 无新文件（必要时修复上游遗留）

- [ ] **Step 1: 全量门禁**

```bash
pnpm run check:ci && pnpm run typecheck && pnpm run test
```

Expected: 三项全 PASS

- [ ] **Step 2: 真实构建 + 预览**

```bash
npm run build && npm run preview
```

在 preview（workerd）里 `/email?tab=domains` 逐项验收：
- 域名输入框聚焦/输入时出现下拉；输入片段能模糊命中已同步 zones；无 zones/无匹配时显示灰字提示但仍可自由输入；↑/↓ 移高亮、Enter 选中、Esc 关闭、点击外部关闭；选中把域名填进输入框。
- 发送域名列表底部有分页条：改每页条数、翻页正常；添加/删除后本页与「发送」tab 的域名下拉都刷新；删到当前页空能回退第 1 页。
- 「发送」tab 域名下拉仍列出全部已配置域名（拉 `?pageSize=100`）。
- 500px 视口：`document.scrollingElement.scrollWidth === window.innerWidth`（域名 tab 含下拉展开时）；1440px 桌面回归无异常；中英双页（`/email`、`/en/email`）文案正确。

- [ ] **Step 3: 提交遗留修复（如有）**

```bash
git status   # 应 clean；有修复按 conventional commits 单独提交
```

---

## Self-Review 结论

1. **Spec 覆盖**：可搜索下拉（Task 3 组件 + Task 5 接线 + Task 4 文案，复用 `/api/zones`、可自由输入、无匹配提示、仅添加表单、编辑态只读）；服务端分页（Task 1 repo + Task 2 route + Task 5 DomainsTab 自管分页 + 发送下拉拉全量）；i18n（Task 4）；测试（Task 1/2 扩 repo+api）；移动端与真机验收（Task 6）。spec 的「不在本次范围」项（表格搜索框、按 provider 过滤、自动同步 zones）均未引入。
2. **占位符扫描**：无 TBD/TODO；所有代码步骤给出完整可执行代码（Task 2 先改 `ctx()` helper 支持 query，再写分页断言，无占位块）。
3. **类型一致性**：`EmailDomainPage {domains,total}`（Task 1）↔ 路由解构 `{domains,total}`（Task 2）↔ 前端 `{domains,total}`（Task 5）一致；`SearchableCombobox` props（Task 3）↔ 调用（Task 5）一致；`fetchZoneNames: (q)=>Promise<string[]>`（Task 5）契合 combobox 的 `fetchOptions`（Task 3）；i18n 键 `email.domainSearchPlaceholder`/`email.domainNoMatch`（Task 4）↔ 使用处（Task 5）一致。
