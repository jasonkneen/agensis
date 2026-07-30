import { useMemo, useState } from 'react';
import { Clock, Plus, Play, Trash2, Pause, ArrowLeft, CircleCheck, CircleX } from 'lucide-react';
import { useSchedules, type AgentSchedule } from '../../hooks/useSchedules';
import type { ChatSession, WorkspaceAgent } from '../../types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface SchedulesWindowProps {
  workspaceId: string;
  agents: WorkspaceAgent[];
  sessions: ChatSession[];
}

const INTERVAL_CHOICES: Array<{ label: string; seconds: number }> = [
  { label: 'Every hour', seconds: 3600 },
  { label: 'Every 6 hours', seconds: 21600 },
  { label: 'Every 12 hours', seconds: 43200 },
  { label: 'Daily', seconds: 86400 },
  { label: 'Weekly', seconds: 604800 },
];

function intervalLabel(seconds: number): string {
  const match = INTERVAL_CHOICES.find(c => c.seconds === seconds);
  if (match) return match.label;
  if (seconds % 86400 === 0) return `Every ${seconds / 86400} days`;
  if (seconds % 3600 === 0) return `Every ${seconds / 3600} hours`;
  return `Every ${Math.round(seconds / 60)} min`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const rel = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return diff >= 0 ? `in ${rel}` : `${rel} ago`;
}

