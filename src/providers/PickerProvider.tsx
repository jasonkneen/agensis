// Workspace-level element picker. The composer already has its own chat-scoped
// picker (see ChatWindowContent); this is a SECOND, independent picker that is
// available from every window's title bar so a human can point at any element —
// on the Docs screen, the Tasks screen, anywhere — and send the marks to an
// agent without a chat being open first.
//
// State lives here at the app root, the picking overlay is rendered once here
// (it portals to <body> and works in viewport coordinates, so it floats over
// whatever screen is showing), and `GlobalPickerTitlebarControl` reads this
// context so every FloatingWindowShell can render the same trigger.

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { ComponentPickerOverlay } from '../components/chat/ComponentPickerOverlay';
import { MarkupToolbarControl, type MarkupAgent } from '../components/chat/MarkupToolbarControl';
import type { ElementPick } from '../lib/componentPicker';
import type { SendOutcome } from '../lib/writeFeedback';

const ALWAYS_KEY = 'agensis_markup_always_send_global';

type PickerContextValue = {
  active: boolean;
  picks: ElementPick[];
  toggle: () => void;
  clear: () => void;
  agents: MarkupAgent[];
  alwaysHandle: string | null;
  setAlways: (handle: string | null) => void;
  send: (handle: string) => void;
};

const PickerContext = createContext<PickerContextValue | null>(null);

/**
 * Decide, after attempting a send, whether the optimistically-cleared picks must
 * be restored. TWO failure shapes both restore: the send THREW, or it resolved a
 * {@link SendOutcome} with `delivered: false` (an offline/queued or
 * workspace-unavailable write that never threw). A resolved `delivered: true`,
 * or a void/undefined result, keeps the picks cleared. Pulled out of the
 * component so the branch is unit-testable without rendering.
 */
export async function runPickSend(
  attempt: () => void | SendOutcome | Promise<void | SendOutcome>,
): Promise<{ restore: boolean }> {
  try {
    const outcome = await attempt();
    return { restore: Boolean(outcome && outcome.delivered === false) };
  } catch {
    return { restore: true };
  }
}

/**
 * Resolve the "always send" handle against the live roster. A handle persisted in
 * localStorage for an agent that has since left the workspace is stale and must
 * fall back to asking (null) rather than silently target a removed agent.
 */
export function resolveAlwaysHandle(
  alwaysHandle: string | null,
  agents: MarkupAgent[],
): string | null {
  return alwaysHandle && agents.some(a => a.handle === alwaysHandle) ? alwaysHandle : null;
}

function makeId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `pick-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export function PickerProvider({
  agents,
  onSendToAgent,
  children,
}: {
  /** Workspace agent roster the picker can send to, in roster order. */
  agents: MarkupAgent[];
  /**
   * Deliver the collected picks to one agent (opens/creates their DM).
   * May resolve to a {@link SendOutcome}: `delivered: false` reports a failure
   * that did NOT throw (e.g. an offline/queued write), so the picks are still
   * restored rather than lost.
   */
  onSendToAgent: (handle: string, picks: ElementPick[]) => void | SendOutcome | Promise<void | SendOutcome>;
  children: React.ReactNode;
}) {
  const [active, setActive] = useState(false);
  const [picks, setPicks] = useState<ElementPick[]>([]);
  const [alwaysHandle, setAlwaysHandle] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem(ALWAYS_KEY);
    } catch {
      return null;
    }
  });

  const addPick = useCallback((pick: Omit<ElementPick, 'id' | 'index'>) => {
    setPicks(prev => [...prev, { ...pick, id: makeId(), index: prev.length + 1 }]);
  }, []);

  const clear = useCallback(() => {
    setPicks([]);
    setActive(false);
  }, []);

  const toggle = useCallback(() => setActive(prev => !prev), []);

  const setAlways = useCallback((handle: string | null) => {
    setAlwaysHandle(handle);
    if (typeof window === 'undefined') return;
    try {
      if (handle) window.localStorage.setItem(ALWAYS_KEY, handle);
      else window.localStorage.removeItem(ALWAYS_KEY);
    } catch {
      /* storage unavailable — remember for this session only */
    }
  }, []);

  const send = useCallback(async (handle: string) => {
    if (picks.length === 0 || !handle) return;
    const draft = picks;
    // Optimistically clear so the pill resets; restore on failure like the chat
    // path does, so a send that fails never silently loses the marks. Both a
    // thrown error and a resolved `delivered: false` outcome count as failure —
    // see runPickSend.
    setPicks([]);
    setActive(false);
    const { restore } = await runPickSend(() => onSendToAgent(handle, draft));
    if (restore) setPicks(draft);
  }, [picks, onSendToAgent]);

  // Only "always send" to a handle that is still in the roster — a stale
  // localStorage handle for a removed agent must fall back to asking.
  const resolvedAlways = resolveAlwaysHandle(alwaysHandle, agents);

  const value = useMemo<PickerContextValue>(() => ({
    active,
    picks,
    toggle,
    clear,
    agents,
    alwaysHandle: resolvedAlways,
    setAlways,
    send,
  }), [active, picks, toggle, clear, agents, resolvedAlways, setAlways, send]);

  return (
    <PickerContext.Provider value={value}>
      {children}
      <ComponentPickerOverlay
        active={active}
        picks={picks}
        onAddPick={addPick}
        onDeactivate={() => setActive(false)}
      />
    </PickerContext.Provider>
  );
}

export function usePicker(): PickerContextValue | null {
  return useContext(PickerContext);
}

/**
 * The title-bar trigger. Renders nothing until a PickerProvider is mounted, so
 * it is safe to drop into FloatingWindowShell unconditionally. Collapsed it is a
 * single crosshair icon; once picking (or with marks collected) it expands into
 * the pick / clear / send pill — the same control the composer uses.
 */
export function GlobalPickerTitlebarControl({ className }: { className?: string }) {
  const picker = usePicker();
  if (!picker) return null;
  return (
    <MarkupToolbarControl
      className={className}
      open={picker.active || picker.picks.length > 0}
      picking={picker.active}
      pickCount={picker.picks.length}
      agents={picker.agents}
      alwaysHandle={picker.alwaysHandle}
      onTogglePicking={picker.toggle}
      onClear={picker.clear}
      onSend={picker.send}
      onSetAlways={picker.setAlways}
    />
  );
}
