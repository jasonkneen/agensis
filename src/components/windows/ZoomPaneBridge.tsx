import { useEffect } from 'react';
import { dispatchZoom, hasDesktopZoomBridge } from '@/lib/zoomRouter';

/**
 * Connects the desktop shell's zoom chords to the pane that owns them.
 *
 * The main process replaces its stock zoom menu items (which scale the whole
 * application) with handlers that ask the renderer first. Mounting this once, at
 * the root, answers that question for every pane: registered panes (the terminal
 * window, a desktop browser guest) get first refusal, and when none of them
 * takes the chord the handler returns false and the shell zooms the app itself,
 * exactly as before.
 *
 * Nothing renders, and in a browser tab it mounts to nothing at all — there is
 * no bridge, and the native browser zoom is already the right behaviour.
 */
export function ZoomPaneBridge() {
  useEffect(() => {
    if (!hasDesktopZoomBridge()) return;
    const api = (window as unknown as {
      electronAPI?: { onZoomCommand?: (handler: (command: string) => boolean) => () => void };
    }).electronAPI;
    const unsubscribe = api?.onZoomCommand?.(command => {
      if (command !== 'in' && command !== 'out' && command !== 'reset') return false;
      return dispatchZoom(command);
    });
    return () => unsubscribe?.();
  }, []);

  return null;
}
