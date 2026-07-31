import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  Copy,
  KeyRound,
  Rocket,
  Sparkles,
  Terminal,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { apiAuthHeaders, apiBaseUrl, apiUrl } from '@/lib/backendClient';
import {
  AGENT_TEMPLATES,
  agentMetadataWithRuntime,
  dedupeHandle,
  type AgentExecutionRuntime,
  type AgentTemplate,
} from '@/lib/agentTemplates';
import type { WorkspaceReadiness } from '@/lib/workspaceReadiness';
import type { CreateAgentInput, CreateAgentResult } from '@/hooks/useAgents';
import type { AgentConnection, WorkspaceAgent } from '../../types';

interface OnboardingTourProps {
  onComplete: () => void;
  /** Open the Users window (invite a teammate). */
  onInvite?: () => void;
  /** Active workspace — agent creation + key checks are scoped to it. */
  workspaceId: string | null;
  /**
   * Whether an agent can be created yet. A brand-new account reaches this tour
   * before its starter workspaces exist, and every button here writes into a
   * workspace — so they stay disabled, and say why, until there is one.
   */
  workspaceReadiness: WorkspaceReadiness;
  /** Re-run workspace setup after the user watched it fail. */
  onRetryWorkspaceSetup?: () => void | Promise<void>;
  /** Existing agents, used to avoid handle collisions on one-click creation. */
  agents: WorkspaceAgent[];
  /** Live daemon connections, used to show the connect step's success state. */
  connections: AgentConnection[];
  createAgent: (input: CreateAgentInput) => Promise<CreateAgentResult>;
}

type StepId = 'welcome' | 'builtin' | 'connect' | 'invite' | 'done';

interface StepMeta {
  id: StepId;
  icon: LucideIcon;
  /** tinted accent circle behind the icon — fixed hues so it reads in light + dark */
  accent: string;
  eyebrow: string;
  title: string;
  body: string;
}

const STEPS: StepMeta[] = [
  {
    id: 'welcome',
    icon: Sparkles,
    accent: 'from-primary/25 to-primary/5 text-primary ring-primary/20',
    eyebrow: 'Welcome to Agensis',
    title: 'One workspace for your agents and your team.',
    body: 'Agensis is the shared hub where the AI agents you rely on and the people you work with collaborate side by side — same channels, same context, same memory.',
  },
  {
    id: 'builtin',
    icon: Bot,
    accent: 'from-sky-500/25 to-sky-500/5 text-sky-500 ring-sky-500/20',
    eyebrow: 'Step 1',
    title: 'Add a built-in agent.',
    body: 'One click adds a ready-made agent to your workspace — no setup, no prompts to write. Add as many as you like.',
  },
  {
    id: 'connect',
    icon: Terminal,
    accent: 'from-violet-500/25 to-violet-500/5 text-violet-500 ring-violet-500/20',
    eyebrow: 'Step 2',
    title: 'Connect your own agent.',
    body: 'Run an agent on this machine with the Claude Code or Codex CLI — it uses the account you are already logged in with. Optional, but this is where the real power is.',
  },
  {
    id: 'invite',
    icon: Users,
    accent: 'from-emerald-500/25 to-emerald-500/5 text-emerald-500 ring-emerald-500/20',
    eyebrow: 'Step 3',
    title: 'Invite a person or agent.',
    body: 'Create one short-lived link. A person gets the sign-in flow; an agent gets machine-readable connection instructions from that same URL.',
  },
  {
    id: 'done',
    icon: Rocket,
    accent: 'from-amber-500/25 to-amber-500/5 text-amber-500 ring-amber-500/20',
    eyebrow: "You're set",
    title: 'Start collaborating.',
    body: "That's the loop — agents and people in one place. The checklist in the corner tracks your first steps whenever you're ready.",
  },
];

// Curated one-click presets for the built-in step (builtin runMode only, fixed
// names/avatars — system prompts stay hidden per the "keep it simple" rule).
const ONBOARDING_PRESET_IDS = ['researcher', 'writer', 'pm', 'summarizer'];
const ONBOARDING_PRESETS = AGENT_TEMPLATES.filter(t => ONBOARDING_PRESET_IDS.includes(t.id));

