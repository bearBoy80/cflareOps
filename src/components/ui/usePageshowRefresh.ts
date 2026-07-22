import { useEffect } from 'react';

/**
 * 浏览器后退/前进命中 bfcache 时页面按快照原样恢复，React 状态不重建、数据请求不重跑——
 * 在别处删/改过数据后返回会看到旧列表。persisted pageshow 是该场景的标准信号，触发一次刷新。
 */
export function usePageshowRefresh(refresh: () => void) {
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) refresh();
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, [refresh]);
}
