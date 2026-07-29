// ============================================================================
// tests/unit/agentTemplateMerge.test.ts
// ----------------------------------------------------------------------------
// The gallery merge: bundled templates plus authored ones, authored winning on a
// slug collision, and — the part that matters — an authored template producing
// NO metadata key when it prefills the create form.
//
// MUST live under tests/unit/**/*.test.ts. vitest.config.ts includes only that
// glob, and a test anywhere else silently never runs.
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  AGENT_TEMPLATES,
  mergeTemplateSources,
  type StoredAgentTemplate,
} from '../../src/lib/agentTemplates';

function stored(overrides: Partial<StoredAgentTemplate> = {}): StoredAgentTemplate {
  return {
    id: 'tpl-1',
    workspace_id: 'ws-1',
    slug: 'security-reviewer',
    name: 'Security Reviewer',
    category: 'Engineering',
    description: 'Reviews diffs for security problems.',
    handleHint: 'sec-reviewer',
    systemPrompt: 'You review code for security problems.',
    soul: 'Sceptical.',
    instructions: 'Always cite the line.',
    tools: ['read'],
    skills: ['security-review'],
    model: 'claude-opus-5',
    runMode: 'daemon',
    runtime: 'claude',
    avatar: '',
    accentColor: '#00a95c',
    revision: 1,
    source: 'authored',
    origin: {},
    created_by: 'user-1',
    ...overrides,
  };
}

describe('mergeTemplateSources', () => {
  it('returns the bundled list unchanged when nothing is authored', () => {
    // The fallback path. When the backend has not shipped the routes yet, the
    // hook yields [] and the gallery must look exactly as it does today.
    const merged = mergeTemplateSources(AGENT_TEMPLATES, []);
    expect(merged).toHaveLength(AGENT_TEMPLATES.length);
    expect(merged.map(t => t.id)).toEqual(AGENT_TEMPLATES.map(t => t.id));
  });

  it('puts authored templates first', () => {
    // They are the ones this workspace chose to write; burying them under 15
    // shipped ones would make authoring feel like it did nothing.
    const merged = mergeTemplateSources(AGENT_TEMPLATES, [stored()]);
    expect(merged[0].name).toBe('Security Reviewer');
    expect(merged).toHaveLength(AGENT_TEMPLATES.length + 1);
  });

  it('lets an authored template REPLACE a bundled one of the same slug', () => {
    // MUTATION: make bundled win instead -> this fails. A workspace that
    // deliberately rewrote "Researcher" means theirs; silently preferring the
    // shipped one would make their edit look like it did nothing.
    const bundledResearcher = AGENT_TEMPLATES.find(t => t.id === 'researcher');
    expect(bundledResearcher).toBeDefined();

    const merged = mergeTemplateSources(AGENT_TEMPLATES, [
      stored({ slug: 'researcher', name: 'Our Researcher', handleHint: 'researcher' }),
    ]);
    const researchers = merged.filter(t => t.handle === 'researcher');
    expect(researchers).toHaveLength(1);
    expect(researchers[0].name).toBe('Our Researcher');
    expect(merged).toHaveLength(AGENT_TEMPLATES.length);
  });

  it('carries an authored template through to the gallery entry', () => {
    const merged = mergeTemplateSources([], [stored()]);
    const entry = merged[0];
    expect(entry.handle).toBe('sec-reviewer');
    expect(entry.systemPrompt).toBe('You review code for security problems.');
    expect(entry.skills).toEqual(['security-review']);
    expect(entry.runMode).toBe('daemon');
    expect(entry.stored?.soul).toBe('Sceptical.');
  });

  it('never gives an authored gallery entry a metadata key', () => {
    // THE assertion in this file. The create form spreads what a template gives
    // it, and metadata is MANAGE_ONLY on workspace_agents — so even an empty
    // object would make instantiating an authored template require manage, and a
    // populated one would be an escalation path (host_folders becomes an
    // --add-dir argument on a real machine).
    // MUTATION: add `metadata: {}` in storedToGalleryTemplate -> this fails.
    const entry = mergeTemplateSources([], [stored()])[0];
    expect('metadata' in entry).toBe(false);
    expect(entry.stored && 'metadata' in entry.stored).toBe(false);
    expect(entry.stored && 'permission_mode' in entry.stored).toBe(false);
  });

  it('tolerates a malformed authored row without throwing', () => {
    // The server projects these, but a stale cache or a partial response must
    // not take the gallery down with it.
    const merged = mergeTemplateSources(
      AGENT_TEMPLATES,
      [{ ...stored(), tools: undefined as unknown as string[], skills: undefined as unknown as string[] }],
    );
    expect(merged[0].tools).toEqual([]);
    expect(merged[0].skills).toEqual([]);
  });

  it('handles empty inputs on both sides', () => {
    expect(mergeTemplateSources([], [])).toEqual([]);
  });
});

describe('the bundled array', () => {
  it('still exists and still has the onboarding presets', () => {
    // Onboarding reads AGENT_TEMPLATES directly for its one-click presets, so it
    // must work before a workspace has authored anything and must not gain a
    // network dependency on that path. It is also the fallback that makes
    // reverting the server a no-op for users.
    // MUTATION: delete the array once the table works -> onboarding breaks and
    // rollback stops working.
    expect(AGENT_TEMPLATES.length).toBeGreaterThan(0);
    for (const id of ['researcher', 'coder']) {
      expect(AGENT_TEMPLATES.some(t => t.id === id)).toBe(true);
    }
  });

  it('carries no permission mode on any bundled template', () => {
    // Bundled templates are reviewed code and may set metadata, but none should
    // be reaching for a permission mode either.
    for (const template of AGENT_TEMPLATES) {
      expect('permission_mode' in template).toBe(false);
      expect('permissionMode' in template).toBe(false);
    }
  });
});
