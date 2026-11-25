import { ArrowUp, Bot } from 'lucide-react';
import { Button } from '@agensis/ui/components/button';
import { Spinner } from '@agensis/ui/components/spinner';
import { InputGroupButton } from '@agensis/ui/components/input-group';
import { AI_MODELS } from '../../types';
import { cn } from '../../lib/utils';

// Pieces every message composer shares. The channel, thread and sub-thread
// composers each carried their own send button, so they drifted in shape,
// icon and label; there is one now.

/**
 * The round send button at the right end of a composer's control row.
 * `aria-disabled` is NOT used instead of `disabled`: the existing composers
 * and their tests rely on the real disabled state, and Enter-to-send goes
 * through the same handler.
 */
export function ComposerSendButton({
  onClick,
  disabled,
  busy,
  label = 'Send message',
}: {
  onClick: () => void;
  disabled: boolean;
  busy: boolean;
  label?: string;
}) {
  return (
    <Button
      type="button"
      size="icon-sm"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      data-composer-send
      className="rounded-full"
    >
      {busy ? <Spinner /> : <ArrowUp />}
    </Button>
  );
}

/** "Opus 5.5" for a known model id, the raw id otherwise, "Auto" when unset. */
function composerModelLabel(model?: string | null): string {
  const id = String(model || '').trim();
  if (!id) return 'Auto';
  return AI_MODELS.find(entry => entry.id === id)?.label || id;
}

/**
 * Who will answer in a direct message, and on which model: "Coder · Opus 5.5".
 * Sits in the control row so the person can see it before sending, the way a
 * model chip does in a coding app. It is not a model switcher — an agent's
 * model is part of its profile — so clicking opens the profile, where it is
 * changed.
 */
export function ComposerAgentChip({
  name,
  model,
  onClick,
}: {
  name: string;
  model?: string | null;
  onClick?: () => void;
}) {
  const modelLabel = composerModelLabel(model);
  const title = `${name} answers on ${modelLabel}. Open the profile to change it.`;
  return (
    <InputGroupButton
      size="xs"
      variant="ghost"
      onClick={onClick}
      disabled={!onClick}
      aria-label={title}
      title={title}
      data-composer-agent-chip
      className={cn('min-w-0 max-w-[16rem] gap-1.5 text-muted-foreground hover:text-foreground')}
    >
      <Bot className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {name}
        <span className="text-muted-foreground/70"> · </span>
        <span className="font-semibold text-foreground/90">{modelLabel}</span>
      </span>
    </InputGroupButton>
  );
}
