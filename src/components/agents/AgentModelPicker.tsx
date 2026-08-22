/**
 * Compact per-agent model and effort level control (same role as desktop hosts that put model
 * on the agent, not in the human chat composer).
 *
 * - Lists models and effort levels for the agent's run mode + execution runtime.
 * - Persists `agent.model` and `agent.effort` via parent update callbacks.
 * - If a local ACP session is running, shows "restart to apply" — we do not
 *   have a mid-turn switch_model wire yet; restart re-mints and restarts ACP.
 */
import { useMemo, useState } from 'react';
import { ChevronDown, Sparkles, Zap } from 'lucide-react';
import type { WorkspaceAgent } from '../../types';
import { modelOptionsForRuntime } from '../../lib/runtimeModels';
import { EFFORT_LEVELS } from '../../lib/effortLevels';
import {
  agentModelPickerCanSwitch,
  agentAcpHarnessFromMetadata,
  agentExecutionRuntimeFromMetadata,
  normalizeAgentRunMode,
  type AgentExecutionRuntime,
} from '../../lib/agentTemplates';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

function executionRuntime(agent: WorkspaceAgent): AgentExecutionRuntime {
  return agentExecutionRuntimeFromMetadata(agent.metadata as Record<string, unknown> | undefined);
}

function runModeOf(agent: WorkspaceAgent) {
  return normalizeAgentRunMode(agent.run_mode);
}

export function AgentModelPicker({
  agent,
  onChangeModel,
  onChangeEffort,
  acpRunning = false,
  onRestartAcp,
  className,
  disabled = false,
}: {
  agent: WorkspaceAgent;
  /** Persist the new model on the agent row. */
  onChangeModel: (modelId: string) => void | Promise<unknown>;
  /** Persist the new effort level on the agent row. */
  onChangeEffort?: (effort: string) => void | Promise<unknown>;
  /** True when desktop ACP (or a live daemon connection) is active for this agent. */
  acpRunning?: boolean;
  /** Optional: re-Start ACP so the new model is picked up. Receives the model id to apply. */
  onRestartAcp?: (modelId: string) => void | Promise<unknown>;
  className?: string;
  disabled?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [pendingEffort, setPendingEffort] = useState<string | null>(null);
  const [error, setError] = useState('');

  const runtime = executionRuntime(agent);
  const runMode = runModeOf(agent);
  // The pinned harness decides which models are even meaningful here — a Grok
  // agent must not be offered (or pinned to) a Claude id.
  const acpHarness = agentAcpHarnessFromMetadata(agent.metadata as Record<string, unknown> | undefined);
  const current = pendingModel ?? (agent.model || 'auto');
  const options = useMemo(
    () => modelOptionsForRuntime(current, runMode, runtime, acpHarness),
    [current, runMode, runtime, acpHarness],
  );
  const selected = options.find(o => o.id === current) || options[0];
  const displayLabel = selected?.label || current || 'Auto';

  // Amp and Connector clients manage their own model — picker is display-only.
  // Desktop ACP (Hermes/Grok/…) can freeform via the option list + saved ids.
  const canSwitch = agentModelPickerCanSwitch(runMode, runtime);

  const handleChange = async (modelId: string) => {
    if (!canSwitch || modelId === (agent.model || 'auto') || disabled) return;
    setSaving(true);
    setError('');
    setPendingModel(modelId);
    try {
      await onChangeModel(modelId);
      if (acpRunning) setNeedsRestart(true);
      else {
        setNeedsRestart(false);
        setPendingModel(null);
      }
    } catch (err) {
      setPendingModel(null);
      setError(err instanceof Error ? err.message : 'Could not update model');
    } finally {
      setSaving(false);
    }
  };

  const handleEffortChange = async (effort: string) => {
    if (!onChangeEffort || effort === (agent.effort || 'auto') || disabled) return;
    setSaving(true);
    setError('');
    setPendingEffort(effort);
    try {
      await onChangeEffort(effort);
      setPendingEffort(null);
    } catch (err) {
      setPendingEffort(null);
      setError(err instanceof Error ? err.message : 'Could not update effort');
    } finally {
      setSaving(false);
    }
  };

  const handleRestart = async () => {
    if (!onRestartAcp) return;
    setSaving(true);
    setError('');
    try {
      await onRestartAcp(pendingModel || agent.model || 'auto');
      setNeedsRestart(false);
      setPendingModel(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restart failed');
    } finally {
      setSaving(false);
    }
  };

  const currentEffort = pendingEffort ?? (agent.effort || "auto");

  return (
    <span className={cn('inline-flex max-w-full flex-wrap items-center gap-1.5', className)}>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={saving || disabled || !canSwitch}
            className="h-7 max-w-full justify-start gap-1.5 rounded-full border border-border/50 bg-muted/45 px-2.5 text-xs font-medium shadow-none hover:bg-muted/70"
            aria-label={`Model for ${agent.name}`}
            title={canSwitch ? "Change this agent's model" : "This runtime chooses its own model"}
          >
            {current === 'auto' ? (
              <Sparkles className="size-3.5 shrink-0 opacity-70" />
            ) : (
              <Zap className="size-3.5 shrink-0 opacity-70" />
            )}
            <span className="min-w-0 truncate">{displayLabel}</span>
            {canSwitch && <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />}
          </Button>
        </DropdownMenuTrigger>
        {canSwitch && (
          <DropdownMenuContent align="start" className="max-h-64 min-w-48 overflow-y-auto">
            <DropdownMenuRadioGroup value={current} onValueChange={(v) => { void handleChange(v); }}>
              {options.map(model => (
                <DropdownMenuRadioItem key={model.id} value={model.id} className="text-xs">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium">{model.label}</span>
                    {model.description && (
                      <span className="text-[11px] text-muted-foreground">{model.description}</span>
                    )}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        )}
      </DropdownMenu>
      {onChangeEffort && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={saving || disabled}
              className="h-7 max-w-full justify-start gap-1.5 rounded-full border border-border/50 bg-muted/45 px-2.5 text-xs font-medium shadow-none hover:bg-muted/70"
              aria-label={`Effort level for ${agent.name}`}
              title="Change this agent's reasoning effort"
            >
              <Sparkles className="size-3.5 shrink-0 opacity-70" />
              <span className="min-w-0 truncate">{EFFORT_LEVELS.find(e => e.id === currentEffort)?.label || currentEffort}</span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-48">
            <DropdownMenuRadioGroup value={currentEffort} onValueChange={(v) => { void handleEffortChange(v); }}>
              {EFFORT_LEVELS.map(level => (
                <DropdownMenuRadioItem key={level.id} value={level.id} className="text-xs">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium">{level.label}</span>
                    <span className="text-[11px] text-muted-foreground">{level.description}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {needsRestart && acpRunning && (
        onRestartAcp ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            disabled={saving}
            onClick={() => { void handleRestart(); }}
          >
            Restart to apply
          </Button>
        ) : (
          <span className="text-[11px] text-amber-600 dark:text-amber-400">restart to apply</span>
        )
      )}
      {error && <span className="text-[11px] text-destructive">{error}</span>}
    </span>
  );
}
