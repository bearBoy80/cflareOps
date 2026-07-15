# 邮件「域名」tab 增强设计

日期：2026-07-15
状态：待用户审阅

## 目标

给邮件功能「域名」tab 两处增强（用户从真机截图提出）：

1. **「发送域名」已配置列表增加分页** —— 与账号页/Zones 页一致的服务端分页体验。
2. **「添加发送域名」表单的域名输入框改成可搜索下拉** —— 候选项从当前用户已同步的 Cloudflare zones 里模糊搜索获取，同时**仍可自由输入**不在列表里的域名。

已与用户确认的决策：
- 下拉数据源 = 当前用户的 **Cloudflare zones**（Zones 页那些域名）；**可编辑 + 自由输入**（Resend 发送域名不一定是 CF zone，zones 也可能还没同步，不能只能选）。
- 分页 = **服务端分页**，对齐账号页（`TablePagination` + 总数 + 每页条数下拉）。
- 下拉组件 = **自建 daisyUI combobox**（键盘导航 + 外部点击关闭），非原生 datalist。

## 一、可搜索域名下拉（`src/components/ui/SearchableCombobox.tsx`，新建）

**为什么自建而非原生 datalist**：用户明确要一致的外观与键盘交互；datalist 下拉样式由浏览器控制、无法 daisyUI 化。自建组件可复用（未来别处也可能要域名/名称联想）。

**为什么复用 `/api/zones` 而不新增后端**：`GET /api/zones?search=&page=&pageSize=`（`src/pages/api/zones/index.ts`）已支持服务端模糊搜索（`z.name LIKE`，owner_email 隔离），返回 `{zones:[{name,…}], total, page, pageSize}`。zone 名即域名，天然就是「从域名里获取」的来源，零新增后端。

组件契约：
```
SearchableCombobox({
  value: string,
  onChange: (v: string) => void,
  placeholder?: string,
  disabled?: boolean,
  fetchOptions: (query: string) => Promise<string[]>,   // 由调用方注入，域名场景传「拉 zones 名」
  noMatchLabel?: string,                                 // 无匹配/未同步时的灰字提示
  className?: string,
})
```
行为：
- 输入框始终是可编辑文本，`value` 即输入原文 —— **自由输入永远允许**，选建议只是把域名填进输入框。
- 输入变化 **300ms 防抖**（对齐 `AccountsPanel` 搜索防抖）后调 `fetchOptions(query)`；结果**按域名去重**后列进下拉面板。空 query 也拉一页（展示前若干个 zone 作为初始建议）。
- 下拉面板：daisyUI `menu` 风格，`role="listbox"`，选项 `role="option"`；键盘 ↑/↓ 移动高亮、Enter 选中高亮项、Esc 关闭；聚焦/输入时打开，**点击组件外部关闭**（`mousedown` 监听 + ref 判断），选中或 Esc 后关闭。
- 无匹配或 `fetchOptions` 返回空：面板显示 `noMatchLabel` 灰字（如「无匹配域名，可直接输入 / 请先在 Zones 页同步」），**不挡输入**。
- `fetchOptions` 抛错：吞掉，建议列表按空处理（不弹 toast，非关键路径）。