export function SchedulesWindow({ workspaceId, agents, sessions }: SchedulesWindowProps) {
  const { schedules, createSchedule, updateSchedule, runSchedule, deleteSchedule } = useSchedules(workspaceId || null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [intervalSeconds, setIntervalSeconds] = useState(86400);
  const [busyId, setBusyId] = useState<string | null>(null);

  const enabledAgents = useMemo(() => agents.filter(a => a.enabled !== false), [agents]);
  const stats = useMemo(() => {
    const total = schedules.length;
    const successful = schedules.reduce((n, s) => n + Math.max(0, s.run_count - s.fail_count), 0);
    const failed = schedules.reduce((n, s) => n + s.fail_count, 0);
    return { total, successful, failed };
  }, [schedules]);

  const agentName = (id: string | null) => agents.find(a => a.id === id)?.name || 'Unknown agent';
  const sessionTitle = (id: string | null) => sessions.find(s => s.id === id)?.title || 'a channel';

  const resetForm = () => {
    setName(''); setAgentId(''); setSessionId(''); setPrompt(''); setIntervalSeconds(86400);
  };

  const submit = async () => {
    if (!agentId || !sessionId) return;
    try {
      const created = await createSchedule({ agentId, sessionId, name: name.trim(), prompt: prompt.trim(), intervalSeconds });
      if (!created) throw new Error('The server did not return the new schedule.');
      toast.success('Schedule created');
      resetForm();
      setCreating(false);
    } catch (err) {
      toast.error('Could not create schedule', { description: err instanceof Error ? err.message : String(err) });
    }
  };

  const toggleEnabled = async (schedule: AgentSchedule) => {
    setBusyId(schedule.id);
    try {
      await updateSchedule(schedule.id, { enabled: !schedule.enabled });
    } catch (err) {
      toast.error('Could not update schedule', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusyId(null);
    }
  };
  const runNow = async (schedule: AgentSchedule) => {
    setBusyId(schedule.id);
    try {
      await runSchedule(schedule.id);
      toast.success('Schedule run started');
    } catch (err) {
      toast.error('Could not run schedule', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent text-foreground">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card/65 px-4 py-3 backdrop-blur-md">
        <div>
          <h2 className="text-base font-semibold">Schedules</h2>
          <p className="text-xs text-muted-foreground">Automate repetitive tasks — an agent runs your prompt on a cadence.</p>
        </div>
        {!creating && (
          <Button type="button" size="sm" onClick={() => setCreating(true)} disabled={enabledAgents.length === 0 || sessions.length === 0}>
            <Plus data-icon="inline-start" />
            New Schedule
          </Button>
        )}
      </div>

      <div className="grid shrink-0 grid-cols-3 gap-2 border-b border-border px-4 py-3">
        <div className="rounded-lg border bg-card/40 px-3 py-2">
          <div className="text-xs text-muted-foreground">Total schedules</div>
          <div className="text-lg font-semibold tabular-nums">{stats.total}</div>
        </div>
        <div className="rounded-lg border bg-card/40 px-3 py-2">
          <div className="text-xs text-muted-foreground">Successful runs</div>
          <div className="text-lg font-semibold tabular-nums text-emerald-500">{stats.successful}</div>
        </div>
        <div className="rounded-lg border bg-card/40 px-3 py-2">
          <div className="text-xs text-muted-foreground">Failed runs</div>
          <div className={cn('text-lg font-semibold tabular-nums', stats.failed > 0 ? 'text-destructive' : '')}>{stats.failed}</div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {creating ? (
          <div className="mx-auto max-w-lg rounded-lg border bg-card/50 p-4">
            <div className="mb-3 flex items-center gap-2">
              <Button type="button" variant="ghost" size="icon-xs" onClick={() => { setCreating(false); resetForm(); }} aria-label="Back">
                <ArrowLeft />
              </Button>
              <span className="text-sm font-semibold">New schedule</span>
            </div>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                Name
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="Daily standup summary" />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                Agent
                <NativeSelect value={agentId} onChange={e => setAgentId(e.target.value)}>
                  <NativeSelectOption value="">Select an agent…</NativeSelectOption>
                  {enabledAgents.map(a => <NativeSelectOption key={a.id} value={a.id}>{a.name}</NativeSelectOption>)}
                </NativeSelect>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                Post into
                <NativeSelect value={sessionId} onChange={e => setSessionId(e.target.value)}>
                  <NativeSelectOption value="">Select a channel or DM…</NativeSelectOption>
                  {sessions.map(s => <NativeSelectOption key={s.id} value={s.id}>{s.title || 'Untitled'}</NativeSelectOption>)}
                </NativeSelect>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                Prompt
                <Textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} placeholder="What should the agent do each run?" />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                Frequency
                <NativeSelect value={String(intervalSeconds)} onChange={e => setIntervalSeconds(Number(e.target.value))}>
                  {INTERVAL_CHOICES.map(c => <NativeSelectOption key={c.seconds} value={String(c.seconds)}>{c.label}</NativeSelectOption>)}
                </NativeSelect>
              </label>
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="outline" size="sm" onClick={() => { setCreating(false); resetForm(); }}>Cancel</Button>
                <Button type="button" size="sm" onClick={() => void submit()} disabled={!agentId || !sessionId}>Create schedule</Button>
              </div>
            </div>
          </div>
        ) : schedules.length === 0 ? (
          <Empty className="h-full border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Clock /></EmptyMedia>
              <EmptyTitle>No schedules yet</EmptyTitle>
              <EmptyDescription>Create a schedule to have an agent run a task automatically on a cadence.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {schedules.map(schedule => (
              <div key={schedule.id} className={cn('flex items-center gap-3 rounded-lg border bg-card/50 px-3 py-2.5', !schedule.enabled && 'opacity-60')}>
                <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', schedule.enabled ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')}>
                  <Clock className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{schedule.name || 'Untitled schedule'}</span>
                    {schedule.running && <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">running</span>}
                    {!schedule.enabled && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">paused</span>}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {agentName(schedule.agent_id)} · {intervalLabel(schedule.interval_seconds)} · into {sessionTitle(schedule.session_id)}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span>next {relativeTime(schedule.next_run_at)}</span>
                    {schedule.last_status === 'ok' && <span className="inline-flex items-center gap-0.5 text-emerald-500"><CircleCheck className="size-3" />ok</span>}
                    {schedule.last_status === 'error' && <span className="inline-flex items-center gap-0.5 text-destructive"><CircleX className="size-3" />failed</span>}
                    <span>· {schedule.run_count} run{schedule.run_count === 1 ? '' : 's'}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button type="button" variant="ghost" size="icon-xs" title="Run now" disabled={busyId === schedule.id} onClick={() => void runNow(schedule)}>
                    <Play className="size-4" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-xs" title={schedule.enabled ? 'Pause' : 'Resume'} disabled={busyId === schedule.id} onClick={() => void toggleEnabled(schedule)}>
                    {schedule.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
                  </Button>
                  <Button type="button" variant="ghost" size="icon-xs" title="Delete" onClick={() => void deleteSchedule(schedule.id)}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default SchedulesWindow;
