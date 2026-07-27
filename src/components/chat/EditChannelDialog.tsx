import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  channelIconChoices, channelProfileDiff, MAX_DESCRIPTION_CHARS, MAX_INTENT_CHARS,
  normalizeChannelIcon, type ChannelProfileDraft,
} from '@/lib/channelProfile';
import { normalizeConversationMode, type ConversationMode } from '@/lib/channelMentions';
import { socialCadenceHint, socialCadenceSummary } from '@/lib/replyCadence';

/**
 * The three reply timings, in the words a person would use for them, most eager
 * first. The 'social' detail is GENERATED from the cadence constants
 * (socialCadenceSummary) rather than written out, so the dialog cannot promise a
 * timing the dispatcher does not keep.
 */
const REPLY_TIMING_CHOICES: Array<{ mode: ConversationMode; title: string; detail: string }> = [
  {
    mode: 'auto',
    title: 'Someone may answer straight away',
    detail: 'The agent it seems meant for chimes in. Often nobody does.',
  },
  {
    mode: 'social',
    title: 'Someone may answer, in their own time',
    detail: socialCadenceSummary(),
  },
  {
    mode: 'mention',
    title: 'Nobody has to answer',
    detail: 'The message just sits here until you ask someone. They can pick it up whenever.',
  },
];

// ---------------------------------------------------------------------------
// EDIT CHANNEL — name, description, icon, and the channel's INTENT.
//
// The intent is the one that does something new. It is the room's house style
// in the owner's own words, and the server injects it into every agent turn
// taken in this channel, so writing "joking is fine, clean language" here
// actually changes how the agents talk here. That is why the field says so
// plainly rather than being labelled "notes" — a field that silently rewires
// agent behaviour must announce itself.
//
// Save sends a SPARSE diff (channelProfileDiff), so renaming a channel does not
// rewrite its intent and two people editing different fields do not clobber
// each other.
// ---------------------------------------------------------------------------

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current stored values. The dialog seeds from these every time it opens. */
  baseline: ChannelProfileDraft;
  /** Persist the diff. Resolves truthy on success; the dialog stays open on failure. */
  onSave: (patch: Partial<ChannelProfileDraft>) => Promise<boolean>;
  status?: string;
}

