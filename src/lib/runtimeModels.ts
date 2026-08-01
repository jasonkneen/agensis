// Which models a daemon agent can be given, per execution runtime.
//
// Two things were wrong before this existed, and both read to a user as "the
// model list doesn't update when I change the runtime":
//
//  1. Choosing Codex offered exactly one entry, "Codex default" — even though
//     the daemon has always pushed `--model <id>` for codex commands. The
//     runtime changed, the list didn't.
//  2. Switching runtimes only ever reset the model in ONE direction (to 'auto'
//     when leaving Claude). Going Codex -> Claude left a `gpt-…` id selected,
//     which the Claude picker then re-displayed as "gpt-5.6-sol (saved)".
//
// Amp is deliberately model-less: `ampRuntime.mjs` has no model handling at
// all, because Amp manages its own. "Amp default" is the honest choice there,
// not an omission.

import { AI_MODELS, CODEX_MODELS, type AIModel } from '../types';
import type { AgentExecutionRuntime } from './agentTemplates';

/** Ties the Codex model input to its suggestion list. */
export const CODEX_MODEL_LIST_ID = 'agent-codex-model-options';

/** The models offered for a runtime. Empty for Amp — it takes no `--model`. */
export function runtimeModelCatalog(runtime: AgentExecutionRuntime): AIModel[] {
  if (runtime === 'codex') return CODEX_MODELS;
  if (runtime === 'amp' || runtime === 'desktop') return [];
  return AI_MODELS.filter(model => model.id !== 'auto');
}

/**
 * Should changing the runtime to `next` discard the currently-selected model?
 *
 * Deliberately narrow: it only clears an id that demonstrably belongs to a
 * DIFFERENT runtime. An unrecognised id is left alone, because it is most
 * likely a shared/custom model (see `sharedModels` on AgentCapabilities) that
 * the user configured on purpose — clobbering it on an incidental runtime
 * toggle would be its own bug.
 */
export function modelSurvivesRuntimeChange(model: string, next: AgentExecutionRuntime): boolean {
  if (!model || model === 'auto') return true;
  // Amp takes no model at all, so nothing survives the switch.
  if (next === 'amp') return false;
  // Desktop ACP / Hermes etc. accept freeform ids — keep whatever was set.
  if (next === 'desktop') return true;
  const foreign = next === 'codex'
    ? AI_MODELS.some(entry => entry.id === model)
    : CODEX_MODELS.some(entry => entry.id === model);
  return !foreign;
}

/**
 * The option list for the model select.
 *
 * `current` is threaded through so a model already saved on the agent stays
 * selectable even when it is not in the offered set — otherwise opening an
 * existing agent would silently re-point it at something else.
 */
export function modelOptionsForRuntime(
  current: string,
  runMode: 'builtin' | 'daemon' | 'sandbox',
  runtime: AgentExecutionRuntime,
): AIModel[] {
  if (runMode === 'daemon' && runtime === 'desktop') {
    const fallback: AIModel = {
      id: 'auto',
      label: 'Harness default',
      description: 'Whatever Hermes / Grok / Goose / … uses locally',
    };
    const offered = [fallback, ...AI_MODELS.filter(m => m.id !== 'auto'), ...CODEX_MODELS];
    const isKnown = current === 'auto'
      || offered.some(entry => entry.id === current);
    return current && !isKnown
      ? [{ id: current, label: current, description: 'Saved on this agent' }, ...offered]
      : offered;
  }
  if (runMode === 'daemon' && runtime !== 'claude') {
    const fallback: AIModel = {
      id: 'auto',
      label: runtime === 'amp' ? 'Amp default' : 'Codex default',
      description: runtime === 'amp'
        ? 'Amp chooses its own model'
        : "Uses the host's Codex configuration",
    };
    const catalog = runtimeModelCatalog(runtime);
    const offered = [fallback, ...catalog];
    const isKnown = current === 'auto' || catalog.some(entry => entry.id === current);
    return current && !isKnown
      ? [{ id: current, label: `${current} (saved)`, description: 'Saved on this agent' }, ...offered]
      : offered;
  }
  if (!current || AI_MODELS.some(model => model.id === current)) return AI_MODELS;
  return [{ id: current, label: current, description: 'Saved model' }, ...AI_MODELS];
}
