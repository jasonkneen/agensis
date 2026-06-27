import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { useTheme, type ThemeMode } from '@/hooks/useTheme';
import { THEME_PRESETS, applyThemePreset, getStoredPreset } from './themePresets';

import ActionsSection from './sections/Actions';
import InputsSection from './sections/Inputs';
import SelectionSection from './sections/Selection';
import OverlaysSection from './sections/Overlays';
import MenusSection from './sections/Menus';
import DataDisplaySection from './sections/DataDisplay';
import TablesAndNavSection from './sections/TablesAndNav';
import DisclosureSection from './sections/Disclosure';
import MediaSection from './sections/Media';
import FeedbackSection from './sections/Feedback';
import ChartsSection from './sections/Charts';
import AIComponentsSection from './sections/AIComponents';

const SECTIONS = [
  ActionsSection,
  InputsSection,
  SelectionSection,
  OverlaysSection,
  MenusSection,
  DataDisplaySection,
  TablesAndNavSection,
  DisclosureSection,
  MediaSection,
  FeedbackSection,
  ChartsSection,
  AIComponentsSection,
];

const MODES: Array<{ id: ThemeMode; icon: typeof Sun; label: string }> = [
  { id: 'light', icon: Sun, label: 'Light' },
  { id: 'dark', icon: Moon, label: 'Dark' },
  { id: 'system', icon: Monitor, label: 'System' },
];

export function Showcase() {
  const { mode, setTheme } = useTheme();
  const [preset, setPreset] = useState(getStoredPreset);

  useEffect(() => {
    applyThemePreset(preset);
  }, [preset]);

  return (
    <TooltipProvider>
      <div className="min-h-screen w-full overflow-y-auto bg-background text-foreground">
        {/* Header */}
        <header className="sticky top-0 z-50 border-b border-border bg-background/85 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">shadcn/ui — Component Showcase</h1>
              <p className="text-sm text-muted-foreground">
                {SECTIONS.length} sections · 60 components · live theming
              </p>
            </div>
            <div className="flex items-center gap-4">
              {/* Light / dark / system */}
              <div className="flex items-center gap-1 rounded-lg border border-border p-1">
                {MODES.map((m) => {
                  const Icon = m.icon;
                  const active = mode === m.id;
                  return (
                    <Button
                      key={m.id}
                      size="sm"
                      variant={active ? 'default' : 'ghost'}
                      className="h-7 gap-1.5 px-2"
                      onClick={() => setTheme(m.id)}
                    >
                      <Icon className="size-3.5" />
                      <span className="hidden sm:inline">{m.label}</span>
                    </Button>
                  );
                })}
              </div>
              {/* Accent presets */}
              <div className="flex items-center gap-1.5">
                {THEME_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    title={p.label}
                    aria-label={`${p.label} theme`}
                    onClick={() => setPreset(p.id)}
                    className={`size-6 rounded-full border-2 transition ${
                      preset === p.id ? 'border-foreground' : 'border-transparent'
                    }`}
                    style={{ background: p.swatch }}
                  />
                ))}
              </div>
            </div>
          </div>
        </header>

        {/* Sections */}
        <main className="mx-auto max-w-6xl space-y-14 px-6 py-10">
          {SECTIONS.map((Section, i) => (
            <Section key={i} />
          ))}
          <footer className="border-t border-border pt-8 text-center text-sm text-muted-foreground">
            Built with shadcn/ui on Tailwind v4 · themed via the app's [data-theme] system
          </footer>
        </main>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