export function EditChannelDialog({ open, onOpenChange, baseline, onSave, status = '' }: Props) {
  const [draft, setDraft] = useState<ChannelProfileDraft>(baseline);
  const [saving, setSaving] = useState(false);

  // Re-seed on every open, not just on mount: the channel may have changed
  // underneath (someone else renamed it), and a stale draft would silently
  // revert their edit on save.
  useEffect(() => {
    if (open) setDraft(baseline);
  }, [open, baseline]);

  const icons = useMemo(() => channelIconChoices(), []);
  const patch = useMemo(() => channelProfileDiff(draft, baseline), [draft, baseline]);
  const titleEmpty = draft.title.trim().length === 0;

  // The intent is prose, so it is read as a SUGGESTION and nothing else: if it
  // sounds like a social room and the timing is still the eager default, offer to
  // switch. Nothing happens unless the operator clicks. Deriving dispatch
  // behaviour from free text would mean a channel whose replies changed pace
  // because somebody edited a sentence, with no control that said so.
  const cadenceHint = useMemo(() => socialCadenceHint(draft.intent), [draft.intent]);
  const suggestSocial = cadenceHint.social
    && normalizeConversationMode(draft.conversation_mode) === 'auto';

  const handleSave = async () => {
    if (!patch || titleEmpty) return;
    setSaving(true);
    const ok = await onSave(patch);
    setSaving(false);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Wider than the default max-w-lg: this dialog carries a 16-icon grid and
          three full-sentence reply-timing cards, and at 32rem the cards wrapped to
          three lines each and the icons to two rows, which made a short form read
          as a long one. */}
      <DialogContent className="max-h-[calc(100svh-2rem)] max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Edit channel</DialogTitle>
          <DialogDescription>
            How this channel is named, described, and how the people and agents in it behave.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-auto pr-1">
          <div className="space-y-1.5">
            <Label htmlFor="edit-channel-title">Name</Label>
            <Input
              id="edit-channel-title"
              value={draft.title}
              onChange={event => setDraft(prev => ({ ...prev, title: event.target.value }))}
              placeholder="general"
              maxLength={200}
            />
            {titleEmpty && (
              <p className="text-xs text-destructive">
                A channel needs a name to be findable in the sidebar.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-channel-description">Description</Label>
            <Textarea
              id="edit-channel-description"
              value={draft.description}
              onChange={event => setDraft(prev => ({ ...prev, description: event.target.value }))}
              placeholder="What this channel is for."
              rows={2}
              maxLength={MAX_DESCRIPTION_CHARS}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Icon</Label>
            <div className="flex flex-wrap gap-1.5">
              {icons.map(([key, Glyph]) => {
                const active = normalizeChannelIcon(draft.icon) === key;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-label={key}
                    aria-pressed={active}
                    title={key}
                    onClick={() => setDraft(prev => ({ ...prev, icon: active ? '' : key }))}
                    className={cn(
                      'flex size-9 items-center justify-center rounded-md border transition-colors',
                      active
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border bg-background text-muted-foreground hover:bg-muted/50',
                    )}
                  >
                    <Glyph className="size-4" />
                  </button>
                );
              })}
            </div>
          </div>

          {/* Reply timing. The point of 'mention' is that posting in a shared
              channel does not summon an answer — the message is still there, and
              anyone in the channel can pick it up later when someone asks them
              to. Named after what a person would notice, not after the column. */}
          <div className="space-y-1.5">
            <Label>When you post without naming anyone</Label>
            <div className="grid gap-1.5">
              {REPLY_TIMING_CHOICES.map(choice => {
                const active = normalizeConversationMode(draft.conversation_mode) === choice.mode;
                return (
                  <button
                    key={choice.mode}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setDraft(prev => ({ ...prev, conversation_mode: choice.mode }))}
                    className={cn(
                      'rounded-md border px-3 py-2 text-left transition-colors',
                      active
                        ? 'border-primary bg-primary/10'
                        : 'border-border bg-background hover:bg-muted/50',
                    )}
                  >
                    <span className="block text-sm font-medium">{choice.title}</span>
                    <span className="block text-xs text-muted-foreground">{choice.detail}</span>
                  </button>
                );
              })}
            </div>
            {suggestSocial && (
              <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2">
                <p className="text-xs text-muted-foreground">
                  The intent below mentions{' '}
                  <span className="font-medium text-foreground">{cadenceHint.phrase}</span>, which
                  reads like a social channel. Replies here will all arrive at once unless you pace
                  them.
                </p>
                <button
                  type="button"
                  onClick={() => setDraft(prev => ({ ...prev, conversation_mode: 'social' }))}
                  className="mt-1.5 text-xs font-medium text-primary underline-offset-2 hover:underline"
                >
                  Pace them
                </button>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Naming someone always reaches them, at any timing. Use @channel to ask everyone in the
              channel at once.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-channel-intent">Intent</Label>
            <Textarea
              id="edit-channel-intent"
              value={draft.intent}
              onChange={event => setDraft(prev => ({ ...prev, intent: event.target.value }))}
              placeholder="A fun place to share stuff that's not work related and interact with each other. Joking is fine, clean language."
              rows={4}
              maxLength={MAX_INTENT_CHARS}
            />
            <p className="text-xs text-muted-foreground">
              How people should behave here — and how the agents will. Every agent reply in this
              channel is given this, so it sets their tone and subject matter. It does not change
              what an agent is allowed to do.
            </p>
          </div>

          {status && <p className="text-xs text-destructive">{status}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" onClick={() => void handleSave()} disabled={!patch || titleEmpty || saving}>
            {saving ? 'Saving' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
