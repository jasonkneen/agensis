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
import { THEME_PRESETS, applyThemePreset } from '../../showcase/themePresets';
import {
  applyRadiusScale,
  clampRadiusScale,
  radiusMaxPxFrom,
  radiusScaleFrom,
  RADIUS_PILL_THRESHOLD,
  RADIUS_SCALE_MAX,
  RADIUS_SCALE_MIN,
  RADIUS_SCALE_STEP,
} from '../../showcase/defaultTheme';
import { NEO_THEMES, NEO_GROUPS, applyNeoTheme, resolveNeoStyle } from '../../showcase/neoThemes';
import { NORMAL_THEMES, NORMAL_GROUPS, applyNormalTheme, clearNormalTheme, getStoredNormalTheme } from '../../showcase/normalThemes';
import { TW_WORLDS, applyTwTheme, getStoredTwTheme } from '../../showcase/twThemes';
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
  const [themePreset, setThemePreset] = useState(initialSettings.ui_theme_preset);
  const [radiusScale, setRadiusScale] = useState(() => radiusScaleFrom(initialSettings.ui_default_radius));
  const [neoTheme, setNeoTheme] = useState(initialSettings.ui_neo_theme);
  const [normalTheme, setNormalTheme] = useState(() => getStoredNormalTheme());
  const [twTheme, setTwTheme] = useState(() => getStoredTwTheme());
  const isDefaultFamily = themeMode === 'default-light' || themeMode === 'default-dark' || themeMode === 'default-system';
  const isNeoFamily = themeMode === 'neo-light' || themeMode === 'neo-dark';
  const isNormalFamily = themeMode === 'normal-light' || themeMode === 'normal-dark';
  const isPaper = themeMode === 'paper-light';
  // Derive which style tab is active from the current mode
  const themeStyleTab: 'default' | 'classic' | 'brutal' = isDefaultFamily ? 'default' : isNeoFamily ? 'brutal' : 'classic';
  const [panelTranslucency, setPanelTranslucency] = useState(initialSettings.ui_panel_translucency);
  const [sidebarTranslucency, setSidebarTranslucency] = useState(initialSettings.ui_sidebar_translucency);
  const [glassBlur, setGlassBlur] = useState(initialSettings.ui_glass_blur);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const backgroundImage = workspace?.background_image || '';
  // Scheme toggles per tab
  const normalSchemeModes: Array<{ id: ThemeMode; label: string }> = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'system', label: 'System' },
    { id: 'paper-light', label: 'Paper Light' },
  ];
  // Active scheme value for normal tab: map normal-* back to plain light/dark
  const normalSchemeValue: ThemeMode = themeMode === 'normal-light' ? 'light' : themeMode === 'normal-dark' ? 'dark' : themeMode;
  const defaultSchemeValue = themeMode === 'default-dark' ? 'dark' : themeMode === 'default-system' ? 'system' : 'light';
  const fontOptions: Array<{ id: UiFontFamily; label: string }> = [
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
    { id: 'bricolage', label: 'Bricolage Grotesque' },
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
      <Field>
        <FieldLabel>Theme</FieldLabel>

        {/* Default | Classic | Brutal tab bar */}
        <div className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted p-1">
          <button
            type="button"
            data-selection-control="true"
            onClick={() => {
              if (!isDefaultFamily) {
                const dark = document.documentElement.getAttribute('data-theme') === 'dark';
                onThemeChange(dark ? 'default-dark' : 'default-light');
              }
            }}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${themeStyleTab === 'default' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Default
          </button>
          <button
            type="button"
            data-selection-control="true"
            onClick={() => {
              if (themeStyleTab !== 'classic') {
                const dark = document.documentElement.getAttribute('data-theme') === 'dark';
                onThemeChange(isNormalFamily ? (dark ? 'normal-dark' : 'normal-light') : (dark ? 'dark' : 'light'));
              }
            }}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${themeStyleTab === 'classic' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Classic
          </button>
          <button
            type="button"
            data-selection-control="true"
            onClick={() => {
              if (!isNeoFamily) {
                const dark = document.documentElement.getAttribute('data-theme') === 'dark';
                onThemeChange(dark ? 'neo-dark' : 'neo-light');
              }
            }}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${themeStyleTab === 'brutal' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Brutal
          </button>
        </div>

        {/* Default tab content */}
        {themeStyleTab === 'default' && (
          <div className="space-y-4">
            <ToggleGroup
              type="single"
              value={defaultSchemeValue}
              onValueChange={value => {
                if (!value) return;
                const next = value as 'light' | 'dark' | 'system';
                onThemeChange(next === 'light' ? 'default-light' : next === 'dark' ? 'default-dark' : 'default-system');
              }}
              variant="outline"
              className="grid w-full grid-cols-3"
            >
              <ToggleGroupItem value="light">Light</ToggleGroupItem>
              <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
              <ToggleGroupItem value="system">System</ToggleGroupItem>
            </ToggleGroup>

            <div className="space-y-2">
              <div className="ui-section-label">Colour</div>
              <ToggleGroup
                type="single"
                value={themePreset}
                onValueChange={value => {
                  if (!value) return;
                  setThemePreset(value);
                  setSetting('ui_theme_preset', value);
                  applyThemePreset(value);
                }}
                variant="outline"
                className="grid w-full grid-cols-2 sm:grid-cols-3"
              >
                {THEME_PRESETS.map(preset => (
                  <ToggleGroupItem key={preset.id} value={preset.id} className="gap-2">
                    <span className="size-3 rounded-sm border border-border" style={{ background: preset.swatch }} />
                    {preset.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="ui-section-label">Corners</div>
                <Badge variant="secondary">
                  {radiusScale === 0 ? 'Square' : radiusScale >= RADIUS_PILL_THRESHOLD ? 'Pill' : `${radiusMaxPxFrom(radiusScale)}px max`}
                </Badge>
              </div>
              {/* One axis, one control. This was four preset cards whose names
                  did not even order by radius — "Rounded" (14px) sat between
                  "Soft" (10px) and "Pill" — so it read as four unrelated styles
                  rather than more-or-less of one thing, and could not express
                  anything between them. The slider drives a multiplier that all
                  thirteen radius tokens derive from. Larger tokens stop at the
                  displayed ceiling instead of silently exceeding it. */}
              <Slider
                value={[radiusScale]}
                min={RADIUS_SCALE_MIN}
                max={RADIUS_SCALE_MAX}
                step={RADIUS_SCALE_STEP}
                aria-label="Corner rounding"
                onValueChange={value => {
                  const next = clampRadiusScale(value[0] ?? radiusScale);
                  setRadiusScale(next);
                  setSetting('ui_default_radius', next);
                  applyRadiusScale(next);
                }}
              />
              <div className="flex items-center justify-between text-3xs text-muted-foreground">
                <span>Square</span>
                <span>Pill</span>
              </div>
              <FieldDescription>Sets the largest non-pill corner radius. Compact controls stay proportionally tighter.</FieldDescription>
            </div>

            <FieldDescription>Softer borders and subtle offset shadows.</FieldDescription>
          </div>
        )}

        {/* Classic tab content */}
        {themeStyleTab === 'classic' && (
          <div className="space-y-4">
            {/* Scheme sub-toggle */}
            <ToggleGroup
              type="single"
              value={normalSchemeValue}
              onValueChange={value => {
                if (!value) return;
                const next = value as ThemeMode;
                // If a normal theme is active, keep it active while switching scheme
                if (isNormalFamily && (next === 'light' || next === 'dark')) {
                  onThemeChange(next === 'light' ? 'normal-light' : 'normal-dark');
                } else {
                  onThemeChange(next);
                }
              }}
              variant="outline"
              className="grid w-full grid-cols-2 sm:grid-cols-4"
            >
              {normalSchemeModes.map(mode => (
                <ToggleGroupItem key={mode.id} value={mode.id}>
                  {mode.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>

            {/* Accent color (only when no custom normal theme) */}
            {!isNormalFamily && (
              <div className="space-y-2">
                <div className="ui-section-label">Accent color</div>
                <ToggleGroup
                  type="single"
                  value={themePreset}
                  onValueChange={value => {
                    if (!value) return;
                    setThemePreset(value);
                    setSetting('ui_theme_preset', value);
                    applyThemePreset(value);
                  }}
                  variant="outline"
                  className="grid w-full grid-cols-2 sm:grid-cols-3"
                >
                  {THEME_PRESETS.map(preset => (
                    <ToggleGroupItem key={preset.id} value={preset.id} className="gap-2">
                      <span className="size-3 rounded-sm border border-border" style={{ background: preset.swatch }} />
                      {preset.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            )}

            {/* Paper world grid — repaints the paper; composes with the
                accent preset above (world paper + your picked accent). */}
            {isPaper && (
              <div className="space-y-1.5">
                <div className="ui-section-label">Paper</div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {TW_WORLDS.map(w => {
                    const active = twTheme === w.id;
                    return (
                      <button
                        key={w.id}
                        type="button"
                        onClick={() => {
                          setTwTheme(w.id);
                          setSetting('ui_tw_theme', w.id);
                          applyTwTheme(w.id);
                        }}
                        aria-pressed={active}
                        title={w.label}
                        className={`relative flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition ${active ? 'border-primary bg-primary/10 ring-2 ring-primary' : 'border-border hover:bg-accent'}`}
                      >
                        <span className="flex shrink-0 overflow-hidden rounded-sm border border-border">
                          {w.swatch.map((c, i) => (
                            <span key={i} className="size-3.5" style={{ background: c }} />
                          ))}
                        </span>
                        <span className="truncate font-medium">{w.label}</span>
                        {active && (
                          <span className="ml-auto flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                            <Check className="size-3" strokeWidth={3} />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <FieldDescription>
                  Repaints the Paper theme’s surfaces. Your accent (above) stays on top — pick a world for the mood, an accent for the highlight.
                </FieldDescription>
              </div>
            )}

            {/* Classic theme grid */}
            <div className="space-y-3">
              {NORMAL_GROUPS.map(group => (
                <div key={group} className="space-y-1.5">
                  <div className="ui-section-label">{group}</div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {NORMAL_THEMES.filter(t => t.group === group).map(t => {
                      const active = normalTheme === t.id && isNormalFamily;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => {
                            if (active) {
                              // Deselect: go back to plain scheme
                              setNormalTheme('');
                              setSetting('ui_normal_theme', '');
                              clearNormalTheme();
                              const dark = document.documentElement.getAttribute('data-theme') === 'dark';
                              onThemeChange(dark ? 'dark' : 'light');
                            } else {
                              setNormalTheme(t.id);
                              setSetting('ui_normal_theme', t.id);
                              applyNormalTheme(t.id);
                              const dark = document.documentElement.getAttribute('data-theme') === 'dark';
                              onThemeChange(dark ? 'normal-dark' : 'normal-light');
                            }
                          }}
                          aria-pressed={active}
                          title={t.label}
                          className={`relative flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition ${active ? 'border-primary bg-primary/10 ring-2 ring-primary' : 'border-border hover:bg-accent'}`}
                        >
                          <span className="flex shrink-0 overflow-hidden rounded-sm border border-border">
                            {t.swatch.map((c, i) => (
                              <span key={i} className="size-3.5" style={{ background: c }} />
                            ))}
                          </span>
                          <span className="truncate font-medium">{t.label}</span>
                          {active && (
                            <span className="ml-auto flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                              <Check className="size-3" strokeWidth={3} />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <FieldDescription>Standard themes with clean borders and soft depth.</FieldDescription>
          </div>
        )}

        {/* Brutal tab content */}
        {themeStyleTab === 'brutal' && (
          <div className="space-y-4">
            {/* Neo scheme sub-toggle */}
            <ToggleGroup
              type="single"
              value={themeMode}
              onValueChange={value => {
                if (value) onThemeChange(value as ThemeMode);
              }}
              variant="outline"
              className="grid w-full grid-cols-2"
            >
              <ToggleGroupItem value="neo-light">Neo Light</ToggleGroupItem>
              <ToggleGroupItem value="neo-dark">Neo Dark</ToggleGroupItem>
            </ToggleGroup>

            {/* Neo theme grid */}
            <div className="space-y-3">
              {NEO_GROUPS.map(group => (
                <div key={group} className="space-y-1.5">
                  <div className="ui-section-label">{group}</div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {NEO_THEMES.filter(t => t.group === group).map(t => {
                      const active = neoTheme === t.id;
                      const profile = resolveNeoStyle(t);
                      const swatchRadius = profile.radius === 'sharp' ? '0px' : profile.radius === 'soft' ? '9999px' : '4px';
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => {
                            setNeoTheme(t.id);
                            setSetting('ui_neo_theme', t.id);
                            applyNeoTheme(t.id);
                            if (!isNeoFamily) {
                              const dark = document.documentElement.getAttribute('data-theme') === 'dark';
                              onThemeChange(dark ? 'neo-dark' : 'neo-light');
                            }
                          }}
                          aria-pressed={active}
                          title={t.label}
                          className={`relative flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition ${active ? 'border-primary bg-primary/10 ring-2 ring-primary' : 'border-border hover:bg-accent'}`}
                        >
                          <span className="flex shrink-0 overflow-hidden border border-border" style={{ borderRadius: swatchRadius }}>
                            {t.swatch.map((c, i) => (
                              <span key={i} className="size-3.5" style={{ background: c }} />
                            ))}
                          </span>
                          <span
                            className="truncate font-medium"
                            style={{ fontWeight: profile.weight, letterSpacing: profile.spacing, textTransform: profile.transform as 'uppercase' | 'none' | 'capitalize' | 'lowercase' }}
                          >{t.label}</span>
                          {active && (
                            <span className="ml-auto flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                              <Check className="size-3" strokeWidth={3} />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <FieldDescription>Crisp edges, bold accents and solid surfaces.</FieldDescription>
          </div>
        )}
      </Field>

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
          <FieldLabel>Panel translucency</FieldLabel>
          <Badge variant="secondary">{panelTranslucency}%</Badge>
        </div>
        <Slider
          value={[panelTranslucency]}
          min={35}
          max={95}
          step={1}
          onValueChange={value => {
            const next = value[0] ?? panelTranslucency;
            setPanelTranslucency(next);
            updateAppearanceSetting('ui_panel_translucency', next);
          }}
        />
      </Field>

      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Sidebar translucency</FieldLabel>
          <Badge variant="secondary">{sidebarTranslucency}%</Badge>
        </div>
        <Slider
          value={[sidebarTranslucency]}
          min={35}
          max={95}
          step={1}
          onValueChange={value => {
            const next = value[0] ?? sidebarTranslucency;
            setSidebarTranslucency(next);
            updateAppearanceSetting('ui_sidebar_translucency', next);
          }}
        />
      </Field>

      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Glass blur</FieldLabel>
          <Badge variant="secondary">{glassBlur}px</Badge>
        </div>
        <Slider
          value={[glassBlur]}
          min={0}
          max={32}
          step={1}
          onValueChange={value => {
            const next = value[0] ?? glassBlur;
            setGlassBlur(next);
            updateAppearanceSetting('ui_glass_blur', next);
          }}
        />
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
