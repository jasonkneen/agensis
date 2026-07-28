import { useMemo, useState } from 'react';
import { ArrowLeft, Plus, Search } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  CHANNEL_TEMPLATES,
  CHANNEL_TEMPLATE_CATEGORIES,
  canCreateFromTemplate,
  channelDraftFromTemplate,
  filterChannelTemplates,
  type ChannelTemplate,
} from '@/lib/channelTemplates';
import { bridgeSpec } from '@/lib/bridgeProviders';
import { apiUrl, apiAuthHeaders } from '@/lib/backendClient';

// ---------------------------------------------------------------------------
// The "+" beside Channels opens this instead of silently creating "New Channel".
//
// Deliberately the same shape as the agent create gallery (AgentsWindowContent's
// `createStep === 'choose'` branch): search, category tabs, a grid of cards,
// and picking one PREFILLS rather than creates. Matching that layout is the
// point — a second gallery that looked different would read as a different
// kind of thing.
//
// Bridge templates (Telegram, Signal, WhatsApp, OpenClaw) are shown but cannot
// be created: the transport does not exist yet. They open a setup PREVIEW that
// says so. A card that created a dead channel would be worse than no card.
// ---------------------------------------------------------------------------

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Create a channel from the template's prefilled fields. */
  onCreate: (draft: ReturnType<typeof channelDraftFromTemplate>) => void | Promise<void>;
}

