import { describe, expect, it } from 'vitest';
import {
  AGENT_TEMPLATES,
  agentMetadataWithRuntime,
  dedupeHandle,
  runtimeChoicesFromConnections,
} from '../../src/lib/agentTemplates';

describe('dedupeHandle', () => {
  it('returns the base handle when it is free', () => {
    expect(dedupeHandle('coder-cli', ['scout', 'research'])).toBe('coder-cli');
  });

  it('suffixes when the base handle is taken', () => {
    expect(dedupeHandle('coder-cli', ['coder-cli'])).toBe('coder-cli-2');
    expect(dedupeHandle('coder-cli', ['coder-cli', 'coder-cli-2'])).toBe('coder-cli-3');
  });

  it('matches existing handles case-insensitively', () => {
    expect(dedupeHandle('Coder-CLI', ['coder-cli'])).toBe('Coder-CLI-2');
  });

  it('handles an empty taken list', () => {
    expect(dedupeHandle('pm', [])).toBe('pm');
  });
});

describe('AGENT_TEMPLATES', () => {
  it('gives every one-click onboarding preset a fixed avatar', () => {
    const presetIds = ['researcher', 'writer', 'pm', 'summarizer'];
    for (const id of presetIds) {
      const tpl = AGENT_TEMPLATES.find(t => t.id === id);
      expect(tpl, `template ${id} exists`).toBeDefined();
      expect(tpl!.avatar, `template ${id} has an avatar`).toMatch(/^\/agent-avatars\//);
      expect(tpl!.runMode).toBe('builtin');
    }
  });

  it('keeps template handles unique', () => {
    const handles = AGENT_TEMPLATES.map(t => t.handle);
    expect(new Set(handles).size).toBe(handles.length);
  });

  it('defines Amp Orb as an explicit daemon runtime, never a generic fallback', () => {
    const template = AGENT_TEMPLATES.find(t => t.id === 'amp-orb');
    expect(template).toBeDefined();
    expect(template!.runMode).toBe('daemon');
    expect(template!.runtime).toBe('amp');
  });

  it('preconfigures every remote template with a supported execution runtime', () => {
    for (const template of AGENT_TEMPLATES.filter(t => t.runMode === 'daemon')) {
      expect(['claude', 'codex', 'amp'], `${template.id} has a supported runtime`).toContain(template.runtime);
    }
  });

  it('keeps Coder collaborative and provides an explicit code-handling resource', () => {
    const coder = AGENT_TEMPLATES.find(template => template.id === 'coder');
    const handler = AGENT_TEMPLATES.find(template => template.id === 'code-handler');
    expect(coder?.purpose).toBe('collaborator');
    expect(coder?.resourceFacets).toEqual([]);
    expect(handler?.purpose).toBe('resource');
    expect(handler?.resourceFacets).toEqual(['tooling', 'code']);
  });

  it('backfills every pre-classification bundled template as a collaborator', () => {
    for (const template of AGENT_TEMPLATES) {
      expect(['collaborator', 'resource']).toContain(template.purpose);
      if (template.purpose === 'collaborator') expect(template.resourceFacets).toEqual([]);
      else expect(template.resourceFacets.length).toBeGreaterThan(0);
    }
  });
});

describe('agentMetadataWithRuntime', () => {
  it('preserves unrelated metadata while setting a remote runtime', () => {
    expect(agentMetadataWithRuntime({ host_folders: ['/workspace'], custom: true }, 'amp', 'daemon')).toEqual({
      host_folders: ['/workspace'],
      custom: true,
      runtime: 'amp',
    });
  });

  it('removes only the runtime when an agent becomes built-in', () => {
    expect(agentMetadataWithRuntime({ runtime: 'codex', custom: true }, 'claude', 'builtin')).toEqual({ custom: true });
  });
});

describe('runtimeChoicesFromConnections', () => {
  it('uses bounded daemon runtime reports rather than the generic CLI list', () => {
    const choices = runtimeChoicesFromConnections([
      {
        status: 'online',
        capabilities: {
          clis: ['amp', 'claude', 'codex', 'node'],
          runtimes: {
            claude: { id: 'claude', label: 'Claude', available: true, reason: null },
            codex: { id: 'codex', label: 'Codex', available: false, reason: 'codex_not_installed' },
            amp: { id: 'amp', label: 'Amp', available: false, reason: 'amp_project_unmatched' },
          },
        },
      },
    ]);

    expect(choices.map(choice => choice.id)).toEqual(['claude', 'codex', 'amp']);
    expect(choices.find(choice => choice.id === 'claude')?.available).toBe(true);
    expect(choices.find(choice => choice.id === 'amp')?.reason).toBe('amp_project_unmatched');
  });

  it('keeps supported runtimes selectable when no daemon has reported yet', () => {
    expect(runtimeChoicesFromConnections([])).toEqual([
      { id: 'claude', label: 'Claude', available: null, reason: 'not_reported' },
      { id: 'codex', label: 'Codex', available: null, reason: 'not_reported' },
      { id: 'amp', label: 'Amp', available: null, reason: 'not_reported' },
    ]);
  });
});
