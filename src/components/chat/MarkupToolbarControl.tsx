// A toolbar-level entry point for the element picker, sitting next to the
// channel's "..." menu. Collapsed it is a single icon; once you are marking up
// it expands into a pill with a picking on/off toggle, a trash can (clear the
// marks you collected) and send. Send routes the picked elements straight to
// ONE agent: it asks which the first time, then remembers that agent ("always
// send") per channel so later sends go through without asking again.
//
// It deliberately keeps NO picker state of its own — `open`/`picking`/`pickCount`
// mirror the composer's `pickerActive`/`picks` — so the pill and the composer
// chips never disagree about what has been selected.
//
// The root carries data-picker-ignore so that, while the picking cursor is
// live, clicking the pill's own buttons never registers as selecting the pill.

import { useState } from 'react';
import { ChevronDown, MousePointerClick, Send, SquareDashedMousePointer, Trash2, X } from 'lucide-react';
import { Button } from '@agensis/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@agensis/ui/components/popover';
import { Checkbox } from '@agensis/ui/components/checkbox';
import { AgentAvatar } from '../agents/AgentAvatar';
import { cn } from '@/lib/utils';

export interface MarkupAgent {
  id: string;
  handle: string;
  name: string;
  avatar?: string;
}

export function MarkupToolbarControl({
  open,
  picking,
  pickCount,
  agents,
  alwaysHandle,
  onTogglePicking,
  onClear,
  onSend,
  onSetAlways,
  className,
}: {
  /** Pill when true, single icon when false. Mirror of `pickerActive || picks.length > 0`. */
  open: boolean;
  /** The picking cursor is live (`pickerActive`). */
  picking: boolean;
  pickCount: number;
  /** Channel agents that markup can be sent to, in roster order. */
  agents: MarkupAgent[];
  /** Resolved "always send" handle — already validated against `agents` — or null to ask. */
  alwaysHandle: string | null;
  onTogglePicking: () => void;
  onClear: () => void;
  onSend: (handle: string) => void;
  onSetAlways: (handle: string | null) => void;
  className?: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // Default the checkbox on: the common case is "send to this agent from now on".
  const [remember, setRemember] = useState(true);

  const canSend = pickCount > 0 && agents.length > 0;

  const chooseAgent = (handle: string) => {
    onSend(handle);
    onSetAlways(remember ? handle : null);
    setPickerOpen(false);
  };

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-picker-ignore=""
        className={cn('h-8 w-8', className)}
        aria-label="Mark up the page for an agent"
        title="Mark up the page for an agent"
        onClick={onTogglePicking}
      >
        <SquareDashedMousePointer />
      </Button>
    );
  }

  const agentList = (
    <PopoverContent align="end" className="w-56 p-1">
      <div className="px-2 py-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Send markup to
      </div>
      <div className="max-h-56 space-y-0.5 overflow-y-auto">
        {agents.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">No agents in this channel.</div>
        ) : (
          agents.map(agent => (
            <button
              key={agent.id}
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              onClick={() => chooseAgent(agent.handle)}
            >
              <AgentAvatar
                avatar={agent.avatar}
                name={agent.name}
                initials={agent.name.slice(0, 2).toUpperCase()}
                className="size-5 rounded-md"
                fallbackClassName="bg-muted text-3xs text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              {alwaysHandle === agent.handle && (
                <span className="shrink-0 text-2xs text-muted-foreground">always</span>
              )}
            </button>
          ))
        )}
      </div>
      <label className="mt-1 flex cursor-pointer items-center gap-2 border-t border-border px-2 py-2 text-xs text-muted-foreground">
        <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} />
        Always send to this agent
      </label>
      {alwaysHandle && (
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted"
          onClick={() => { onSetAlways(null); setPickerOpen(false); }}
        >
          <X className="size-3 shrink-0" />
          Stop always-sending
        </button>
      )}
    </PopoverContent>
  );

  return (
    <div
      data-picker-ignore=""
      className={cn('flex h-8 shrink-0 items-center gap-0.5 rounded-full border border-border bg-muted/60 px-1', className)}
      role="group"
      aria-label="Page markup"
    >
      {/* on/off for the picking cursor. It stays in the pill when off so you can
          still clear or send the marks you already made. */}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={picking ? 'Stop selecting elements' : 'Select elements'}
        aria-pressed={picking}
        title={picking ? 'Stop selecting' : 'Select elements'}
        className={cn('size-6 rounded-full', picking && 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground')}
        onClick={onTogglePicking}
      >
        <MousePointerClick className="size-3.5" />
      </Button>
      <span
        className="min-w-4 px-0.5 text-center text-2xs font-semibold tabular-nums text-muted-foreground"
        aria-label={`${pickCount} element${pickCount === 1 ? '' : 's'} marked`}
      >
        {pickCount}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Delete markup"
        title="Delete markup"
        className="size-6 rounded-full"
        disabled={pickCount === 0}
        onClick={onClear}
      >
        <Trash2 className="size-3.5" />
      </Button>
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        {alwaysHandle ? (
          <>
            {/* Remembered agent: send goes straight through; the chevron reopens
                the chooser to switch agent or stop always-sending. */}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Send markup to @${alwaysHandle}`}
              title={`Send to @${alwaysHandle}`}
              className="size-6 rounded-full text-primary hover:text-primary"
              disabled={!canSend}
              onClick={() => { if (canSend) onSend(alwaysHandle); }}
            >
              <Send className="size-3.5" />
            </Button>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Change agent"
                title="Change agent"
                className="size-6 rounded-full"
              >
                <ChevronDown className="size-3" />
              </Button>
            </PopoverTrigger>
          </>
        ) : (
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Send markup to an agent"
              title="Send to an agent"
              className="size-6 rounded-full text-primary hover:text-primary"
              disabled={!canSend}
            >
              <Send className="size-3.5" />
            </Button>
          </PopoverTrigger>
        )}
        {agentList}
      </Popover>
    </div>
  );
}
