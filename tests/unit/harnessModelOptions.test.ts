// The model picker offered AI_MODELS + CODEX_MODELS to EVERY ACP-harness agent,
// so a Grok agent was shown Claude ids — and got pinned to claude-opus-5, which
// then rode into its connection string and its prompt, and it introduced itself
// as Claude. A harness we have a catalog for must offer only its own models.

import { describe, it, expect } from 'vitest';
import { modelOptionsForRuntime, harnessModelCatalog } from '../../src/lib/runtimeModels';

describe('model options for an ACP harness', () => {
  it('offers a grok agent only grok models, never Claude or Codex ids', () => {
    const options = modelOptionsForRuntime('auto', 'daemon', 'desktop', 'grok');
    const ids = options.map(o => o.id);

    expect(ids).toContain('grok-4.5');
    expect(ids.some(id => id.startsWith('claude-'))).toBe(false);
    expect(ids.some(id => id.startsWith('gpt-'))).toBe(false);
  });

  it('keeps a model already saved on the agent selectable', () => {
    // Never silently re-point an existing agent at something else.
    const ids = modelOptionsForRuntime('grok-code-fast-1', 'daemon', 'desktop', 'grok').map(o => o.id);
    expect(ids).toContain('grok-code-fast-1');
  });

  it('still offers the broad list for a harness we have no catalog for', () => {
    // Hermes/Goose/Cursor: we genuinely do not know their ids, so do not pretend.
    const ids = modelOptionsForRuntime('auto', 'daemon', 'desktop', 'hermes').map(o => o.id);
    expect(ids).toContain('auto');
    expect(ids.length).toBeGreaterThan(1);
    expect(harnessModelCatalog('hermes')).toHaveLength(0);
  });

  it('leaves the Claude and Codex runtimes exactly as they were', () => {
    const claudeIds = modelOptionsForRuntime('auto', 'daemon', 'claude').map(o => o.id);
    expect(claudeIds.some(id => id.startsWith('claude-'))).toBe(true);

    const codexIds = modelOptionsForRuntime('auto', 'daemon', 'codex').map(o => o.id);
    expect(codexIds.some(id => id.startsWith('gpt-'))).toBe(true);
    expect(codexIds.some(id => id.startsWith('claude-'))).toBe(false);
  });
});
