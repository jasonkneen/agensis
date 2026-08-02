/**
 * Compact per-agent model control (same role as desktop hosts that put model
 * on the agent, not in the human chat composer).
 *
 * - Lists models for the agent's run mode + execution runtime.
 * - Persists `agent.model` via the parent update callback.
 * - If a local ACP session is running, shows "restart to apply" — we do not
 *   have a mid-turn switch_model wire yet; restart re-mints and restarts ACP.
 */
import { useMemo, useState } from 'react';
import { ChevronDown, Sparkles, Zap } from 'lucide-react';
import type { WorkspaceAgent } from '../../types';
import { modelOptionsForRuntime } from '../../lib/runtimeModels';
import {
  agentModelPickerCanSwitch,
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
  acpRunning = false,
  onRestartAcp,
  className,
  disabled = false,
}: {
  agent: WorkspaceAgent;
  /** Persist the new model on the agent row. */
  onChangeModel: (modelId: string) => void | Promise<unknown>;
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
  const [error, setError] = useState('');

  const runtime = executionRuntime(agent);
  const runMode = runModeOf(agent);
  const current = pendingModel ?? (agent.model || 'auto');
  const options = useMemo(
    () => modelOptionsForRuntime(current, runMode, runtime),
    [current, runMode, runtime],
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
            title={canSwitch ? 'Change this agent’s model' : 'This runtime chooses its own model'}
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