const CODER_TEMPLATE = AGENT_TEMPLATES.find(t => t.id === 'coder');

const CONNECT_CLIS = [
  { id: 'claude', name: 'Claude Code CLI', note: 'Uses your logged-in Claude account' },
  { id: 'codex', name: 'Codex CLI', note: 'Uses your logged-in OpenAI account' },
] as const;

type KeyStatus = 'unknown' | 'configured' | 'missing';

/**
 * Why the buttons above are greyed out. Renders nothing once a workspace
 * exists, so the common path is unchanged; while there is none it replaces the
 * old behaviour of a live-looking button that failed on click.
 */
function WorkspaceNotReadyNotice({
  readiness,
  onRetry,
}: {
  readiness: WorkspaceReadiness;
  onRetry?: () => void | Promise<void>;
}) {
  if (readiness.ready || !readiness.reason) return null;
  const failed = readiness.status === 'unavailable';
  return (
    <div
      role="status"
      className={cn('mt-2 flex items-center justify-center gap-2 text-xs', failed ? 'text-destructive' : 'text-muted-foreground')}
    >
      {!failed && <Spinner className="size-3 shrink-0" />}
      <span className="text-pretty">{readiness.reason}</span>
      {failed && readiness.canRetry && onRetry && (
        <Button type="button" variant="outline" size="sm" className="h-6 shrink-0 px-2 text-xs" onClick={() => void onRetry()}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function OnboardingTour({
  onComplete,
  onInvite,
  workspaceId,
  workspaceReadiness,
  onRetryWorkspaceSetup,
  agents,
  connections,
  createAgent,
}: OnboardingTourProps) {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);
  const dismissedRef = useRef(false);
  const workspaceReady = workspaceReadiness.ready;

  // Built-in step
  const [addedPresetIds, setAddedPresetIds] = useState<Set<string>>(new Set());
  const [addingPresetId, setAddingPresetId] = useState<string | null>(null);
  const [addError, setAddError] = useState('');

  // Workspace key fallback (only surfaced when no Anthropic key is configured)
  const [keyStatus, setKeyStatus] = useState<KeyStatus>('unknown');
  const [keyDraft, setKeyDraft] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMessage, setKeyMessage] = useState('');

  // Connect step
  const [connectBusy, setConnectBusy] = useState<string | null>(null);
  const [connectAgent, setConnectAgent] = useState<WorkspaceAgent | null>(null);
  const [connectCommand, setConnectCommand] = useState('');
  const [connectError, setConnectError] = useState('');
  const [commandCopied, setCommandCopied] = useState(false);

  // Mount closed, then open on the next tick so Radix plays the zoom/fade-in.
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 120);
    return () => clearTimeout(timer);
  }, []);

  // Check once whether built-in agents have a key to run with; the fallback
  // input only appears when neither a workspace nor app-level key exists.
  useEffect(() => {
    if (step !== 1 || !workspaceId || keyStatus !== 'unknown') return;
    let cancelled = false;
    fetch(apiUrl(`/backend/settings/secrets?workspaceId=${encodeURIComponent(workspaceId)}`), { headers: apiAuthHeaders() })
      .then(async res => {
        const payload = await res.json().catch(() => null);
        if (cancelled) return;
        const keys: Array<{ key: string; scope?: string }> = payload?.data?.keys || [];
        const anthropic = keys.find(k => k.key === 'ANTHROPIC_API_KEY');
        setKeyStatus(anthropic && (anthropic.scope === 'workspace' || anthropic.scope === 'app') ? 'configured' : 'missing');
      })
      .catch(() => {
        if (!cancelled) setKeyStatus('missing');
      });
    return () => {
      cancelled = true;
    };
  }, [step, workspaceId, keyStatus]);

  const total = STEPS.length;
  const current = STEPS[Math.min(step, total - 1)];
  const isLast = step >= total - 1;

  const handleDismiss = () => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    setVisible(false);
    setTimeout(onComplete, 200);
  };

  const handleNext = () => {
    if (isLast) handleDismiss();
    else setStep(s => Math.min(s + 1, total - 1));
  };

  const handleAddPreset = async (tpl: AgentTemplate) => {
    if (addingPresetId || addedPresetIds.has(tpl.id)) return;
    // Belt and braces: the button is already disabled while the workspace is
    // missing, so this only fires if something re-enabled it. Report the
    // workspace's own reason rather than attempting a write with nowhere to go.
    if (!workspaceReady) {
      setAddError(workspaceReadiness.reason || 'Your workspace is not ready yet.');
      return;
    }
    setAddingPresetId(tpl.id);
    setAddError('');
    try {
      const handle = dedupeHandle(tpl.handle, agents.map(a => a.handle || ''));
      const { agent: created, failure } = await createAgent({
        name: handle === tpl.handle ? tpl.name : `${tpl.name} ${handle.slice(tpl.handle.length + 1)}`,
        handle,
        avatar: tpl.avatar,
        description: tpl.description,
        system_prompt: tpl.systemPrompt,
        tools: [],
        skills: [],
        model: 'auto',
        run_mode: 'builtin',
      });
      // Say what actually went wrong rather than the same generic line for a
      // rejected insert, an expired session and a workspace that never loaded.
      if (!created) {
        setAddError(`Could not add ${tpl.name}. ${failure?.reason ?? 'You can create it later from the Agents window.'}`);
        return;
      }
      setAddedPresetIds(prev => new Set(prev).add(tpl.id));
    } catch {
      setAddError(`Could not add ${tpl.name}. You can create it later from the Agents window.`);
    } finally {
      setAddingPresetId(null);
    }
  };

  const handleSaveKey = async () => {
    if (!workspaceId || !keyDraft.trim() || keyBusy) return;
    setKeyBusy(true);
    setKeyMessage('');
    try {
      const res = await fetch(apiUrl('/backend/settings/secrets'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({ workspaceId, ANTHROPIC_API_KEY: keyDraft.trim() }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || payload?.error) throw new Error(payload?.error?.message || 'Failed to save');
      setKeyStatus('configured');
      setKeyDraft('');
    } catch (e) {
      setKeyMessage(e instanceof Error ? e.message : 'Failed to save the key.');
    } finally {
      setKeyBusy(false);
    }
  };

  const handleConnect = async (cliId: string) => {
    if (connectBusy) return;
    // The connect step creates an agent too, so it dead-ends the same way.
    if (!workspaceReady) {
      setConnectError(workspaceReadiness.reason || 'Your workspace is not ready yet.');
      return;
    }
    setConnectBusy(cliId);
    setConnectError('');
    try {
      const baseHandle = cliId === 'codex' ? 'codex-cli' : 'coder-cli';
      const handle = dedupeHandle(baseHandle, agents.map(a => a.handle || ''));
      const runtime: AgentExecutionRuntime = cliId === 'codex' ? 'codex' : 'claude';
      const { agent, failure } = await createAgent({
        name: cliId === 'codex' ? 'Codex' : (CODER_TEMPLATE?.name || 'Coder'),
        handle,
        avatar: CODER_TEMPLATE?.avatar,
        description: CODER_TEMPLATE?.description || '',
        system_prompt: CODER_TEMPLATE?.systemPrompt || '',
        tools: [],
        skills: [],
        model: 'auto',
        // The connection-command route reads the execution runtime from agent
        // metadata before it builds CLI flags. Storing this as a built-in agent
        // made the Codex button silently fall back to Claude and emit a Claude
        // model in the command.
        run_mode: 'daemon',
        metadata: agentMetadataWithRuntime({}, runtime, 'daemon'),
      });
      if (!agent) throw new Error(failure?.reason ?? 'The agent could not be created.');
      // The server flips run_mode to 'daemon' and rotates the connect token here.
      const response = await fetch(apiUrl(`/backend/agents/${agent.id}/connection-command`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify({ handle: agent.handle || handle, baseUrl: apiBaseUrl() }),
      });
      const payload = await response.json().catch(() => null);
      const command = payload?.data?.portableCommand || payload?.data?.command || payload?.data?.localCommand || '';
      if (!response.ok || !command) {
        throw new Error(payload?.error?.message || 'Daemon websocket backend is not available.');
      }
      setConnectAgent(agent);
      setConnectCommand(command);
      setCommandCopied(false);
      void navigator.clipboard?.writeText(command).then(() => setCommandCopied(true)).catch(() => {});
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : 'Could not create a daemon connection command.');
    } finally {
      setConnectBusy(null);
    }
  };

  const copyCommand = () => {
    void navigator.clipboard?.writeText(connectCommand).then(() => setCommandCopied(true)).catch(() => {});
  };

  const connected = connectAgent
    ? connections.some(c => c.agent_id === connectAgent.id && c.status === 'online')
    : false;

  // Fire the invite handoff, then finish the tour so the window is unobstructed.
  const runInvite = () => {
    onInvite?.();
    handleDismiss();
  };

  if (!current) return null;

  const Icon = current.icon;

  return (
    <Dialog
      open={visible}
      onOpenChange={nextOpen => {
        if (!nextOpen) handleDismiss();
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
        showCloseButton={false}
      >
        <Progress value={((step + 1) / total) * 100} className="rounded-none" />

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={handleDismiss}
          title="Skip"
          className="absolute right-2 top-3 z-10 text-muted-foreground"
        >
          <X className="size-4" />
          <span className="sr-only">Skip onboarding</span>
        </Button>

        <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-8 pb-6 pt-10 text-center">
          <div
            className={cn(
              'mb-5 grid size-16 shrink-0 place-items-center rounded-2xl bg-gradient-to-br ring-1',
              current.accent,
            )}
          >
            <Icon className="size-7" />
          </div>

          <span className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {current.eyebrow}
          </span>
          <DialogTitle className="text-balance text-xl font-semibold leading-snug text-foreground">
            {current.title}
          </DialogTitle>
          <DialogDescription className="mt-3 max-w-md text-pretty text-sm leading-relaxed text-muted-foreground">
            {current.body}
          </DialogDescription>

          {current.id === 'builtin' && (
            <div className="mt-5 w-full max-w-md">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {ONBOARDING_PRESETS.map(tpl => {
                  const added = addedPresetIds.has(tpl.id);
                  return (
                    <div key={tpl.id} className="flex items-center gap-2.5 rounded-lg border border-border bg-card/50 p-2.5 text-left">
                      {tpl.avatar ? (
                        <img src={tpl.avatar} alt="" className="size-9 shrink-0 rounded-full object-cover" />
                      ) : (
                        <div className="grid size-9 shrink-0 place-items-center rounded-full bg-muted">
                          <Bot className="size-4 text-muted-foreground" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-foreground">{tpl.name}</div>
                        <div className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">{tpl.description}</div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant={added ? 'outline' : 'default'}
                        disabled={added || addingPresetId !== null || !workspaceReady}
                        title={workspaceReady ? undefined : workspaceReadiness.reason || undefined}
                        onClick={() => void handleAddPreset(tpl)}
                        className="shrink-0"
                      >
                        {added ? <Check data-icon="inline-start" className="size-3.5" /> : null}
                        {added ? 'Added' : addingPresetId === tpl.id ? 'Adding…' : 'Add'}
                      </Button>
                    </div>
                  );
                })}
              </div>
              <WorkspaceNotReadyNotice readiness={workspaceReadiness} onRetry={onRetryWorkspaceSetup} />
              {addError && <div className="mt-2 text-xs text-destructive">{addError}</div>}

              {keyStatus === 'missing' && (
                <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3 text-left">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    <KeyRound className="size-3.5 text-muted-foreground" />
                    Built-in agents need an Anthropic API key
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                    No key is configured for this workspace yet. Paste one now, or skip and add it later in Settings → Secret keys.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Input
                      type="password"
                      value={keyDraft}
                      onChange={e => setKeyDraft(e.target.value)}
                      placeholder="sk-ant-…"
                      className="h-8 text-xs"
                      autoComplete="off"
                    />
                    <Button type="button" size="sm" variant="outline" disabled={!keyDraft.trim() || keyBusy} onClick={() => void handleSaveKey()}>
                      {keyBusy ? 'Saving…' : 'Save'}
                    </Button>
                  </div>
                  {keyMessage && <div className="mt-1.5 text-[11px] text-destructive">{keyMessage}</div>}
                </div>
              )}
            </div>
          )}

          {current.id === 'connect' && (
            <div className="mt-5 w-full max-w-md">
              {!connectCommand ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {CONNECT_CLIS.map(cli => (
                    <div key={cli.id} className="flex flex-col gap-2 rounded-lg border border-border bg-card/50 p-3 text-left">
                      <div className="flex items-center gap-1.5">
                        <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm font-semibold text-foreground">{cli.name}</span>
                      </div>
                      <span className="text-[11px] text-muted-foreground">{cli.note}</span>
                      <Button
                        type="button"
                        size="sm"
                        className="mt-1"
                        disabled={connectBusy !== null || !workspaceReady}
                        title={workspaceReady ? undefined : workspaceReadiness.reason || undefined}
                        onClick={() => void handleConnect(cli.id)}
                      >
                        {connectBusy === cli.id ? 'Creating…' : 'Connect'}
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-border bg-card/50 p-3 text-left">
                  <div className="text-sm font-semibold text-foreground">
                    @{connectAgent?.handle} is ready to connect
                  </div>
                  <ol className="mt-2 list-decimal space-y-1 pl-4 text-[11px] leading-snug text-muted-foreground">
                    <li>Install the daemon: <code className="rounded bg-muted px-1 py-0.5">npm i -g @agensis/agensis-agent</code></li>
                    <li>Run this command where your CLI is logged in:</li>
                  </ol>
                  <div className="relative mt-2">
                    <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 pr-9 text-[11px] leading-snug text-foreground">{connectCommand}</pre>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={copyCommand}
                      title="Copy command"
                      className="absolute right-1 top-1 text-muted-foreground"
                    >
                      {commandCopied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
                    </Button>
                  </div>
                  <div className={cn('mt-2 text-[11px] font-medium', connected ? 'text-emerald-500' : 'text-muted-foreground')}>
                    {connected
                      ? `Connected — @${connectAgent?.handle} is online.`
                      : 'Waiting for the daemon to come online… you can also finish setup and connect later.'}
                  </div>
                </div>
              )}
              {!connectCommand && <WorkspaceNotReadyNotice readiness={workspaceReadiness} onRetry={onRetryWorkspaceSetup} />}
              {connectError && <div className="mt-2 text-xs text-destructive">{connectError}</div>}
            </div>
          )}

          {current.id === 'invite' && (
            <Button type="button" onClick={runInvite} className="mt-6">
              Invite people
              <ArrowRight data-icon="inline-end" className="size-4" />
            </Button>
          )}

          <div className="mt-7 flex gap-1.5">
            {STEPS.map((s, i) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setStep(i)}
                aria-label={`Go to step ${i + 1}`}
                className={cn(
                  'h-1.5 rounded-full transition-all',
                  i === step ? 'w-5 bg-primary' : 'w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/50',
                )}
              />
            ))}
          </div>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t bg-muted/40 px-5 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={handleDismiss} className="text-muted-foreground">
            Skip
          </Button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <Button type="button" variant="outline" size="sm" onClick={() => setStep(s => s - 1)}>
                <ArrowLeft data-icon="inline-start" className="size-4" />
                Back
              </Button>
            )}
            <Button type="button" size="sm" onClick={handleNext}>
              {isLast ? 'Get started' : 'Next'}
              {!isLast && <ArrowRight data-icon="inline-end" className="size-4" />}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
