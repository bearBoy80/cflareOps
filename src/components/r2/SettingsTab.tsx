import type { Locale } from '@/i18n';

// 占位组件：Task 12 会替换为桶设置（公开访问/自定义域名/CORS/生命周期规则）实现。
// cfAccountId 透传占位：Task 12 落地 fetch 调用时必须复用 ObjectsTab.tsx 的 withCf(url, cfAccountId) 拼接模式，
// 否则同 token 多 CF 账号同名桶场景会退化回 ORDER BY LIMIT 1 的旧行为（详见 task-11 报告）。
export default function SettingsTab(_props: { locale: Locale; apiBase: string; cfAccountId?: string | null }) {
  return null;
}
