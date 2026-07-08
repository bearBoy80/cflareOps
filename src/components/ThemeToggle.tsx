import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

type Theme = 'flare' | 'flare-light';

interface Props {
  ariaLabel: string;
}

export default function ThemeToggle({ ariaLabel }: Props) {
  const [theme, setTheme] = useState<Theme>('flare');

  useEffect(() => {
    const stored = document.documentElement.dataset.theme as Theme | undefined;
    if (stored === 'flare' || stored === 'flare-light') {
      setTheme(stored);
    }
  }, []);

  function toggle() {
    const next: Theme = theme === 'flare' ? 'flare-light' : 'flare';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
  }

  return (
    <label className="btn btn-ghost btn-sm btn-circle swap swap-rotate">
      <input type="checkbox" checked={theme === 'flare-light'} onChange={toggle} aria-label={ariaLabel} />
      <Sun size={16} strokeWidth={1.75} className="swap-off" />
      <Moon size={16} strokeWidth={1.75} className="swap-on" />
    </label>
  );
}
