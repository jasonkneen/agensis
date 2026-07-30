import { useMemo, useState } from 'react';
import { AlertTriangle, Plus, RefreshCw, ScrollText, Trash2, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useAutomations, type Automation, type AutomationDefinition } from '../../hooks/useAutomations';
import {
  AUTOMATION_EMPTY_NOTE,
  AUTOMATION_PERMISSION_NOTE,
  AUTOMATION_SAFETY_NOTE,
  AUTOMATION_TASK_NOTE,
  AUTOMATION_UNAVAILABLE_NOTE,
  automationState,
  eventLabel,
  formatRunTime,
  runCountLabel,
  runFailed,
  runStatusLabel,
  ruleSummary,
  stateLabel,
  stoppedExplanation,
} from '../../lib/automationView';
import type { ChatSession } from '../../types';

// The Automations window: "when X happens in this workspace, do Y", with no
// agent and no model call.
//
// Rows are ROOMY, not dense. This surface is read occasionally and scanned for
// the one rule that is misbehaving, not scrolled through in bulk — and the thing
// most worth noticing (a rule that switched itself off) needs room to say why.
//
// No emoji anywhere, per repo convention.

interface AutomationsWindowProps {
  workspaceId: string;
  sessions: ChatSession[];
}

/** Only the events a person can reason about, in the order they will want them. */
const TRIGGER_CHOICES = [
  'message.created',
  'message.updated',
  'document.created',
  'document.updated',
  'channel.created',
  'member.created',
];

const CONDITION_OPS = [
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'equals', label: 'is exactly' },
  { value: 'not_equals', label: 'is not' },
  { value: 'starts_with', label: 'starts with' },
];

type StepAction = 'post_message' | 'create_task';

/**
 * The two actions, named by what a person gets rather than by the wire value.
 *
 * There is no third entry and no "dispatch an agent". Neither this list nor the
 * server's is the other's authority — AUTOMATION_ACTIONS in
 * shared/automation-rules.cjs rejects anything it does not know, so an option
 * added only here fails on save rather than doing something unreviewed.
 */
const ACTION_CHOICES: Array<{ value: StepAction; label: string }> = [
  { value: 'post_message', label: 'Post a message' },
  { value: 'create_task', label: 'Create a task' },
];

/** Mirrors MAX_TASK_TITLE_LENGTH in shared/automation-rules.cjs. */
const MAX_TASK_TITLE_LENGTH = 200;

