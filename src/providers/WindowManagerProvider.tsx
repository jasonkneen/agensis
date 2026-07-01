import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useWindows } from '../hooks/useWindows';

type WindowManagerValue = ReturnType<typeof useWindows>;

const WindowManagerContext = createContext<WindowManagerValue | null>(null);

/**
 * Owns the floating-window lifecycle (open/close/focus/minimize/update, restore
 * bounds, z-order, tiling) by calling `useWindows` once at the top of the App
 * tree and exposing its API via context. This is purely a relocation of the
 * single `useWindows()` call that previously lived inline in App — behavior is
 * identical because the hook still runs once per render, unconditionally, above
 * every consumer.
 */
export function WindowManagerProvider({ children }: { children: ReactNode }) {
  const windowManager = useWindows();
  const {
    windows,
    openWindow,
    closeWindow,
    closeAllWindows,
    focusWindow,
    updateWindow,
    minimizeWindow,
    selectedWindowIds,
    setSelectedWindowIds,
    focusWindowGroup,
    minimizeWindowGroup,
    ungroupTiledWindows,
  } = windowManager;

  const value = useMemo<WindowManagerValue>(
    () => ({ windows, openWindow, closeWindow, closeAllWindows, focusWindow, updateWindow, minimizeWindow, selectedWindowIds, setSelectedWindowIds, focusWindowGroup, minimizeWindowGroup, ungroupTiledWindows }),
    [windows, openWindow, closeWindow, closeAllWindows, focusWindow, updateWindow, minimizeWindow, selectedWindowIds, setSelectedWindowIds, focusWindowGroup, minimizeWindowGroup, ungroupTiledWindows],
  );

  return <WindowManagerContext.Provider value={value}>{children}</WindowManagerContext.Provider>;
}

export function useWindowManager(): WindowManagerValue {
  const ctx = useContext(WindowManagerContext);
  if (!ctx) {
    throw new Error('useWindowManager must be used within a WindowManagerProvider');
  }
  return ctx;
}
