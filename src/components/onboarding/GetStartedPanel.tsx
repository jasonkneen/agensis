import { useMemo } from 'react';
import type { ChatSession, WorkspaceAgent } from '../../types';
import { computeChecklistSteps, remainingStepCount } from '@/lib/onboardingChecklist';
import { ALL_TIP_IDS, resolveGetStartedSlot, type TipSurface } from '@/lib/pageTips';
import { booleanPreference, setOf, viewPreferenceKey } from '@/lib/viewPreferences';
import { usePersistedPreference } from '@/hooks/usePersistedPreference';
import { GetStartedChecklist } from './GetStartedChecklist';
import { OwnerMessageCard } from './OwnerMessageCard';
import { useOwnerMessage } from '@/lib/ownerMessageContext';
import { PageTipCard } from './PageTipCard';

// The checklist's own state keeps the keys it has always had — they are global
// rather than workspace-scoped, they are what `npm run reset:test-account` tells
// you to clear, and re-onboarding everyone to rename a key would be a bug, not a
// tidy-up.
const CHECKLIST_DISMISS_KEY = 'agensis_getstarted_dismissed';
const CHECKLIST_COLLAPSE_KEY = 'agensis_getstarted_collapsed';

// Tips state is workspace-scoped through viewPreferenceKey, which cannot build a
// key without a workspace id — so a tip dismissed by one account structurally
// cannot be read back by another sharing the browser. Before there is a
// workspace the key is null, which means "hold it in memory only".
const TIPS_DISMISSED_PREF = setOf(ALL_TIP_IDS);
const TIPS_COLLAPSED_PREF = booleanPreference;
/** Stable fallback — never mutated; every write builds a new Set. */
const NO_TIPS_DISMISSED: Set<string> = new Set();

interface GetStartedPanelProps {
  workspaceId: string | null;
  agents: WorkspaceAgent[];
  sessions: ChatSession[];
  memberCount: number;
  /** Which surface the user is looking at — see tipSurfaceFor in lib/pageTips. */
  surface: TipSurface;
  onCreateAgent: () => void;
  onStartRoom: () => void;
  onMessageAgent: () => void;
  onInvite: () => void;
}

/**
 * The sidebar-footer panel: first-run checklist while there is setup left, then
 * advice about whatever the user is actually looking at.
 *
 * One component owns the space so the priority between the two is decided once,
 * in resolveGetStartedSlot, rather than by two cards each hiding themselves and
 * hoping. Everything it renders is one of two cards with identical furniture.
 */
export function GetStartedPanel({
  workspaceId,
  agents,
  sessions,
  memberCount,
  surface,
  onCreateAgent,
  onStartRoom,
  onMessageAgent,
  onInvite,
}: GetStartedPanelProps) {
  const [checklistDismissed, setChecklistDismissed] = usePersistedPreference(
    CHECKLIST_DISMISS_KEY, booleanPreference, false,
  );
  const [checklistCollapsed, setChecklistCollapsed] = usePersistedPreference(
    CHECKLIST_COLLAPSE_KEY, booleanPreference, false,
  );
  const [dismissedTipIds, setDismissedTipIds] = usePersistedPreference(
    viewPreferenceKey('tips.dismissed', workspaceId), TIPS_DISMISSED_PREF, NO_TIPS_DISMISSED,
  );
  const [tipsCollapsed, setTipsCollapsed] = usePersistedPreference(
    viewPreferenceKey('tips.collapsed', workspaceId), TIPS_COLLAPSED_PREF, false,
  );

  // An owner broadcast for this surface, if there is one. Its DISMISSAL is not a
  // preference: it is a server write against the row that made this user a
  // recipient (useOwnerMessages), so it holds on their other machine and cannot
  // be shared with another account signed in on this one. Only the collapsed
  // toggle — which is a view preference like the other two — is stored locally.
  const ownerMessage = useOwnerMessage('tip');

  const steps = useMemo(
    () => computeChecklistSteps({ agents, sessions, memberCount }),
    [agents, sessions, memberCount],
  );

  const content = resolveGetStartedSlot({
    hasOwnerMessage: ownerMessage.message !== null,
    onboardingRemaining: remainingStepCount(steps),
    checklistDismissed,
    surface,
    dismissedTipIds,
  });

  if (content.kind === 'none') return null;

  if (content.kind === 'owner-message' && ownerMessage.message) {
    return (
      <OwnerMessageCard
        message={ownerMessage.message}
        collapsed={tipsCollapsed}
        onToggleCollapse={() => setTipsCollapsed(prev => !prev)}
        onDismiss={ownerMessage.dismiss}
      />
    );
  }

  if (content.kind === 'checklist') {
    return (
      <GetStartedChecklist
        steps={steps}
        collapsed={checklistCollapsed}
        onToggleCollapse={() => setChecklistCollapsed(prev => !prev)}
        onDismiss={() => setChecklistDismissed(true)}
        onCreateAgent={onCreateAgent}
        onStartRoom={onStartRoom}
        onMessageAgent={onMessageAgent}
        onInvite={onInvite}
      />
    );
  }

  if (content.kind !== 'tip') return null;
  const { tip } = content;

  return (
    <PageTipCard
      tip={tip}
      collapsed={tipsCollapsed}
      onToggleCollapse={() => setTipsCollapsed(prev => !prev)}
      onDismiss={() => setDismissedTipIds(prev => new Set(prev).add(tip.id))}
    />
  );
}
