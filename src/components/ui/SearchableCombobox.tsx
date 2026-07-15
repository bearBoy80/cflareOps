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
        <div
          role="listbox"
          className="menu absolute z-20 mt-1 max-h-60 w-full flex-nowrap overflow-y-auto rounded-box border border-base-300 bg-base-100 p-1 shadow"
        >
          {options.length === 0 ? (
            <div className="pointer-events-none px-3 py-2 text-sm opacity-50">{noMatchLabel}</div>
          ) : (
            options.map((opt, i) => (
              <div key={opt}>
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
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      select(opt);
                    }
                  }}
                >
                  {opt}
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
