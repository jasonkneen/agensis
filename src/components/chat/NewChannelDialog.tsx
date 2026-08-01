import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Plus } from 'lucide-react';
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
  canCreateFromTemplate,
  channelDraftFromTemplate,
  type ChannelTemplate,
} from '@/lib/channelTemplates';
import {
  applyTemplateName,
  canAdvanceToMembers,
  composeChannelDraft,
  duplicateChannelName,
  type ChannelCreateDraft,
  type ChannelCreateStep,
} from '@/lib/channelCreateFlow';
import { ChannelMemberStep, type MemberChoice } from './ChannelMemberStep';
import { bridgeSpec } from '@/lib/bridgeProviders';
import { apiUrl, apiAuthHeaders } from '@/lib/backendClient';
import type { AgentConnection, ChatSession, WorkspaceAgent } from '@/types';
import { NostrCommunitySetup } from './NostrCommunitySetup';
import type { NostrConnection } from '@/lib/nostrCommunities';

// ---------------------------------------------------------------------------
// The "+" beside Channels opens this instead of silently creating "New Channel".
//
// TWO STEPS, in the order the owner asked for:
//
//   1. NAME. Autofocused, and the very first thing asked — because the name is
//      what everything else is derived from. Before this, picking the "Custom
//      channel" card created a channel called literally "New Channel" (its
//      template title is '', so createSession's fallback won) and left the user
//      to go and find Edit channel. That was the worst thing about this dialog.
//
//   2. MEMBERS, suggested FROM that name. Ranked locally — see
//      src/lib/channelMemberSuggestions.ts. Suggested, never added: the roster
//      decides who answers in the room.
//
// Templates moved from being the gate to being a MODIFIER: a compact chip row
// under the name field that sets icon / description / intent / conversation
// mode, and fills the name only if it is still empty. They stopped being a
// wall between the user and a named channel.
//
// Bridge templates keep their existing path untouched: they still go straight
// to BridgeSetup, which creates the channel and THEN attaches the transport in
// an order that is load-bearing and documented below. They skip step 2.
// ---------------------------------------------------------------------------

const CUSTOM_TEMPLATE = CHANNEL_TEMPLATES.find(tpl => tpl.id === 'custom') ?? CHANNEL_TEMPLATES[0];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Create the channel. RETURNS the created session — BridgeSetup needs its id
   * to attach a transport to it.
   */
  onCreate: (draft: ChannelCreateDraft | ReturnType<typeof channelDraftFromTemplate>) =>
    Promise<{ id?: string } | null | undefined> | { id?: string } | null | undefined;
  workspaceId: string | null;
  agents: WorkspaceAgent[];
  agentConnections: AgentConnection[];
  sessions: ChatSession[];
  nostrConnection?: NostrConnection | null;
  onNostrChange?: () => void;
}

