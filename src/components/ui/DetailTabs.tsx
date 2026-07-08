import { useCallback, useState } from 'react';
import { resolveTabParam } from '../../lib/tabParam';

/**
 * 详情页共享 tab 条。tab 状态由 useDetailTab 持有并同步到 URL ?tab=
 * （replaceState，可直链分享）；initial 来自 Astro 服务端读取的
 * searchParams（SSR 与首次 hydration 一致，避免闪烁/mismatch）。
 */
export function useDetailTab<K extends string>(keys: readonly K[], initial?: string | null): [K, (next: K) => void] {
  const [active, setActive] = useState<K>(() => resolveTabParam(initial, keys));
  const switchTab = useCallback((next: K) => {
    setActive(next);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', next);
    window.history.replaceState(null, '', url);
  }, []);
  return [active, switchTab];
}

export default function DetailTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: string; label: string }[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div role="tablist" className="tabs tabs-border">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          className={`tab${active === tab.key ? ' tab-active' : ''}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