export function NewChannelDialog({ open, onOpenChange, onCreate }: Props) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [preview, setPreview] = useState<ChannelTemplate | null>(null);
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(
    () => filterChannelTemplates(CHANNEL_TEMPLATES, category, query),
    [category, query],
  );

  const reset = () => { setQuery(''); setCategory('All'); setPreview(null); setCreating(false); };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const pick = async (tpl: ChannelTemplate) => {
    // A bridge needs credentials before it can be created, so it opens its own
    // setup step rather than creating a channel on the spot.
    if (tpl.kind === 'bridge') { setPreview(tpl); return; }
    if (!canCreateFromTemplate(tpl)) { setPreview(tpl); return; }
    setCreating(true);
    try {
      await onCreate(channelDraftFromTemplate(tpl));
      handleOpenChange(false);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* `sm:` matters: DialogContent's base is `sm:max-w-sm`, and tailwind-merge
          keeps an unprefixed `max-w-3xl` ALONGSIDE it rather than replacing it —
          so above 640px the base media query won and this dialog rendered at
          384px, collapsing the card grid to a single column. */}
      <DialogContent className="sm:max-w-3xl">
        {preview ? (
          <BridgeSetup
            template={preview}
            onBack={() => setPreview(null)}
            onCreate={onCreate}
            onClose={() => handleOpenChange(false)}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New channel</DialogTitle>
              <DialogDescription>
                Pick a starting point. Nothing is created until you choose one, and
                everything a template sets can be changed afterwards in Edit channel.
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-center gap-2">
              <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <Input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search templates"
                aria-label="Search channel templates"
              />
            </div>

            <div className="flex flex-wrap gap-1.5">
              {CHANNEL_TEMPLATE_CATEGORIES.map(cat => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategory(cat)}
                  aria-pressed={category === cat}
                  className={cn(
                    'control-outer-ring rounded-lg border px-2.5 py-1 text-xs font-medium transition',
                    category === cat
                      ? 'border-primary/60 bg-primary/15 text-foreground'
                      : 'border-border bg-card/40 text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                  )}
                >
                  {cat}
                </button>
              ))}
            </div>

            {filtered.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No templates match that search.
              </div>
            ) : (
              <div className="grid max-h-[52vh] gap-3 overflow-y-auto pr-1 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
                {filtered.map(tpl => {
                  const Icon = tpl.icon;
                  const usable = canCreateFromTemplate(tpl);
                  return (
                    <button
                      key={tpl.id}
                      type="button"
                      disabled={creating}
                      onClick={() => void pick(tpl)}
                      className={cn(
                        'group flex min-h-[132px] flex-col items-start gap-2 rounded-xl border p-4 text-left transition-all duration-200',
                        'hover:-translate-y-0.5 hover:border-primary/60 hover:bg-card/80 hover:shadow-lg hover:shadow-black/10 dark:hover:shadow-black/30',
                        usable ? 'border-border bg-card/40' : 'border-dashed border-border bg-card/20',
                      )}
                    >
                      <span className="grid size-9 place-items-center rounded-lg bg-muted">
                        <Icon className="size-5" />
                      </span>
                      <span className="text-sm font-semibold">{tpl.name}</span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">{tpl.description}</span>
                      <span className="mt-auto text-[11px] text-muted-foreground opacity-70">
                        {usable ? tpl.category : 'Preview only'}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Setting up a bridge: create the channel, then attach the transport to it.
 *
 * The order matters and is not negotiable — a bridge row references a
 * session_id, so the channel has to exist first. If the bridge call then fails
 * (bad bot token, usually) the channel SURVIVES rather than being rolled back:
 * the user's other settings are already on it, and re-entering one token beats
 * re-creating everything. The channel is left plain, and Edit channel can
 * retry the connection.
 */
function BridgeSetup({
  template, onBack, onCreate, onClose,
}: {
  template: ChannelTemplate;
  onBack: () => void;
  onCreate: (draft: ReturnType<typeof channelDraftFromTemplate>) => void | Promise<void>;
  onClose: () => void;
}) {
  const Icon = template.icon;
  const spec = bridgeSpec(template.id);
  const [values, setValues] = useState<Record<string, string>>({});
  const [externalId, setExternalId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Set once the bridge exists. Slack's delivery URL contains the bridge id, so
  // it cannot be shown before creation — and the user needs it to finish setup
  // in Slack. Holding the dialog open on this result is the only honest order.
  const [created, setCreated] = useState<{ eventUrl?: string; setupHint?: string; needsDaemon?: boolean } | null>(null);

  const submit = async () => {
    if (!spec) return;
    const missing = spec.fields.filter(f => !String(values[f.key] || '').trim());
    if (missing.length) {
      setError(`Fill in ${missing.map(f => f.label).join(' and ')}.`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const session = await onCreate(channelDraftFromTemplate(template));
      const sessionId = (session as { id?: string } | undefined)?.id;
      if (!sessionId) throw new Error('The channel was created but its id came back empty.');

      const res = await fetch(apiUrl('/backend/bridges'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({ sessionId, provider: template.id, externalId: externalId.trim(), config: values }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.error) throw new Error(json?.error?.message || json?.error || `Connect failed (${res.status})`);
      // Slack needs its event URL pasted back into the Slack app, and the daemon
      // providers need a moment to report a QR — so the dialog stays open on the
      // result rather than vanishing at the point the user still has work to do.
      if (json?.data?.eventUrl && spec.provider === 'slack') { setCreated(json.data); return; }
      if (spec.lane === 'daemon') { setCreated(json.data ?? {}); return; }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="icon-xs" onClick={onBack} aria-label="Back to templates">
            <ArrowLeft />
          </Button>
          <span className="grid size-7 place-items-center rounded-lg bg-muted">
            <Icon className="size-4" />
          </span>
          <DialogTitle>{template.name}</DialogTitle>
        </div>
        <DialogDescription>{template.description}</DialogDescription>
      </DialogHeader>

      {spec?.warning && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-foreground">
          {spec.warning}
        </div>
      )}

      <p className="text-sm text-muted-foreground">{spec?.summary}</p>

      {/* Credentials the user copies out of somebody else's dashboard. They are
          write-only: the API never sends them back, so an existing bridge shows
          blank fields rather than a masked value that cannot be edited. */}
      {spec?.fields.map(field => (
        <div key={field.key}>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {field.label}
          </label>
          <Input
            type={field.secret ? 'password' : 'text'}
            value={values[field.key] ?? ''}
            placeholder={field.placeholder}
            autoComplete="off"
            onChange={e => setValues(v => ({ ...v, [field.key]: e.target.value }))}
          />
          {field.help && <p className="mt-1 text-xs text-muted-foreground">{field.help}</p>}
        </div>
      ))}

      {spec?.externalIdLabel && (
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {spec.externalIdLabel}
          </label>
          <Input
            value={externalId}
            placeholder={spec.externalIdPlaceholder}
            autoComplete="off"
            onChange={e => setExternalId(e.target.value)}
          />
          {spec.externalIdHelp && <p className="mt-1 text-xs text-muted-foreground">{spec.externalIdHelp}</p>}
        </div>
      )}

      {spec && spec.steps.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Then, in {template.name}
          </div>
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
            {spec.steps.map(step => <li key={step}>{step}</li>)}
          </ol>
        </div>
      )}

      {created?.eventUrl && (
        <div className="rounded-lg border border-border bg-background p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Event URL</div>
          <code className="mt-1 block break-all text-xs text-foreground">{created.eventUrl}</code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void navigator.clipboard?.writeText(created.eventUrl ?? '')}
          >
            Copy
          </Button>
        </div>
      )}

      {created?.needsDaemon && (
        <p className="text-sm text-amber-600 dark:text-amber-400">
          The channel is connected, but no agensis daemon is running in this workspace yet —
          this bridge starts as soon as one connects.
        </p>
      )}

      {created && !created.eventUrl && !created.needsDaemon && (
        <p className="text-sm text-muted-foreground">
          Connected. {created.setupHint}
        </p>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end gap-2">
        {created ? (
          <Button type="button" size="sm" onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button type="button" variant="outline" size="sm" onClick={onBack} disabled={busy}>
              Back
            </Button>
            <Button type="button" size="sm" onClick={() => void submit()} disabled={busy}>
              <Plus data-icon="inline-start" />
              {busy ? 'Connecting…' : 'Create and connect'}
            </Button>
          </>
        )}
      </div>
    </>
  );
}