export function AutomationsWindowContent({ workspaceId, sessions }: AutomationsWindowProps) {
  const {
    automations, runs, loading, unavailable, error,
    refresh, createAutomation, setEnabled, deleteAutomation,
  } = useAutomations(workspaceId || null);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [triggerEvent, setTriggerEvent] = useState('message.created');
  const [watchChannelId, setWatchChannelId] = useState('');
  const [conditionOp, setConditionOp] = useState('contains');
  const [conditionValue, setConditionValue] = useState('');
  const [stepAction, setStepAction] = useState<StepAction>('post_message');
  const [postChannelId, setPostChannelId] = useState('');
  const [postText, setPostText] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const channels = useMemo(
    () => sessions.filter(session => !session.archived_at).slice(0, 200),
    [sessions],
  );

  const runsByAutomation = useMemo(() => {
    const map = new Map<string, typeof runs>();
    for (const run of runs) {
      const list = map.get(run.automation_id) ?? [];
      list.push(run);
      map.set(run.automation_id, list);
    }
    return map;
  }, [runs]);

  const resetForm = () => {
    setName('');
    setTriggerEvent('message.created');
    setWatchChannelId('');
    setConditionOp('contains');
    setConditionValue('');
    setStepAction('post_message');
    setPostChannelId('');
    setPostText('');
    setTaskTitle('');
    setTaskDescription('');
    setFormError(null);
  };

  const handleCreate = async () => {
    setFormError(null);
    if (!name.trim()) { setFormError('Give the rule a name.'); return; }
    if (stepAction === 'post_message') {
      if (!postChannelId) { setFormError('Choose the channel to post into.'); return; }
      if (!postText.trim()) { setFormError('Write the message to post.'); return; }
    } else if (!taskTitle.trim()) {
      setFormError('Give the task a title.'); return;
    }

    const when: AutomationDefinition['when'] = [];
    if (watchChannelId) when.push({ field: 'channelId', op: 'equals', value: watchChannelId });
    if (conditionValue.trim()) when.push({ field: 'data.content', op: conditionOp, value: conditionValue.trim() });

    // Only the fields the chosen action uses. The server rebuilds the step from
    // its own allowlist anyway, so sending the other action's fields would just
    // be dropped — but building the exact step keeps what is stored equal to
    // what the form showed.
    const step: AutomationDefinition['steps'][number] = stepAction === 'post_message'
      ? { action: 'post_message', channelId: postChannelId, text: postText.trim() }
      : { action: 'create_task', title: taskTitle.trim(), description: taskDescription.trim() };

    const definition: AutomationDefinition = {
      version: 1,
      trigger: { event: triggerEvent },
      when,
      steps: [step],
    };

    setSaving(true);
    // Created switched OFF, always. The server defaults it that way and the form
    // does not offer otherwise: a rule that starts live means the first thing a
    // mistyped condition does is fire on everything.
    const failure = await createAutomation({ name: name.trim(), definition, enabled: false });
    setSaving(false);
    if (failure) { setFormError(failure); return; }
    resetForm();
    setCreating(false);
  };

  const handleToggle = async (automation: Automation) => {
    setBusyId(automation.id);
    const failure = await setEnabled(automation.id, !automation.enabled);
    setBusyId(null);
    if (failure) setFormError(failure);
  };

  const handleDelete = async (automation: Automation) => {
    setBusyId(automation.id);
    const failure = await deleteAutomation(automation.id);
    setBusyId(null);
    if (failure) setFormError(failure);
  };

  if (unavailable) {
    return (
      <div className="flex h-full flex-col overflow-y-auto p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Zap /></EmptyMedia>
            <EmptyTitle>Automations are off</EmptyTitle>
            <EmptyDescription>{AUTOMATION_UNAVAILABLE_NOTE}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-border p-4">
        <div className="min-w-0 max-w-2xl">
          <div className="text-sm font-semibold">Automations</div>
          {/* The safety story, in the window rather than in docs. Both wrong
              assumptions ("it will cost me" / "an agent will reply") are
              cheaper to prevent here than to correct later. */}
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{AUTOMATION_SAFETY_NOTE}</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{AUTOMATION_PERMISSION_NOTE}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => { void refresh(); }} disabled={loading}>
            <RefreshCw data-icon="inline-start" />
            Refresh
          </Button>
          <Button type="button" size="sm" onClick={() => { resetForm(); setCreating(value => !value); }}>
            <Plus data-icon="inline-start" />
            New rule
          </Button>
        </div>
      </div>

      {error && (
        <div className="border-b border-border bg-destructive/10 px-4 py-3 text-xs text-destructive">{error}</div>
      )}
      {formError && !creating && (
        <div className="border-b border-border bg-destructive/10 px-4 py-3 text-xs text-destructive">{formError}</div>
      )}

      {creating && (
        <div className="flex shrink-0 flex-col gap-3 border-b border-border bg-card/40 p-4">
          <div className="text-xs font-medium text-muted-foreground">New rule</div>
          <Input placeholder="What this rule is for" value={name} onChange={event => setName(event.target.value)} />

          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">When</span>
            <NativeSelect value={triggerEvent} onChange={event => setTriggerEvent(event.target.value)}>
              {TRIGGER_CHOICES.map(choice => (
                <NativeSelectOption key={choice} value={choice}>{eventLabel(choice)}</NativeSelectOption>
              ))}
            </NativeSelect>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">In channel (optional — any channel if left blank)</span>
            <NativeSelect value={watchChannelId} onChange={event => setWatchChannelId(event.target.value)}>
              <NativeSelectOption value="">Any channel</NativeSelectOption>
              {channels.map(channel => (
                <NativeSelectOption key={channel.id} value={channel.id}>{channel.title || 'Untitled'}</NativeSelectOption>
              ))}
            </NativeSelect>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">And the text (optional)</span>
            <div className="flex gap-2">
              <NativeSelect className="w-44 shrink-0" value={conditionOp} onChange={event => setConditionOp(event.target.value)}>
                {CONDITION_OPS.map(op => (
                  <NativeSelectOption key={op.value} value={op.value}>{op.label}</NativeSelectOption>
                ))}
              </NativeSelect>
              <Input placeholder="deploy failed" value={conditionValue} onChange={event => setConditionValue(event.target.value)} />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Then</span>
            <NativeSelect
              aria-label="What the rule does"
              value={stepAction}
              onChange={event => setStepAction(event.target.value as StepAction)}
            >
              {ACTION_CHOICES.map(choice => (
                <NativeSelectOption key={choice.value} value={choice.value}>{choice.label}</NativeSelectOption>
              ))}
            </NativeSelect>
          </div>

          {stepAction === 'post_message' ? (
            <>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">Post into</span>
                <NativeSelect value={postChannelId} onChange={event => setPostChannelId(event.target.value)}>
                  <NativeSelectOption value="">Choose a channel</NativeSelectOption>
                  {channels.map(channel => (
                    <NativeSelectOption key={channel.id} value={channel.id}>{channel.title || 'Untitled'}</NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>

              <Textarea
                rows={3}
                placeholder="Heads up — someone reported a failed deploy."
                value={postText}
                onChange={event => setPostText(event.target.value)}
              />
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">Called</span>
                <Input
                  placeholder="Look into the failed deploy"
                  value={taskTitle}
                  maxLength={MAX_TASK_TITLE_LENGTH}
                  onChange={event => setTaskTitle(event.target.value)}
                />
              </div>
              <Textarea
                rows={3}
                placeholder="What needs doing, and anything useful from the message. Optional."
                value={taskDescription}
                onChange={event => setTaskDescription(event.target.value)}
              />
              {/* Stated where the choice is made, not only in the panel note.
                  "It creates a task" invites the assumption that it also gives
                  it to someone, which is the one thing it deliberately does
                  not do — an assignee is what starts an agent, and an
                  automation must not be able to. */}
              <p className="text-xs text-muted-foreground">{AUTOMATION_TASK_NOTE}</p>
            </>
          )}

          {formError && <div className="text-xs text-destructive">{formError}</div>}

          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={() => { void handleCreate(); }} disabled={saving}>
              {saving ? <><Spinner data-icon="inline-start" /> Saving</> : 'Create, switched off'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setCreating(false); resetForm(); }}>
              Cancel
            </Button>
            <span className="text-xs text-muted-foreground">
              New rules start off so you can read them back before they run.
            </span>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && automations.length === 0 && (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Spinner /> Loading automations
          </div>
        )}

        {!loading && automations.length === 0 && (
          <div className="p-6">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><Zap /></EmptyMedia>
                <EmptyTitle>No automations yet</EmptyTitle>
                <EmptyDescription>{AUTOMATION_EMPTY_NOTE}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        )}

        {automations.map(automation => {
          const state = automationState(automation);
          const automationRuns = runsByAutomation.get(automation.id) ?? [];
          const recentFailure = automationRuns.find(runFailed);
          return (
            /* Roomy: generous padding, no separators between fields, one rule
               per block. This is scanned for the one rule misbehaving. */
            <div key={automation.id} className="border-b border-border px-4 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{automation.name || 'Untitled rule'}</span>
                    <Badge variant={state === 'stopped' ? 'destructive' : state === 'active' ? 'secondary' : 'outline'}>
                      {state === 'stopped' && <AlertTriangle data-icon="inline-start" />}
                      {stateLabel(state)}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    {ruleSummary(automation.definition)}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{runCountLabel(automation)}</span>
                    <span>Last run {formatRunTime(automation.last_run_at)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant={automation.enabled ? 'secondary' : 'default'}
                    size="sm"
                    onClick={() => { void handleToggle(automation); }}
                    disabled={busyId === automation.id}
                  >
                    {automation.enabled ? 'Turn off' : 'Turn on'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => { void handleDelete(automation); }}
                    disabled={busyId === automation.id}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>

              {/* THE most important state in this window. A rule that switched
                  itself off must never look like one someone paused. */}
              {state === 'stopped' && (
                <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs leading-relaxed text-destructive">
                  <span className="font-medium">This rule switched itself off. </span>
                  {stoppedExplanation(automation)}
                </div>
              )}

              {recentFailure && state !== 'stopped' && (
                <div className="mt-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                  Last failure: {recentFailure.error || runStatusLabel(recentFailure.status)}
                </div>
              )}

              {/* Recent runs. The status and its time sit TOGETHER, not at
                  opposite ends of the row — pushed apart they read as two
                  unrelated facts, which is what a full-width justify-between
                  does to a two-word line inside a wide window. */}
              {automationRuns.length > 0 && (
                <div className="mt-3 flex flex-col gap-1">
                  <span className="text-[11px] font-medium text-muted-foreground">Recent runs</span>
                  {automationRuns.slice(0, 3).map(run => (
                    <div key={run.id} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className={cn('min-w-16', runFailed(run) && 'text-destructive')}>{runStatusLabel(run.status)}</span>
                      <span className="opacity-70">{formatRunTime(run.created_at)}</span>
                      {run.error && <span className="truncate opacity-70">— {run.error}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Every create, edit, delete and on/off here is written to the audit log.
          Saying where it went is the difference between a record that exists and
          one anybody knows to look for. */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
        <ScrollText className="size-3.5 shrink-0" />
        <span>
          Creating, changing, deleting or switching a rule on or off is recorded in the
          audit log, under Settings, with who did it and when.
        </span>
      </div>
    </div>
  );
}
