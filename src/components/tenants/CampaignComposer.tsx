import React, { useCallback, useMemo, useState } from 'react';
import { ChevronDown, Megaphone, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { PANE_HEADER, SCROLL_VIEWPORT_BLOCK, TEXT_BODY, TEXT_META } from '../inbox/inboxPresentation';
import { useTenantCampaigns } from '../../hooks/useTenantCampaigns';
import {
  CAMPAIGN_SURFACE_INFO,
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  campaignBlockedReason,
  campaignConfirmSentence,
  campaignSurfaceLabel,
  charactersLeft,
  EMPTY_SEGMENT,
  segmentAccountIds,
  toggleSegmentAccount,
  type CampaignCondition,
  type CampaignSegment,
  type CampaignSurface,
} from '../../lib/tenantCampaigns';
import { tenantDisplayName, type TenantAccount } from '../../lib/tenants';

// ---------------------------------------------------------------------------
// MESSAGE ACCOUNTS — segment, then send.
//
// A broadcast tool writes into other people's UI, so this component is built
// around making an accidental send impossible rather than around making a
// deliberate one fast:
//
//   * THE COUNT IS ALWAYS ON SCREEN and comes from the server, not from
//     anything computed here (see useTenantCampaigns for why).
//   * WHO MATCHED IS INSPECTABLE before sending. A segment you cannot read is
//     how the wrong four hundred people get messaged.
//   * NOTHING SENDS ON ENTER. The title input swallows Enter outright and the
//     body is a textarea where Enter is a newline. The only path to a send is
//     the button, and the button opens a confirm.
//   * THE CONFIRM STATES THE NUMBER AND THE SURFACE, and the confirming button
//     repeats the number — "Send to 38 accounts", never "Confirm".
//
// The composer is a MODE of the Tenants window, not a dialog: composing a
// segment means reading a list of accounts, and a modal over the list would hide
// exactly the thing being decided.
// ---------------------------------------------------------------------------

interface CampaignComposerProps {
  /** The loaded tenant list, so recipients can be picked by hand. */
  accounts: readonly TenantAccount[];
  onClose: () => void;
}

export const CampaignComposer = React.memo(function CampaignComposer({ accounts, onClose }: CampaignComposerProps) {
  const [segment, setSegment] = useState<CampaignSegment>(EMPTY_SEGMENT);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [surface, setSurface] = useState<CampaignSurface>('tip');
  const [showMatches, setShowMatches] = useState(false);
  const [pickQuery, setPickQuery] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const {
    categories, preview, previewLoading, previewError, history, sending, sendError, send,
  } = useTenantCampaigns(true, segment);

  const conditionFor = useCallback(
    (categoryId: string) => segment.conditions.find(condition => condition.category === categoryId) ?? null,
    [segment.conditions],
  );

  const toggleCategory = useCallback((categoryId: string, takesDays: boolean) => {
    setSegment(current => {
      const existing = current.conditions.some(condition => condition.category === categoryId);
      if (existing) {
        return { ...current, conditions: current.conditions.filter(c => c.category !== categoryId) };
      }
      const next: CampaignCondition = { category: categoryId, negate: false };
      if (takesDays) next.days = 30;
      return { ...current, conditions: [...current.conditions, next] };
    });
  }, []);

  const updateCondition = useCallback((categoryId: string, patch: Partial<CampaignCondition>) => {
    setSegment(current => ({
      ...current,
      conditions: current.conditions.map(condition => (
        condition.category === categoryId ? { ...condition, ...patch } : condition
      )),
    }));
  }, []);

  const namedIds = segmentAccountIds(segment);
  const namedAccounts = useMemo(
    () => namedIds.map(id => accounts.find(a => a.id === id)).filter((a): a is TenantAccount => Boolean(a)),
    [namedIds, accounts],
  );
  // Search is over the loaded list, same as the Tenants list itself — no round
  // trip, and it cannot disagree with what the operator just saw there.
  const pickMatches = useMemo(() => {
    const q = pickQuery.trim().toLowerCase();
    if (!q) return [];
    return accounts
      .filter(a => `${a.email} ${a.display_name}`.toLowerCase().includes(q))
      .slice(0, 20);
  }, [pickQuery, accounts]);

  const blocked = campaignBlockedReason({ title, body, segment, preview, previewLoading });
  const matchedCount = preview?.matched_count ?? 0;

  const handleSend = useCallback(async () => {
    // The count sent is the one rendered in the confirm the operator just read.
    // If the server's own count differs it answers 409 and nothing is written.
    const sent = await send({ title, body, surface, segment, confirmCount: matchedCount });
    setConfirmOpen(false);
    if (!sent) return;
    toast.success(`Sent to ${sent.recipient_count} ${sent.recipient_count === 1 ? 'account' : 'accounts'}`);
    setTitle('');
    setBody('');
    setSegment(EMPTY_SEGMENT);
  }, [send, title, body, surface, segment, matchedCount]);

  const selectedSurface = useMemo(
    () => CAMPAIGN_SURFACE_INFO.find(info => info.id === surface) ?? CAMPAIGN_SURFACE_INFO[0],
    [surface],
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-card text-card-foreground">
      <div className={PANE_HEADER}>
        <Megaphone aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
        <span className={cn('min-w-0 flex-1 truncate font-medium text-foreground', TEXT_BODY)}>
          Message accounts
        </span>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close composer">
          <X />
        </Button>
      </div>

      <ScrollArea className={cn('min-h-0 flex-1', SCROLL_VIEWPORT_BLOCK)}>
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">

          {/* --- 1. WHO ------------------------------------------------- */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <h3 className={cn('font-semibold text-foreground', TEXT_BODY)}>Who gets it</h3>
              <div className="ml-auto flex items-center gap-1 rounded-lg border border-border p-0.5">
                {(['all', 'any'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setSegment(current => ({ ...current, match: mode }))}
                    className={cn(
                      'rounded-md px-2 py-1 text-xs transition',
                      segment.match === mode
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {mode === 'all' ? 'Match all' : 'Match any'}
                  </button>
                ))}
              </div>
            </div>
            <p className={cn('text-muted-foreground', TEXT_META)}>
              {segment.match === 'all'
                ? 'An account has to satisfy every filter you tick.'
                : 'An account has to satisfy at least one filter you tick.'}
            </p>

            <div className="flex flex-col gap-1">
              {categories.map(category => {
                const condition = conditionFor(category.id);
                const checked = condition !== null;
                return (
                  <div
                    key={category.id}
                    className={cn(
                      'flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5',
                      checked && 'bg-muted/50',
                    )}
                  >
                    <Checkbox
                      id={`campaign-filter-${category.id}`}
                      checked={checked}
                      onCheckedChange={() => toggleCategory(category.id, category.days)}
                    />
                    <Label
                      htmlFor={`campaign-filter-${category.id}`}
                      className={cn('cursor-pointer font-normal', TEXT_BODY)}
                    >
                      {category.label}
                    </Label>

                    {checked && category.days && (
                      <Input
                        type="number"
                        min={1}
                        max={3650}
                        value={condition?.days ?? 30}
                        onChange={event => updateCondition(category.id, {
                          days: Math.max(1, Math.min(3650, Number(event.target.value) || 1)),
                        })}
                        aria-label={`Days for ${category.label}`}
                        className="h-7 w-20 px-2 py-0 text-xs"
                      />
                    )}

                    {/* Negation as a per-condition toggle rather than a second
                        list of "opposite" filters: one filter, two directions,
                        so the set of categories cannot drift out of sync with
                        its own inverses. */}
                    {checked && (
                      <button
                        type="button"
                        onClick={() => updateCondition(category.id, { negate: !condition?.negate })}
                        className={cn(
                          'ml-auto rounded-md border px-2 py-0.5 text-[0.7rem] transition',
                          condition?.negate
                            ? 'border-primary/60 bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:text-foreground',
                        )}
                        title="Invert this filter"
                      >
                        {condition?.negate ? 'NOT' : 'is'}
                      </button>
                    )}
                  </div>
                );
              })}
              {categories.length === 0 && (
                <p className={cn('px-2 text-muted-foreground', TEXT_META)}>Loading filters…</p>
              )}
            </div>
          </section>

          {/* --- 1b. SEND TO SPECIFIC PEOPLE ---------------------------- */}
          {/* Named recipients are ADDED to whatever the filters match, never
              intersected with them: someone picked by hand must never be
              silently dropped by a filter they happen to fail. */}
          <section className="rounded-xl border border-border bg-muted/30 p-3">
            <div className={cn('mb-1.5 font-semibold text-foreground', TEXT_BODY)}>
              Send to specific people
            </div>
            <p className={cn('mb-2 text-muted-foreground', TEXT_META)}>
              Anyone chosen here receives the message regardless of the filters above.
            </p>
            {namedAccounts.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1">
                {namedAccounts.map(account => (
                  <button
                    key={account.id}
                    type="button"
                    className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-xs hover:bg-muted"
                    onClick={() => setSegment(current => toggleSegmentAccount(current, account.id))}
                    aria-label={`Remove ${tenantDisplayName(account)}`}
                  >
                    <span className="min-w-0 truncate">{tenantDisplayName(account)}</span>
                    <X className="size-3 shrink-0 opacity-60" />
                  </button>
                ))}
              </div>
            )}
            <input
              type="search"
              value={pickQuery}
              onChange={event => setPickQuery(event.target.value)}
              placeholder="Search accounts by name or email"
              aria-label="Search accounts to send to"
              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-ring"
            />
            {pickQuery.trim() && (
              <ul className="mt-1.5 max-h-48 overflow-y-auto rounded-lg border border-border bg-card">
                {pickMatches.length === 0 ? (
                  <li className={cn('px-2.5 py-2 text-muted-foreground', TEXT_META)}>No accounts match.</li>
                ) : pickMatches.map(account => {
                  const picked = namedIds.includes(account.id);
                  return (
                    <li key={account.id}>
                      <button
                        type="button"
                        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted"
                        onClick={() => setSegment(current => toggleSegmentAccount(current, account.id))}
                      >
                        <span className={cn('min-w-0 flex-1 truncate', TEXT_BODY)}>
                          {tenantDisplayName(account)}
                        </span>
                        <span className={cn('min-w-0 shrink-0 text-muted-foreground', TEXT_META)}>
                          {picked ? 'Added' : 'Add'}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* --- 2. HOW MANY, AND WHICH -------------------------------- */}
          <section className="rounded-xl border border-border bg-muted/30 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('font-semibold text-foreground', TEXT_BODY)}>
                {segment.conditions.length === 0 && namedIds.length === 0
                  ? 'No filters — nobody selected'
                  : previewLoading
                    ? 'Counting…'
                    : `${matchedCount} of ${preview?.total_accounts ?? 0} accounts match`}
              </span>
              {preview && matchedCount > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-7"
                  onClick={() => setShowMatches(open => !open)}
                >
                  {showMatches ? 'Hide' : 'Show who matches'}
                  <ChevronDown className={cn('size-3.5 transition-transform', showMatches && 'rotate-180')} />
                </Button>
              )}
            </div>
            {preview?.summary && segment.conditions.length > 0 && (
              <p className={cn('mt-1 text-muted-foreground', TEXT_META)}>{preview.summary}</p>
            )}
            {previewError && (
              <p className={cn('mt-1 text-destructive', TEXT_META)}>{previewError}</p>
            )}

            {showMatches && preview && (
              <ul className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-border bg-card">
                {preview.accounts.map(account => (
                  <li
                    key={account.id}
                    className={cn('flex items-center gap-2 border-b border-border/50 px-2.5 py-1.5 last:border-b-0', TEXT_META)}
                  >
                    <span className="min-w-0 flex-1 truncate text-foreground">{account.email}</span>
                    {account.display_name && (
                      <span className="shrink-0 truncate text-muted-foreground">{account.display_name}</span>
                    )}
                  </li>
                ))}
                {preview.truncated && (
                  <li className={cn('px-2.5 py-1.5 text-muted-foreground', TEXT_META)}>
                    Showing the first {preview.accounts.length} of {matchedCount}.
                  </li>
                )}
              </ul>
            )}
          </section>

          {/* --- 3. WHERE IT APPEARS ----------------------------------- */}
          <section className="flex flex-col gap-2">
            <h3 className={cn('font-semibold text-foreground', TEXT_BODY)}>Where it appears</h3>
            <div className="flex flex-col gap-1.5">
              {CAMPAIGN_SURFACE_INFO.map(info => (
                <button
                  key={info.id}
                  type="button"
                  onClick={() => setSurface(info.id)}
                  className={cn(
                    'rounded-lg border p-2.5 text-left transition',
                    surface === info.id
                      ? 'border-primary/60 bg-primary/5'
                      : 'border-border hover:border-border/80',
                  )}
                >
                  <div className={cn('font-medium text-foreground', TEXT_BODY)}>{info.label}</div>
                  <p className={cn('mt-0.5 text-muted-foreground', TEXT_META)}>{info.description}</p>
                </button>
              ))}
            </div>
          </section>

          {/* --- 4. THE MESSAGE ---------------------------------------- */}
          <section className="flex flex-col gap-2">
            <h3 className={cn('font-semibold text-foreground', TEXT_BODY)}>The message</h3>
            <div>
              <Input
                value={title}
                maxLength={MAX_TITLE_LENGTH}
                onChange={event => setTitle(event.target.value)}
                // Enter must never send. This is the keystroke that would do it
                // in every other composer in the app, and here it would mean a
                // broadcast nobody confirmed.
                onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }}
                placeholder="Title"
                aria-label="Message title"
              />
              <p className={cn('mt-1 text-right text-muted-foreground/80', TEXT_META)}>
                {charactersLeft(title, MAX_TITLE_LENGTH)} left
              </p>
            </div>
            <div>
              <Textarea
                value={body}
                maxLength={MAX_BODY_LENGTH}
                onChange={event => setBody(event.target.value)}
                placeholder="What you want them to know. Plain text — links are not rendered."
                aria-label="Message body"
                rows={5}
              />
              <p className={cn('mt-1 text-right text-muted-foreground/80', TEXT_META)}>
                {charactersLeft(body, MAX_BODY_LENGTH)} left
              </p>
            </div>
          </section>

          {/* --- 5. SEND ----------------------------------------------- */}
          <section className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <div className="min-w-0 flex-1">
              {blocked
                ? <p className={cn('text-muted-foreground', TEXT_META)}>{blocked}</p>
                : <p className={cn('text-foreground', TEXT_META)}>{campaignConfirmSentence(matchedCount, surface)}</p>}
              {sendError && <p className={cn('mt-0.5 text-destructive', TEXT_META)}>{sendError}</p>}
            </div>
            <Button
              type="button"
              disabled={blocked !== null || sending}
              onClick={() => setConfirmOpen(true)}
            >
              Review and send
            </Button>
          </section>

          {/* --- 6. WHAT HAS BEEN SENT --------------------------------- */}
          {history.length > 0 && (
            <section className="flex flex-col gap-2 border-t border-border pt-3">
              <h3 className={cn('font-semibold text-foreground', TEXT_BODY)}>Sent</h3>
              <ul className="flex flex-col gap-2">
                {history.map(campaign => (
                  <li key={campaign.id} className="rounded-lg border border-border p-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn('min-w-0 flex-1 truncate font-medium text-foreground', TEXT_BODY)}>
                        {campaign.title}
                      </span>
                      <Badge variant="secondary" className="text-[0.65rem]">
                        {campaignSurfaceLabel(campaign.surface)}
                      </Badge>
                    </div>
                    <p className={cn('mt-0.5 text-muted-foreground', TEXT_META)}>
                      {campaign.recipient_count} sent · {campaign.dismissed_count} dismissed · {campaign.summary}
                    </p>
                    <p className={cn('mt-0.5 text-muted-foreground/70', TEXT_META)}>
                      {campaign.created_by_email}
                      {campaign.created_at ? ` · ${new Date(campaign.created_at).toLocaleString()}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </ScrollArea>

      {/* The confirm. States the exact number and the exact surface, and the
          action button repeats the number — a button that says "Confirm" is a
          button people press without reading. */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send this to {matchedCount} {matchedCount === 1 ? 'account' : 'accounts'}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2">
                <span>{campaignConfirmSentence(matchedCount, surface)}</span>
                <span className="text-muted-foreground">
                  Matching on: {preview?.summary || 'nothing selected'}
                </span>
                <span className="rounded-lg border border-border bg-muted/40 p-2.5 text-foreground">
                  <span className="block font-medium">{title}</span>
                  <span className="mt-0.5 block whitespace-pre-line text-muted-foreground">{body}</span>
                </span>
                <span className="text-muted-foreground">
                  It appears as {selectedSurface.label.toLowerCase()} and can be dismissed. There is no way to
                  un-send it.
                </span>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={sending || matchedCount === 0}
              onClick={event => { event.preventDefault(); void handleSend(); }}
            >
              Send to {matchedCount} {matchedCount === 1 ? 'account' : 'accounts'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});
