import { Monitor, Moon, Sun } from 'lucide-react';
import type { ThemeMode } from '../../hooks/useTheme';
import { Button } from '@/components/ui/button';

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

export function ThemeToggle({ mode, onModeChange }: ThemeToggleProps) {
  const current = options.find(option => option.value === mode) || options[0];
  const nextMode = cycle[(cycle.indexOf(mode) + 1) % cycle.length] || cycle[0];
  const next = options.find(option => option.value === nextMode) || options[0];
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
