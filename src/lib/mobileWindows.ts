import type { FloatingWindow } from '../types';

// Phone layout mode shows exactly one window: the focused one. Focus is encoded
// as zIndex (useWindows bumps a window's zIndex on focus/open), so the active
// window is the highest-zIndex window that isn't minimized. Returns null when
// nothing is open (the switcher then shows only its menu button).
export function pickActiveWindowId(windows: FloatingWindow[]): string | null {
  let active: FloatingWindow | null = null;
  for (const win of windows) {
    if (win.minimized) continue;
    if (!active || win.zIndex > active.zIndex) active = win;
  }
  return active ? active.id : null;
}
