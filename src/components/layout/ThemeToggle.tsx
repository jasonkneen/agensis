import { Monitor, Moon, Sun } from 'lucide-react';
import type { ThemeMode } from '../../hooks/useTheme';
import { Button } from '@agensis/ui/components/button';

interface ThemeToggleProps {
  mode: ThemeMode;
  onModeChange: (mode: ThemeMode) => void;
}

const options: { value: ThemeMode; icon: typeof Sun; label: string }[] = [
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'dark', icon: Moon, label: 'Dark' },
  { value: 'system', icon: Monitor, label: 'System' },
];

const cycle: ThemeMode[] = ['light', 'dark', 'system'];

function schemeForMode(mode: ThemeMode): ThemeMode {
  if (mode === 'default-light') return 'light';
  if (mode === 'default-dark') return 'dark';
  if (mode === 'default-system') return 'system';
  return mode === 'dark' || mode === 'system' ? mode : 'light';
}

export function ThemeToggle({ mode, onModeChange }: ThemeToggleProps) {
  const scheme = schemeForMode(mode);
  const current = options.find(option => option.value === scheme) || options[0];
  const nextScheme = cycle[(cycle.indexOf(scheme) + 1) % cycle.length] || cycle[0];
  const isDefaultFamily = mode === 'default-light' || mode === 'default-dark' || mode === 'default-system';
  const nextMode = isDefaultFamily
    ? `default-${nextScheme}` as ThemeMode
    : cycle[(cycle.indexOf(mode) + 1) % cycle.length] || cycle[0];
  const next = options.find(option => option.value === schemeForMode(nextMode)) || options[0];
  const Icon = current.icon;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="theme-toggle-cycle"
      onClick={() => onModeChange(nextMode)}
      aria-label={`Theme: ${current.label}. Switch to ${next.label}`}
      title={`Theme: ${current.label}. Switch to ${next.label}`}
    >
      <Icon className="size-4" />
    </Button>
  );
}
