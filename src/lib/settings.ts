// Lightweight client-side preference store (localStorage). Non-secret UI/AI
// defaults live here; secret keys are managed server-side via /backend/settings.

export interface AppSettings {
  ai_default_model: string;
  ai_use_workspace_context: boolean;
}

const DEFAULTS: AppSettings = {
  ai_default_model: 'auto',
  ai_use_workspace_context: true,
};

const STORAGE_KEY = 'hatch_settings';

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
