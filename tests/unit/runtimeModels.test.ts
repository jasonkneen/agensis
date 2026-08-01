import { describe, expect, it } from 'vitest';
import {
  modelOptionsForRuntime,
  modelSurvivesRuntimeChange,
  runtimeModelCatalog,
} from '../../src/lib/runtimeModels';
import { AI_MODELS, CODEX_MODELS } from '../../src/types';

// "Models are not updating for different runtimes" was two defects wearing one
// coat:
//   1. Codex offered a single "Codex default" entry, though the daemon has
//      always pushed `codex --model <id>`. Changing runtime changed nothing.
//   2. The model was only reset on the way OUT of Claude, never back IN, so
//      Codex -> Claude left a gpt-… id selected under the Claude picker.

describe('runtimeModelCatalog', () => {
  it('offers the real Codex models, not just a default', () => {
    const codex = runtimeModelCatalog('codex');
    expect(codex.length).toBeGreaterThan(1);
    expect(codex.map(m => m.id)).toContain('gpt-5.6-sol');
  });

  it('offers nothing for Amp, which takes no --model at all', () => {
    expect(runtimeModelCatalog('amp')).toEqual([]);
  });

  it('offers nothing fixed for desktop ACP (Hermes/Grok freeform)', () => {
    expect(runtimeModelCatalog('desktop')).toEqual([]);
  });

  it('offers the Claude models for Claude, minus the auto pseudo-entry', () => {
    const claude = runtimeModelCatalog('claude');
    expect(claude.map(m => m.id)).toContain('claude-fable-5');
    expect(claude.map(m => m.id)).not.toContain('auto');
  });

  it('keeps the two catalogs disjoint — that is what makes the reset rule safe', () => {
    const claude = new Set(AI_MODELS.map(m => m.id));
    expect(CODEX_MODELS.every(m => !claude.has(m.id))).toBe(true);
  });
});

describe('modelSurvivesRuntimeChange', () => {
  it('drops a Claude model when moving to Codex', () => {
    expect(modelSurvivesRuntimeChange('claude-fable-5', 'codex')).toBe(false);
  });

  // THE REGRESSION: this direction had no reset at all.
  it('drops a Codex model when moving back to Claude', () => {
    expect(modelSurvivesRuntimeChange('gpt-5.6-sol', 'claude')).toBe(false);
  });

  it('drops everything when moving to Amp, which manages its own model', () => {
    expect(modelSurvivesRuntimeChange('gpt-5.6-sol', 'amp')).toBe(false);
    expect(modelSurvivesRuntimeChange('claude-fable-5', 'amp')).toBe(false);
  });

  it('keeps auto and empty, which mean "the runtime default" everywhere', () => {
    expect(modelSurvivesRuntimeChange('auto', 'codex')).toBe(true);
    expect(modelSurvivesRuntimeChange('', 'claude')).toBe(true);
    expect(modelSurvivesRuntimeChange('auto', 'amp')).toBe(true);
  });

  // Narrow on purpose: an unrecognised id is most likely a shared/custom model
  // the user configured, and Codex accepts arbitrary ids anyway.
  it('keeps an unrecognised id rather than clobbering a shared/custom model', () => {
    expect(modelSurvivesRuntimeChange('my-shared-model', 'claude')).toBe(true);
    expect(modelSurvivesRuntimeChange('gpt-6-unreleased', 'codex')).toBe(true);
  });
});

describe('modelOptionsForRuntime', () => {
  it('lists Codex models under the Codex default', () => {
    const options = modelOptionsForRuntime('auto', 'daemon', 'codex');
    expect(options[0]).toMatchObject({ id: 'auto', label: 'Codex default' });
    expect(options.map(o => o.id)).toContain('gpt-5.6-terra');
  });

  it('gives Amp only its default — there is nothing else to honestly offer', () => {
    const options = modelOptionsForRuntime('auto', 'daemon', 'amp');
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ id: 'auto', label: 'Amp default' });
  });

  it('keeps an already-saved id selectable so opening an agent cannot re-point it', () => {
    const options = modelOptionsForRuntime('gpt-6-unreleased', 'daemon', 'codex');
    expect(options[0]).toMatchObject({ id: 'gpt-6-unreleased', label: 'gpt-6-unreleased (saved)' });
  });

  it('does not duplicate a saved id that is already in the catalog', () => {
    const ids = modelOptionsForRuntime('gpt-5.5', 'daemon', 'codex').map(o => o.id);
    expect(ids.filter(id => id === 'gpt-5.5')).toHaveLength(1);
  });

  it('a builtin agent gets the Claude list regardless of the runtime field', () => {
    expect(modelOptionsForRuntime('auto', 'builtin', 'codex')).toEqual(AI_MODELS);
  });

  it('desktop ACP offers harness default plus freeform-friendly catalogs', () => {
    const options = modelOptionsForRuntime('auto', 'daemon', 'desktop');
    expect(options[0]).toMatchObject({ id: 'auto', label: 'Harness default' });
    expect(options.map(o => o.id)).toContain('claude-sonnet-5');
  });
});
