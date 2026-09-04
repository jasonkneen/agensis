// Lightweight client-side preference store (localStorage). Non-secret UI/AI
// defaults live here; secret keys are managed server-side via /backend/settings.

export type NotificationLevel = 'all' | 'mentions' | 'none';
export type UiFontFamily =
  | 'geist' | 'inter' | 'space-grotesk' | 'system' | 'mono'
  | 'manrope' | 'dm-sans' | 'work-sans' | 'plus-jakarta' | 'outfit'
  | 'sora' | 'lexend' | 'albert-sans' | 'bricolage' | 'schibsted'
  | 'hanken' | 'figtree' | 'jetbrains-mono';

export interface AppSettings {
  ai_default_model: string;
  ai_use_workspace_context: boolean;
  notifications_level: NotificationLevel;
  notifications_sound: boolean;
  notifications_desktop: boolean;
  notifications_agent_events: boolean;
  notifications_task_reminders: boolean;
  ui_font_family: UiFontFamily;
  ui_base_font_size: number;
  ui_font_weight: number;
  ui_line_height: number;
  ui_theme_preset: string;
  /**
   * Corner rounding. A NUMBER since corners became a continuous scale (a
   * multiplier on the base radius tokens), but typed to accept the legacy
   * preset ids too — 'sharp' | 'soft' | 'rounded' | 'pill' — because accounts
   * saved before the slider still hold one, and radiusScaleFrom() resolves
   * those to the rounding they described rather than dropping to the default.
   */
  ui_default_radius: number | string;
  ui_neo_theme: string;
  ui_normal_theme: string;
  ui_tw_theme: string;
  ui_panel_translucency: number;
  ui_sidebar_translucency: number;
  ui_glass_blur: number;
}

const DEFAULTS: AppSettings = {
  ai_default_model: 'auto',
  ai_use_workspace_context: true,
  notifications_level: 'mentions',
  notifications_sound: true,
  notifications_desktop: true,
  notifications_agent_events: true,
  notifications_task_reminders: false,
  ui_font_family: 'bricolage',
  ui_base_font_size: 17,
  ui_font_weight: 400,
  ui_line_height: 1.5,
  ui_theme_preset: 'neutral',
  ui_default_radius: 'soft',
  ui_neo_theme: 'blueprint',
  ui_normal_theme: '',
  ui_tw_theme: 'gold',
  // Panels sit over a wallpaper, so every percent of transparency is contrast
  // spent on decoration. 76/74 let enough of the image through that text on a
  // busy wallpaper became hard to read — the same class of problem as the
  // sidebar section labels, which were mixing toward `transparent` and letting
  // the image through the glyphs themselves. 88 keeps a visible frosting while
  // putting the content first. The slider still spans 18-92 for anyone who
  // wants more glass.
  ui_panel_translucency: 88,
  ui_sidebar_translucency: 88,
  ui_glass_blur: 14,
};

const STORAGE_KEY = 'agensis_settings';

function readAll(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return readAll()[key];
}

export function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
  const next = { ...readAll(), [key]: value };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function getSettings(): AppSettings {
  return readAll();
}