export function NewChannelDialog({
  open, onOpenChange, onCreate, workspaceId, agents, agentConnections, sessions,
  nostrConnection = null, onNostrChange,
}: Props) {
  const [step, setStep] = useState<ChannelCreateStep>('name');
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<ChannelTemplate>(CUSTOM_TEMPLATE);
  const [selected, setSelected] = useState<MemberChoice[]>([]);
  const [preview, setPreview] = useState<ChannelTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && step === 'name') {
      // Focus after the dialog's own open animation, or Radix moves focus back.
      const timer = setTimeout(() => nameRef.current?.focus(), 60);
      return () => clearTimeout(timer);
    }
  }, [open, step]);

  const reset = () => {
    setStep('name');
    setName('');
    setTemplate(CUSTOM_TEMPLATE);
    setSelected([]);
    setPreview(null);
    setCreating(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const nativeTemplates = useMemo(() => CHANNEL_TEMPLATES.filter(tpl => tpl.kind === 'native'), []);
  const bridgeTemplates = useMemo(() => CHANNEL_TEMPLATES.filter(tpl => tpl.kind === 'bridge'), []);

  const duplicate = useMemo(() => duplicateChannelName(sessions, name), [sessions, name]);
  const canAdvance = canAdvanceToMembers(name);

  const pickTemplate = (tpl: ChannelTemplate) => {
    // A bridge needs credentials before anything exists, so it keeps its own
    // path and never reaches the member step.
    if (tpl.kind === 'bridge' || !canCreateFromTemplate(tpl)) { setPreview(tpl); return; }
    setTemplate(tpl);
    setName(current => applyTemplateName(current, tpl));
  };

  const create = async () => {
    if (!canAdvance) return;
    setCreating(true);
    try {
      await onCreate(composeChannelDraft(template, name, selected));
      handleOpenChange(false);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* `sm:` matters: DialogContent's base is `sm:max-w-sm`, and tailwind-merge
          keeps an unprefixed `max-w-2xl` ALONGSIDE it rather than replacing it —
          so above 640px the base media query won and this dialog rendered at
          384px, collapsing its content to a single cramped column. */}
      <DialogContent className="flex max-h-[calc(100svh-2rem)] flex-col sm:max-w-2xl">
        {nostrConnection ? (
          <NostrCommunitySetup
            workspaceId={workspaceId}
            existingConnection={nostrConnection}
            onBack={() => handleOpenChange(false)}
            onCreate={onCreate}
            onClose={() => handleOpenChange(false)}
            onCommunityChange={onNostrChange}
          />
        ) : preview?.id === 'nostr' ? (
          <NostrCommunitySetup
            workspaceId={workspaceId}
            onBack={() => setPreview(null)}
            onCreate={onCreate}
            onClose={() => handleOpenChange(false)}
            onCommunityChange={onNostrChange}
          />
        ) : preview ? (
          <BridgeSetup
            template={preview}
            onBack={() => setPreview(null)}
            onCreate={onCreate}
            onClose={() => handleOpenChange(false)}
          />
        ) : step === 'name' ? (
          <>
            <DialogHeader>
              <DialogTitle>New channel</DialogTitle>
              <DialogDescription>
                Name it first — the name is what suggests who to add next. Nothing is created
                until you finish, and everything here can be changed later in Edit channel.
              </DialogDescription>
            </DialogHeader>

            <div>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-card/40 px-3">
                <span aria-hidden className="text-base font-medium text-muted-foreground">#</span>
                <Input
                  ref={nameRef}
                  value={name}
                  onChange={event => setName(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && canAdvance) { event.preventDefault(); setStep('members'); }
                  }}
                  placeholder="e.g. incidents"
                  aria-label="Channel name"
                  className="border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                />
              </div>
              {duplicate && (
                <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
                  A channel called "{duplicate}" already exists. That is allowed — names are
                  not unique — but the two will be hard to tell apart.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Start from
              </div>
              <div className="flex flex-wrap gap-1.5">
                {nativeTemplates.map(tpl => {
                  const Icon = tpl.icon;
                  const active = template.id === tpl.id;
                  return (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() => pickTemplate(tpl)}
                      aria-pressed={active}
                      title={tpl.description}
                      className={cn(
                        'control-outer-ring flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition',
                        active
                          ? 'border-primary/60 bg-primary/15 text-foreground'
                          : 'border-border bg-card/40 text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                      )}
                    >
                      <Icon className="size-3.5" />
                      {tpl.name}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">{template.description}</p>
            </div>

            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Bring your own
              </div>
              <div className="flex flex-wrap gap-1.5">
                {bridgeTemplates.map(tpl => {
                  const Icon = tpl.icon;
                  return (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() => pickTemplate(tpl)}
                      title={tpl.description}
                      className="control-outer-ring flex items-center gap-1.5 rounded-lg border border-dashed border-border bg-card/20 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
                    >
                      <Icon className="size-3.5" />
                      {tpl.name}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t pt-3">
              <Button type="button" variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" size="sm" disabled={!canAdvance} onClick={() => setStep('members')}>
                Next
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Who is in #{name.trim()}?</DialogTitle>
              <DialogDescription>
                Suggested from the name. Adding an agent means it can answer here, so nothing is
                added until you pick it.
              </DialogDescription>
            </DialogHeader>
            <ChannelMemberStep
              channelName={name}
              workspaceId={workspaceId}
              agents={agents}
              agentConnections={agentConnections}
              sessions={sessions}
              conversationMode={template.conversationMode}
              selected={selected}
              onSelectedChange={setSelected}
              onBack={() => setStep('name')}
              onCreate={() => void create()}
              creating={creating}
            />
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
  onCreate: Props['onCreate'];
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
