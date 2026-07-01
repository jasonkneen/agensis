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
  ui_theme_preset: string;
  ui_neo_theme: string;
  ui_normal_theme: string;
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
  ui_font_family: 'geist',
  ui_base_font_size: 15,
  ui_theme_preset: 'neutral',
  ui_neo_theme: 'blueprint',
  ui_normal_theme: '',
  ui_panel_translucency: 76,
  ui_sidebar_translucency: 74,
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
      return "'SFMono-Regular', 'JetBrains Mono', Consolas, monospace";
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
      return "'Bricolage Grotesque', 'Geist Variable', system-ui, sans-serif";
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
const UI_FONT_GOOGLE_FAMILY: Partial<Record<UiFontFamily, string>> = {
  manrope: 'Manrope:wght@400;500;600;700',
  'dm-sans': 'DM+Sans:wght@400;500;700',
  'work-sans': 'Work+Sans:wght@400;500;600;700',
  'plus-jakarta': 'Plus+Jakarta+Sans:wght@400;500;600;700',
  outfit: 'Outfit:wght@400;500;600;700',
  sora: 'Sora:wght@400;500;600;700',
  lexend: 'Lexend:wght@400;500;600;700',
  'albert-sans': 'Albert+Sans:wght@400;500;600;700',
  bricolage: 'Bricolage+Grotesque:wght@400;500;600;700',
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

export function applyUiAppearanceSettings(settings: Pick<AppSettings, 'ui_font_family' | 'ui_base_font_size' | 'ui_panel_translucency' | 'ui_sidebar_translucency' | 'ui_glass_blur'> = readAll()) {
  const root = document.documentElement;
  const panel = Math.min(92, Math.max(18, settings.ui_panel_translucency || DEFAULTS.ui_panel_translucency));
  const sidebar = Math.min(92, Math.max(18, settings.ui_sidebar_translucency || DEFAULTS.ui_sidebar_translucency));
  const blur = Math.min(32, Math.max(0, settings.ui_glass_blur ?? DEFAULTS.ui_glass_blur));
  ensureUiFontLoaded(settings.ui_font_family);
  root.style.setProperty('--agensis-ui-font-family', fontFamilyCss(settings.ui_font_family));
  root.style.setProperty('--agensis-ui-font-size', `${Math.min(18, Math.max(12, settings.ui_base_font_size || DEFAULTS.ui_base_font_size))}px`);
  root.style.setProperty('--agensis-panel-alpha', `${panel}%`);
  root.style.setProperty('--agensis-sidebar-alpha', `${sidebar}%`);
  root.style.setProperty('--agensis-glass-blur', `${blur}px`);
}
