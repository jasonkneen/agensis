// The Appearance tab, lifted out of SettingsDialog whole. It was 644 lines of
// that file's 2,524 — a quarter of the dialog for one of its nine tabs — and it
// shares nothing with the others but its props: the panels are independent by
// construction, which is what made this a pure move rather than a refactor.
// Behaviour, markup and state are unchanged; only the file boundary is new.

import { DEFAULT_BACKGROUND_OPACITY } from '../../lib/wallpaperDefaults';

// Keeps recharts out of the main bundle — see the note in UsageCharts.tsx.
import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Image as ImageIcon,
  Settings as Upload,
  } from 'lucide-react';
import type { ThemeMode } from '../../hooks/useTheme';
import type { Workspace } from '../../types';
import { applyUiAppearanceSettings, getSettings, setSetting, type AppSettings, type UiFontFamily } from '../../lib/settings';
import {
  EXPO_ACCENTS,
  EXPO_BASES,
  EXPO_PAPERS,
  EXPO_PRESETS,
  applyExpoPreset,
  getExpoAccent,
  getExpoBase,
  getExpoPaper,
  setExpoAccent,
  setExpoBase,
  setExpoPaper,
  type ExpoAccent,
  type ExpoBase,
  type ExpoPaperId,
} from '@/lib/theme/expoColors';
import { WORKSPACE_BACKGROUNDS } from '../../lib/backgrounds';
import { Badge } from '@agensis/ui/components/badge';
import { Button } from '@agensis/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@agensis/ui/components/field';
import { NativeSelect, NativeSelectOption } from '@agensis/ui/components/native-select';
import { Slider } from '@agensis/ui/components/slider';
import { ToggleGroup, ToggleGroupItem } from '@agensis/ui/components/toggle-group';

