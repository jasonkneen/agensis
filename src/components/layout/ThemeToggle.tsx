import { Monitor, Moon, Sun } from 'lucide-react';
import type { ThemeMode } from '../../hooks/useTheme';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

interface ThemeToggleProps {
  mode: ThemeMode;
  onModeChange: (mode: ThemeMode) => void;
}

const options: { value: ThemeMode; icon: typeof Sun; label: string }[] = [
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'dark', icon: Moon, label: 'Dark' },
  { value: 'system', icon: Monitor, label: 'System' },
];

export function ThemeToggle({ mode, onModeChange }: ThemeToggleProps) {
  return (
    <ToggleGroup
      type="single"
      value={mode}
      onValueChange={value => {
        if (value) onModeChange(value as ThemeMode);
      }}
      variant="outline"
      size="sm"
      spacing={2}
      className="theme-toggle grid w-full grid-cols-3"
      aria-label="Theme"
    >
      {options.map(opt => {
        const Icon = opt.icon;
        return (
          <ToggleGroupItem key={opt.value} value={opt.value} title={opt.label} aria-label={opt.label} className="min-w-0 px-0">
            <Icon data-icon="inline-start" className="size-4" />
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}
