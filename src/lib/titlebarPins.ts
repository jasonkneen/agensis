// Which "..." menu actions a person has pinned to every window's title bar.
// One choice for all windows (a habit, not a per-window setting), kept in
// localStorage and shared live across every mounted title bar.
import { useSyncExternalStore } from 'react';

export const TITLEBAR_PIN_IDS = ['share', 'share-window', 'maximize', 'full-expand', 'privacy', 'lock'] as const;
export type TitlebarPinId = (typeof TITLEBAR_PIN_IDS)[number];

const KEY = 'agensis_titlebar_pins';
const listeners = new Set<() => void>();
let cache: TitlebarPinId[] | null = null;

function read(): TitlebarPinId[] {
  if (cache) return cache;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    cache = Array.isArray(raw) ? raw.filter((id): id is TitlebarPinId => (TITLEBAR_PIN_IDS as readonly string[]).includes(id)) : [];
  } catch {
    cache = [];
  }
  return cache;
}

export function toggleTitlebarPin(id: TitlebarPinId) {
  const current = read();
  // Keep the menu's order, whatever order they were pinned in.
  const next = current.includes(id)
    ? current.filter(p => p !== id)
    : TITLEBAR_PIN_IDS.filter(p => p === id || current.includes(p));
  cache = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useTitlebarPins(): readonly TitlebarPinId[] {
  return useSyncExternalStore(subscribe, read, () => []);
}

/** Test seam: forget the cached value so the next read goes to storage. */
export function resetTitlebarPinsCache() {
  cache = null;
}