export function AppearancePanel({
  workspace,
  onUpdateWorkspace,
  themeMode,
  onThemeChange,
}: {
  workspace: Workspace | null;
  onUpdateWorkspace: (id: string, updates: Partial<Workspace>) => void;
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
}) {
  const initialSettings = getSettings();
  const [backgroundOpacity, setBackgroundOpacity] = useState(() => Math.round((workspace?.background_opacity ?? DEFAULT_BACKGROUND_OPACITY) * 100));
  const [fontFamily, setFontFamily] = useState<UiFontFamily>(initialSettings.ui_font_family);
  const [baseFontSize, setBaseFontSize] = useState(initialSettings.ui_base_font_size);
  const [fontWeight, setFontWeight] = useState(initialSettings.ui_font_weight);
  const [lineHeight, setLineHeight] = useState(initialSettings.ui_line_height);
  const readExpoColors = () => ({ base: getExpoBase(), accent: getExpoAccent(), paper: getExpoPaper() });
  const [expoColors, setExpoColors] = useState(readExpoColors);
  const syncExpoColors = () => setExpoColors(readExpoColors());
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const backgroundImage = workspace?.background_image || '';
  // Expo companions first; the rest after. Bricolage, Geist, Inter and Space
  // Grotesk ship with the app; the others load from Google Fonts on demand.
  const fontOptions: Array<{ id: UiFontFamily; label: string }> = [
    { id: 'bricolage', label: 'Bricolage Grotesque (Expo default)' },
    { id: 'archivo', label: 'Archivo' },
    { id: 'rubik', label: 'Rubik' },
    { id: 'nunito', label: 'Nunito' },
    { id: 'fredoka', label: 'Fredoka' },
    { id: 'onest', label: 'Onest' },
    { id: 'instrument-sans', label: 'Instrument Sans' },
    { id: 'geist', label: 'Geist' },
    { id: 'inter', label: 'Inter' },
    { id: 'space-grotesk', label: 'Space Grotesk' },
    { id: 'manrope', label: 'Manrope' },
    { id: 'dm-sans', label: 'DM Sans' },
    { id: 'work-sans', label: 'Work Sans' },
    { id: 'plus-jakarta', label: 'Plus Jakarta Sans' },
    { id: 'outfit', label: 'Outfit' },
    { id: 'sora', label: 'Sora' },
    { id: 'lexend', label: 'Lexend' },
    { id: 'albert-sans', label: 'Albert Sans' },
    { id: 'schibsted', label: 'Schibsted Grotesk' },
    { id: 'hanken', label: 'Hanken Grotesk' },
    { id: 'figtree', label: 'Figtree' },
    { id: 'system', label: 'System' },
    { id: 'mono', label: 'Mono' },
    { id: 'jetbrains-mono', label: 'JetBrains Mono' },
  ];

  useEffect(() => {
    setBackgroundOpacity(Math.round((workspace?.background_opacity ?? DEFAULT_BACKGROUND_OPACITY) * 100));
  }, [workspace?.id, workspace?.background_opacity]);

  const updateAppearanceSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSetting(key, value);
    applyUiAppearanceSettings(getSettings());
  };

  const updateBackgroundImage = (nextImage: string) => {
    if (!workspace) return;
    onUpdateWorkspace(workspace.id, { background_image: nextImage });
  };

  const handleUploadBackground = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = '';
    if (!file || !workspace) return;
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') {
        onUpdateWorkspace(workspace.id, { background_image: reader.result });
      }
    });
    reader.readAsDataURL(file);
  };

  return (
    <FieldGroup>
      {/* ONE style — Expo — in light, dark or system. What a person chooses
          is colour: a preset, or base / accent / surface on their own. Every
          option is drawn from the same data that paints the app
          (lib/theme/expoColors.ts), so a swatch is exactly what you get. */}
      <Field>
        <FieldLabel>Mode</FieldLabel>
        <ToggleGroup
          type="single"
          value={themeMode}
          onValueChange={value => { if (value) onThemeChange(value as ThemeMode); }}
          variant="outline"
          className="grid w-full grid-cols-3"
        >
          <ToggleGroupItem value="light">Light</ToggleGroupItem>
          <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
          <ToggleGroupItem value="system">System</ToggleGroupItem>
        </ToggleGroup>
      </Field>

      <Field>
        <FieldLabel>Presets</FieldLabel>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" role="radiogroup" aria-label="Colour preset">
          {EXPO_PRESETS.map(preset => {
            const base = EXPO_BASES.find(b => b.id === preset.base)!;
            const accent = EXPO_ACCENTS.find(a => a.id === preset.accent)!;
            const surface = EXPO_PAPERS.find(p => p.id === preset.paper)!;
            const active = expoColors.base === preset.base && expoColors.accent === preset.accent && expoColors.paper === preset.paper;
            return (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={active}
                data-selection-control="true"
                onClick={() => { applyExpoPreset(preset.id); syncExpoColors(); }}
                className={`expo-preset flex flex-col items-stretch gap-1.5 rounded-xl p-1.5 text-left text-xs font-medium transition ${active ? 'ring-2 ring-primary' : 'hover:bg-muted/60'}`}
              >
                <span className="flex h-9 overflow-hidden rounded-lg border border-border">
                  <span className="flex-1" style={{ background: surface.cream }} />
                  <span className="flex-1" style={{ background: base.hex }} />
                  <span className="w-3" style={{ background: accent.hex }} />
                </span>
                <span className="truncate px-0.5">{preset.label}</span>
              </button>
            );
          })}
        </div>
      </Field>

      {([
        ['Base', 'The dark stage, and the text colour in light.', EXPO_BASES.map(b => ({ id: b.id, label: b.label, hex: b.hex })), expoColors.base, (id: string) => { setExpoBase(id as ExpoBase); syncExpoColors(); }],
        ['Accent', 'Primary buttons and every selected state. Text on it switches to stay readable.', EXPO_ACCENTS.map(a => ({ id: a.id, label: a.label, hex: a.hex })), expoColors.accent, (id: string) => { setExpoAccent(id as ExpoAccent); syncExpoColors(); }],
        ['Surface', 'The light page, cards and the warm edges around them.', EXPO_PAPERS.map(p => ({ id: p.id, label: p.label, hex: p.cream, ring: p.tone })), expoColors.paper, (id: string) => { setExpoPaper(id as ExpoPaperId); syncExpoColors(); }],
      ] as const).map(([title, hint, options, current, choose]) => (
        <Field key={title}>
          <FieldLabel>{title}</FieldLabel>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={`${title} colour`}>
            {options.map(option => {
              const active = current === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={option.label}
                  title={option.label}
                  data-selection-control="true"
                  onClick={() => choose(option.id)}
                  className={`size-8 rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background' : 'hover:scale-110'}`}
                  style={{
                    background: option.hex,
                    boxShadow: `inset 0 1.5px 0 rgba(255,255,255,0.35), inset 0 0 0 1.5px ${'ring' in option ? option.ring : 'rgba(0,0,0,0.15)'}`,
                  }}
                />
              );
            })}
          </div>
          <FieldDescription>{hint}</FieldDescription>
        </Field>
      ))}

      <Field>
        <FieldLabel htmlFor="ui-font-family">Font</FieldLabel>
        <NativeSelect
          id="ui-font-family"
          value={fontFamily}
          onChange={event => {
            const next = event.target.value as UiFontFamily;
            setFontFamily(next);
            updateAppearanceSetting('ui_font_family', next);
          }}
        >
          {fontOptions.map(option => (
            <NativeSelectOption key={option.id} value={option.id}>{option.label}</NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>

      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Base font size</FieldLabel>
          <Badge variant="secondary">{baseFontSize}px</Badge>
        </div>
        <Slider
          value={[baseFontSize]}
          min={12}
          max={18}
          step={1}
          onValueChange={value => {
            const next = value[0] ?? baseFontSize;
            setBaseFontSize(next);
            updateAppearanceSetting('ui_base_font_size', next);
          }}
        />
      </Field>

      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Font weight</FieldLabel>
          <Badge variant="secondary">{fontWeight}</Badge>
        </div>
        <Slider
          value={[fontWeight]}
          min={300}
          max={700}
          step={25}
          onValueChange={value => {
            const next = value[0] ?? fontWeight;
            setFontWeight(next);
            updateAppearanceSetting('ui_font_weight', next);
          }}
        />
        <FieldDescription>
          The base weight for UI text. Bricolage and Geist are variable faces, so
          in-between values interpolate rather than snapping to the nearest cut.
          Headings and emphasised text keep their own heavier weights.
        </FieldDescription>
      </Field>

      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Line spacing</FieldLabel>
          <Badge variant="secondary">{lineHeight.toFixed(2)}</Badge>
        </div>
        <Slider
          value={[lineHeight]}
          min={1.2}
          max={2}
          step={0.05}
          onValueChange={value => {
            const next = value[0] ?? lineHeight;
            setLineHeight(next);
            updateAppearanceSetting('ui_line_height', next);
          }}
        />
        <FieldDescription>
          Multiplies each element's own size, so dense chips and body prose stay
          in proportion instead of sharing one fixed line height.
        </FieldDescription>
      </Field>

      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Desktop background</FieldLabel>
          <Button type="button" variant="outline" size="sm" onClick={() => updateBackgroundImage('')} disabled={!workspace || !backgroundImage}>
            Auto
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {WORKSPACE_BACKGROUNDS.map(background => {
            const selected = backgroundImage === background.src;
            return (
              <button
                key={background.id}
                type="button"
                className={`group relative overflow-hidden rounded-md border p-1 text-left transition-colors ${selected ? 'border-primary bg-primary/10' : 'border-border bg-background hover:bg-muted/50'
                  }`}
                onClick={() => updateBackgroundImage(background.src)}
                disabled={!workspace}
              >
                <img src={background.src} alt="" className="h-20 w-full rounded object-cover" />
                <span className="mt-1 flex items-center justify-between gap-2 px-1 text-xs font-medium">
                  <span className="truncate">{background.label}</span>
                  {selected && <Check className="size-3.5 text-primary" />}
                </span>
              </button>
            );
          })}
        </div>
        {backgroundImage && !WORKSPACE_BACKGROUNDS.some(background => background.src === backgroundImage) && (
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2 text-sm">
            <ImageIcon className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">Custom upload selected</span>
            <Check className="size-4 text-primary" />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => uploadInputRef.current?.click()} disabled={!workspace}>
            <Upload data-icon="inline-start" />
            Upload
          </Button>
          <input
            ref={uploadInputRef}
            className="hidden"
            type="file"
            accept="image/*"
            onChange={handleUploadBackground}
          />
        </div>
        <FieldDescription>Pick a bundled image or upload a local one. Wallpaper belongs to this desktop, not to the whole workspace.</FieldDescription>
      </Field>
      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Desktop background opacity</FieldLabel>
          <Badge variant="secondary">{backgroundOpacity}%</Badge>
        </div>
        <Slider
          value={[backgroundOpacity]}
          min={10}
          max={100}
          step={1}
          onValueChange={value => setBackgroundOpacity(value[0] ?? backgroundOpacity)}
          onValueCommit={value => {
            if (!workspace) return;
            onUpdateWorkspace(workspace.id, { background_opacity: (value[0] ?? backgroundOpacity) / 100 });
          }}
        />
        <FieldDescription>Stored on this desktop so every device opens it with the same background strength.</FieldDescription>
      </Field>
    </FieldGroup>
  );
}