export function fontFamilyCss(value: UiFontFamily): string {
  switch (value) {
    case 'inter':
      return "Inter, 'Geist Variable', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    case 'space-grotesk':
      return "'Space Grotesk', 'Geist Variable', system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    case 'system':
      return "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    case 'mono':
      // Names only faces that are actually available: IBM Plex Mono is bundled
      // (@fontsource/ibm-plex-mono, imported in index.css), and the rest are
      // system. This used to name 'JetBrains Mono', which is NOT bundled and is
      // only fetched when the separate 'jetbrains-mono' choice below is picked —
      // so choosing "Mono" silently rendered SFMono/Consolas and the setting did
      // not do what its own value said.
      return "'IBM Plex Mono', 'SFMono-Regular', Consolas, ui-monospace, monospace";
    case 'manrope':
      return "'Manrope', 'Geist Variable', system-ui, sans-serif";
    case 'dm-sans':
      return "'DM Sans', 'Geist Variable', system-ui, sans-serif";
    case 'work-sans':
      return "'Work Sans', 'Geist Variable', system-ui, sans-serif";
    case 'plus-jakarta':
      return "'Plus Jakarta Sans', 'Geist Variable', system-ui, sans-serif";
    case 'outfit':
      return "'Outfit', 'Geist Variable', system-ui, sans-serif";
    case 'sora':
      return "'Sora', 'Geist Variable', system-ui, sans-serif";
    case 'lexend':
      return "'Lexend', 'Geist Variable', system-ui, sans-serif";
    case 'albert-sans':
      return "'Albert Sans', 'Geist Variable', system-ui, sans-serif";
    case 'bricolage':
      return "'Bricolage Grotesque Variable', 'Bricolage Grotesque', 'Geist Variable', system-ui, sans-serif";
    case 'schibsted':
      return "'Schibsted Grotesk', 'Geist Variable', system-ui, sans-serif";
    case 'hanken':
      return "'Hanken Grotesk', 'Geist Variable', system-ui, sans-serif";
    case 'figtree':
      return "'Figtree', 'Geist Variable', system-ui, sans-serif";
    case 'jetbrains-mono':
      return "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace";
    case 'geist':
    default:
      return "'Geist Variable', Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  }
}

// geist/inter/space-grotesk are already loaded eagerly (fontsource + the
// index.css @import) since they're the long-standing defaults; system/mono
// need no webfont. Only the 13 newer picker options load on demand, one
// family per <link>, so picking one font doesn't pull in the other twelve.
// Faces fetched from Google on demand. 'bricolage' is deliberately ABSENT:
// it is the default UI font, so it is bundled (@fontsource-variable/
// bricolage-grotesque, imported in index.css) and must never depend on a
// third-party request that a cold, offline or PWA load cannot make.
const UI_FONT_GOOGLE_FAMILY: Partial<Record<UiFontFamily, string>> = {
  manrope: 'Manrope:wght@400;500;600;700',
  'dm-sans': 'DM+Sans:wght@400;500;700',
  'work-sans': 'Work+Sans:wght@400;500;600;700',
  'plus-jakarta': 'Plus+Jakarta+Sans:wght@400;500;600;700',
  outfit: 'Outfit:wght@400;500;600;700',
  sora: 'Sora:wght@400;500;600;700',
  lexend: 'Lexend:wght@400;500;600;700',
  'albert-sans': 'Albert+Sans:wght@400;500;600;700',
  schibsted: 'Schibsted+Grotesk:wght@400;500;600;700',
  hanken: 'Hanken+Grotesk:wght@400;500;600;700',
  figtree: 'Figtree:wght@400;500;600;700',
  'jetbrains-mono': 'JetBrains+Mono:wght@400;500;600;700',
};

const loadedUiFonts = new Set<UiFontFamily>();

function ensureUiFontLoaded(value: UiFontFamily) {
  const family = UI_FONT_GOOGLE_FAMILY[value];
  if (!family || loadedUiFonts.has(value) || typeof document === 'undefined') return;
  loadedUiFonts.add(value);
  if (document.querySelector(`link[data-ui-font="${value}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${family}&display=swap`;
  link.setAttribute('data-ui-font', value);
  document.head.appendChild(link);
}

export function applyUiAppearanceSettings(settings: Pick<AppSettings, 'ui_font_family' | 'ui_base_font_size' | 'ui_font_weight' | 'ui_line_height' | 'ui_panel_translucency' | 'ui_sidebar_translucency' | 'ui_glass_blur'> = readAll()) {
  const root = document.documentElement;
  const panel = Math.min(92, Math.max(18, settings.ui_panel_translucency || DEFAULTS.ui_panel_translucency));
  const sidebar = Math.min(92, Math.max(18, settings.ui_sidebar_translucency || DEFAULTS.ui_sidebar_translucency));
  const blur = Math.min(32, Math.max(0, settings.ui_glass_blur ?? DEFAULTS.ui_glass_blur));
  ensureUiFontLoaded(settings.ui_font_family);
  root.style.setProperty('--agensis-ui-font-family', fontFamilyCss(settings.ui_font_family));
  root.style.setProperty('--agensis-ui-font-size', `${Math.min(18, Math.max(12, settings.ui_base_font_size || DEFAULTS.ui_base_font_size))}px`);
  // Weight is a real axis on the bundled variable faces (Bricolage and Geist are
  // both 200-800), so this interpolates rather than snapping to the nearest
  // static cut. Clamped to 300-700: below 300 the UI stops being legible at
  // 12px and above 700 the variable axis has nothing left to give.
  root.style.setProperty('--agensis-ui-font-weight', String(Math.min(700, Math.max(300, settings.ui_font_weight || DEFAULTS.ui_font_weight))));
  // Unitless, so it multiplies each element's own font-size instead of pinning
  // every line to one absolute height.
  root.style.setProperty('--agensis-ui-line-height', String(Math.min(2, Math.max(1.2, settings.ui_line_height || DEFAULTS.ui_line_height))));
  root.style.setProperty('--agensis-panel-alpha', `${panel}%`);
  root.style.setProperty('--agensis-sidebar-alpha', `${sidebar}%`);
  root.style.setProperty('--agensis-glass-blur', `${blur}px`);
  // ZERO HAS TO MEAN NO FILTER, NOT A ZERO-RADIUS ONE.
  //
  // Every glass surface in index.css reads `backdrop-filter` from one of the
  // three tokens below rather than from --agensis-glass-blur directly, and this
  // is why. Writing only the px value meant a slider at 0 still produced
  // `backdrop-filter: blur(0px) saturate(140%)` — the property is still there,
  // so the compositor still gives the element its own render surface, still
  // copies the backdrop into a texture and still runs the saturate colour matrix
  // over it on every frame the region behind it changes. Dragging a window over
  // a 0px-blurred sidebar cost exactly what dragging it over a 16px-blurred one
  // cost, so the slider's escape hatch bought nothing on the machines that
  // needed it. `none` removes the render surface entirely.
  //
  // These are set as inline styles on :root, so they beat the per-family
  // declarations in index.css the same way --agensis-glass-blur always has.
  if (blur <= 0) {
    root.style.setProperty('--agensis-glass-filter', 'none');
    root.style.setProperty('--agensis-glass-filter-soft', 'none');
    root.style.setProperty('--agensis-glass-filter-subtle', 'none');
  } else {
    root.style.setProperty('--agensis-glass-filter', `blur(${blur}px) saturate(140%)`);
    // In-panel rows and cards frost at 0.75x the panel radius — the same ratio
    // the stylesheet used when it computed this with calc().
    root.style.setProperty('--agensis-glass-filter-soft', `blur(${Math.round(blur * 75) / 100}px) saturate(140%)`);
    // The fixed 3px scrims are not on the panel ladder; they only need to know
    // whether glass is on at all.
    root.style.setProperty('--agensis-glass-filter-subtle', 'blur(3px)');
  }
}
