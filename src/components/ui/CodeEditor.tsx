import { javascript } from '@codemirror/lang-javascript';
import CodeMirror from '@uiw/react-codemirror';
import { useEffect, useState } from 'react';

/**
 * 唯一允许 import codemirror 相关包的文件（React.lazy 动态加载入口，避免主 bundle 膨胀）。
 * 主题跟随 html[data-theme]：flare-light → light，其余（flare）→ dark，用内置 light/dark 主题，
 * MutationObserver 监听切换实时重渲染。
 */

const EXTENSIONS = [javascript()];

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'flare-light' ? 'light' : 'dark';
}

export default function CodeEditor({
  value,
  onChange,
  readOnly,
  height = '24rem',
}: {
  value: string;
  onChange?: (v: string) => void;
  readOnly: boolean;
  height?: string;
}) {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    typeof document === 'undefined' ? 'dark' : currentTheme(),
  );

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="overflow-hidden rounded-md border border-base-300 font-mono text-xs">
      <CodeMirror
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        editable={!readOnly}
        theme={theme}
        height={height}
        extensions={EXTENSIONS}
      />
    </div>
  );
}
