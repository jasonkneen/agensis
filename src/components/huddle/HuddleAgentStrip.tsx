import { useEffect, useMemo } from 'react';
import { Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isImageAvatar, isPetSpritesheetAvatar, renderablePetAssetUrl } from '@/lib/openpets';
import type { AgentAccentStyle } from '@/lib/agentAccent';
import { huddleShortcutIndex, isTextEntryTarget, type HuddleAgentOption } from '@/lib/huddleAgents';

// Who owns the shared voice floor, and how the huddle host changes it mid-call.
//
// One agent is active; everything the room says is routed to it. The rest are
// one click (or one ⌘1…⌘9) away for the host. The chip borrows the accent recipe agent
// avatars already wear in the transcript (.huddle-agent-chip in index.css), so
// the active agent reads as the same person here as it does three inches below.
//
// The keydown listener is window-level and therefore dangerous: it is mounted
// ONLY while `enabled` (a live huddle), removed on unmount and on disconnect,
// declines anything typed into a field, and preventDefaults only the keystrokes
// it actually consumes.

// Only the first nine get a binding — ⌘0 is not a tenth slot anywhere else in
// this app either, and a number with no shortcut behind it is a lie.
const MAX_SHORTCUTS = 9;

const MODIFIER_LABEL = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent || '')
  ? '⌘'
  : 'Ctrl+';

interface HuddleAgentStripProps {
  agents: HuddleAgentOption[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Bind the shortcuts. False whenever there is no live huddle. */
  enabled: boolean;
  /** One shared floor: only the huddle host may publish target changes. */
  selectable?: boolean;
  className?: string;
}

export function HuddleAgentStrip({ agents, activeId, onSelect, enabled, selectable = true, className }: HuddleAgentStripProps) {
  useEffect(() => {
    if (!enabled || !selectable || agents.length === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Typing "⌘1" into the composer must stay a composer keystroke.
      if (isTextEntryTarget(event.target)) return;
      const index = huddleShortcutIndex(event);
      if (index === null || index >= MAX_SHORTCUTS) return;
      const agent = agents[index];
      if (!agent) return;
      event.preventDefault();
      onSelect(agent.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [agents, enabled, onSelect, selectable]);

  if (agents.length === 0) return null;

  return (
    <div
      role="group"
      aria-label="Who your voice goes to"
      className={cn('flex min-w-0 items-center gap-1', className)}
      data-testid="huddle-agent-strip"
    >
      {agents.map((agent, index) => (
        <HuddleAgentChip
          key={agent.id}
          agent={agent}
          index={index}
          active={agent.id === activeId}
          onSelect={onSelect}
          selectable={selectable}
        />
      ))}
    </div>
  );
}

function HuddleAgentChip({
  agent,
  index,
  active,
  onSelect,
  selectable,
}: {
  agent: HuddleAgentOption;
  index: number;
  active: boolean;
  onSelect: (id: string) => void;
  selectable: boolean;
}) {
  const shortcut = index < MAX_SHORTCUTS ? `${MODIFIER_LABEL}${index + 1}` : '';
  const label = !selectable
    ? `${agent.name} is available; only the huddle host can change the floor`
    : active
      ? `${agent.name} is hearing you`
      : `Talk to ${agent.name}${shortcut ? ` (${shortcut})` : ''}`;

  return (
    <button
      type="button"
      onClick={() => onSelect(agent.id)}
      disabled={!selectable}
      aria-pressed={active}
      aria-label={label}
      title={`${agent.name} · @${agent.handle}${shortcut ? ` · ${shortcut}` : ''}`}
      data-active={active}
      style={{ '--agent-accent': agent.accent } as AgentAccentStyle}
      className={cn(
        'huddle-agent-chip flex h-7 shrink-0 items-center gap-1 rounded-md pl-0.5 text-muted-foreground outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring',
        shortcut ? 'pr-1.5' : 'pr-0.5',
      )}
    >
      <HuddleAgentFace agent={agent} />
      {shortcut && (
        <span className="text-[10px] font-semibold leading-none tabular-nums">{index + 1}</span>
      )}
    </button>
  );
}

/**
 * The same three avatar branches the sidebar and the transcript use — animated
 * pet, image, or a fallback — so an agent looks like itself here.
 *
 * The fallback is initials rather than a robot glyph: a strip of identical Bot
 * icons tells you nothing about which one is which, which is the entire job of
 * this control.
 */
function HuddleAgentFace({ agent }: { agent: HuddleAgentOption }) {
  const avatar = agent.avatar;
  const initials = useMemo(() => agentInitials(agent), [agent]);

  if (avatar && isPetSpritesheetAvatar(avatar)) {
    return (
      <span className="animated-pet-avatar-shell size-6 shrink-0 rounded">
        <span
          className="animated-pet-avatar"
          style={{ backgroundImage: `url(${renderablePetAssetUrl(avatar)})` }}
        />
      </span>
    );
  }

  if (avatar && isImageAvatar(avatar)) {
    return (
      <img
        src={renderablePetAssetUrl(avatar)}
        alt=""
        className="size-6 shrink-0 rounded object-cover"
        loading="lazy"
        draggable={false}
      />
    );
  }

  return (
    // bg-foreground/5 rather than bg-muted: a grey tile sits badly inside the
    // accent-tinted active chip, where this should read as part of the tint.
    <span className="grid size-6 shrink-0 place-items-center rounded bg-foreground/5 text-[9px] font-semibold leading-none">
      {initials || <Bot className="size-3.5" aria-hidden />}
    </span>
  );
}

/**
 * Up to two characters that identify this agent at 24px.
 *
 * A short text avatar ("MI", "AI") is already exactly that, so it is used
 * verbatim; anything else falls back to initials from the name. `icon:bot` and
 * friends are avatar KEYS, not text, and must not be printed.
 */
function agentInitials(agent: HuddleAgentOption): string {
  const avatar = agent.avatar.trim();
  if (avatar && !avatar.includes(':') && !avatar.includes('/') && avatar.length <= 2) {
    return avatar.toUpperCase();
  }
  const words = agent.name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}