域名场景的注入实现（在 `EmailPanel` 里）：
```ts
async function fetchZoneNames(query: string): Promise<string[]> {
  const params = new URLSearchParams({ search: query, pageSize: '20' });
  const res = await fetch(`/api/zones?${params}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { zones: { name: string }[] };
  return [...new Set(data.zones.map((z) => z.name))];
}
```

用在何处：
- **仅「添加发送域名」表单的域名字段**（`DomainFields` 中 `!editing` 分支的域名输入替换为 `SearchableCombobox`）。
- **编辑弹窗不变**：域名在编辑态本来就 `disabled`（沿用现状），保持只读普通输入。
- 建议**不按 provider/账号过滤**：域名是表单第一个字段，此时 provider/账号往往还没选；且用户要的是「从我管理的域名里挑」，全量 zones 建议即可，避免多余耦合。

## 二、发送域名列表服务端分页

**为什么服务端分页**：与账号页/Zones 页/记录 tab 完全一致的分页 UX（总数、每页条数下拉、上/下页），`TablePagination` 直接复用；避免一次性加载全部再前端切片带来的行为不一致（无服务端总数/搜索）。

### 后端

`src/server/db/emailDomains.ts` —— `listEmailDomains` 加分页，镜像 `listAccounts`：
```ts
export interface EmailDomainPage {
  domains: EmailDomainRow[];
  total: number;
}
export async function listEmailDomains(
  db: Db,
  ownerEmail: string,
  opts?: { page?: number; pageSize?: number },
): Promise<EmailDomainPage>;
```
- `page = max(1, opts.page ?? 1)`；`pageSize = min(100, max(1, opts.pageSize ?? 20))`。
- `SELECT COUNT(*)` 取 total；`... WHERE owner_email = ? ORDER BY created_at LIMIT ? OFFSET ?` 取当页。
- **唯一调用方是 `GET /api/email/domains`**（发送服务用 `getEmailDomain`，不受影响）。返回形态从 `EmailDomainRow[]` 改为 `{domains,total}`，同步更新路由与测试。

`src/pages/api/email/domains/index.ts` —— `GET` 加分页（镜像 `/api/accounts` 与 `/api/email/log`）：
```ts
const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1 ? Math.min(100, rawPageSize) : 20;
const { domains, total } = await listEmailDomains(db, userEmail, { page, pageSize });
return Response.json({ domains: domains.map(toPublic), total, page, pageSize });
```
POST/PUT/DELETE 不变。

### 前端（`src/components/EmailPanel.tsx`）

拆成两个独立数据通道：
- **发送 tab 的域名下拉 + 空态判断**：面板级仍拉「全量」——改为 `GET /api/email/domains?pageSize=100`（与 `DomainsTab` 已有的 `/api/accounts?pageSize=100` 账号下拉同款做法）。`reloadDomains` 读 `data.domains`，供 `SendTab` 下拉与「尚未配置域名」空态。
- **DomainsTab 表格**：自管 `page/pageSize/total/loading` 状态，`fetch('/api/email/domains?page=&pageSize=')`，表格下方挂 `TablePagination`（props 同 `AccountsPanel`/`LogTab`：`locale/total/page/pageCount/pageSize/onPageChange/onPageSizeChange`）。
  - 增/改/删成功后：既 `reload()` 自己这页，又调面板 `onChanged()` 刷新发送下拉的全量。
  - 删到当前页空且 `page>1`：回退第 1 页（同 `AccountsPanel` 的 `reload` 逻辑）。
  - 列表加载失败：`loadError` 错误横幅 + 重试（同 `AccountsPanel`）。

## 三、i18n / 测试 / 移动端

### i18n（`src/i18n/index.ts`，zh + en 各加）
- `email.domainSearchPlaceholder`（如「域名（输入可搜索已同步的 zone）」/ "Domain (type to search your zones)"）
- `email.domainNoMatch`（如「无匹配域名，可直接输入」/ "No matching zone — you can type any domain"）

分页文案复用已有 `common.totalCount / common.perPage / common.pageOf`，无需新增。

### 测试（Vitest，Node，`createTestDb()` 跑真实迁移）
- `email-domains-repo.test.ts`：`listEmailDomains` 分页 —— 插 N 条后按 page/pageSize 取当页、`total` 正确、owner_email 隔离下 total 只算自己。
- `email-domains-api.test.ts`：`GET` 返回 `{domains,total,page,pageSize}`；page/pageSize 非法值 clamp 到默认；`?pageSize=100` 能取回全量供发送下拉；既有用例（校验/409/404/凭证不回显）不回归。
- `SearchableCombobox` 属 UI 组件，按项目惯例**无单测**；收尾用 `npm run preview`（workerd）+ 浏览器真机验收：键盘 ↑/↓/Enter/Esc、外部点击关闭、自由输入、zones 建议、无 zones 时空建议但可输入、发送域名列表翻页与每页条数、500px 零整页横滚、1440 桌面回归。

### 移动端（CLAUDE.md 规则）
- combobox 输入 `w-full sm:w-56` + `max-w-full`；下拉面板 `w-full`（贴输入宽）、`max-h-60 overflow-y-auto`、`absolute z-…`。
- `TablePagination` 已适配，无额外处理。
- 表格仍在 `overflow-x-auto` 内、次要列 `hidden sm:table-cell`/`hidden md:table-cell` 保持不变。

## 错误处理

- combobox 的 zones 拉取失败 → 建议按空处理、不弹 toast、不挡输入。
- 域名列表分页拉取失败 → `loadError` 横幅 + 重试（同账号页）。
- 后端错误体系（`ConfigError`/`jsonError`）与既有一致，本次不新增错误 code。

## 不在本次范围（YAGNI）

- 发送域名列表的搜索框（用户只要分页，未要搜索）。
- combobox 按 provider/CF 账号过滤 zones 建议。
- zones 的自动同步触发（建议依赖用户已在 Zones 页同步的缓存）。
