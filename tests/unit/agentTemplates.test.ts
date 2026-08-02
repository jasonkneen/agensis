import { describe, expect, it } from 'vitest';
import {
  AGENT_TEMPLATES,
  agentExecutionRuntimeFromMetadata,
  agentFormRuntimeValueForAgent,
  agentFormRuntimeValueFromMetadata,
  agentMetadataWithRuntime,
  agentRuntimeLabel,
  agentRunModeHelp,
  agentRunModeLabel,
  dedupeHandle,
  executionRuntimeDisplayLabel,
  resolveAgentAcpHarness,
  resolveFormRuntimeSelection,
  runtimeChoicesFromAcpHarnesses,
  runtimeChoicesFromConnections,
} from '../../src/lib/agentTemplates';

describe('agentRunModeLabel', () => {
  it('maps wire run_mode to Direct / Relay / Connector', () => {
    expect(agentRunModeLabel('builtin')).toBe('Direct');
    expect(agentRunModeLabel('daemon')).toBe('Relay');
    expect(agentRunModeLabel('sandbox')).toBe('Relay');
    expect(agentRunModeLabel('external')).toBe('Connector');
    expect(agentRunModeLabel(null)).toBe('Direct');
  });

  it('offers short help for each mode', () => {
    expect(agentRunModeHelp('builtin')).toMatch(/agensis/i);
    expect(agentRunModeHelp('daemon')).toMatch(/desktop ACP|CLI/i);
    expect(agentRunModeHelp('external')).toMatch(/MCP/i);
  });
});

describe('Connector run mode contract', () => {
  it('keeps external metadata separate from daemon runtime metadata', () => {
    expect(agentMetadataWithRuntime({ runtime: 'codex', acp_harness: 'grok', custom: true }, 'claude', 'external')).toEqual({
      custom: true,
    });
  });
});

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

  it('clears the pin for desktop ACP so Hermes/Grok are not forced to Claude', () => {
    expect(agentMetadataWithRuntime({ runtime: 'claude', custom: true }, 'desktop', 'daemon')).toEqual({
      custom: true,
    });
  });

  it('stores preferred ACP harness and clears classic pin', () => {
    expect(agentMetadataWithRuntime({ runtime: 'claude' }, 'desktop', 'daemon', 'hermes')).toEqual({
      acp_harness: 'hermes',
    });
  });

  it('clears harness when saving a classic pin', () => {
    expect(agentMetadataWithRuntime({ acp_harness: 'grok' }, 'codex', 'daemon')).toEqual({
      runtime: 'codex',
    });
  });
});

describe('ACP harness form values', () => {
  it('reads form value from acp_harness over a stale classic pin', () => {
    expect(agentFormRuntimeValueFromMetadata({ runtime: 'claude', acp_harness: 'hermes' })).toBe('acp:hermes');
    expect(agentExecutionRuntimeFromMetadata({ runtime: 'claude', acp_harness: 'hermes' })).toBe('desktop');
  });

  it('round-trips harness select values', () => {
    expect(resolveFormRuntimeSelection('acp:grok')).toEqual({ runtime: 'desktop', acpHarness: 'grok' });
    expect(resolveFormRuntimeSelection('claude')).toEqual({ runtime: 'claude', acpHarness: null });
    expect(resolveFormRuntimeSelection('desktop')).toEqual({ runtime: 'desktop', acpHarness: null });
  });

  it('labels harnesses for the UI', () => {
    expect(executionRuntimeDisplayLabel('desktop', 'hermes')).toBe('Hermes Agent');
    expect(executionRuntimeDisplayLabel('desktop', 'grok')).toBe('Grok Build');
    expect(executionRuntimeDisplayLabel('claude')).toBe('Claude');
  });

  it('prefers live connection harnessId over a stale Claude pin', () => {
    const harness = resolveAgentAcpHarness({
      metadata: { runtime: 'claude' },
      agentId: 'a1',
      name: 'Worker',
      connections: [{
        agent_id: 'a1',
        status: 'online',
        metadata: { runtime: 'agensis-desktop-acp', harnessId: 'hermes' },
      }],
    });
    expect(harness).toBe('hermes');
    expect(agentRuntimeLabel({
      metadata: { runtime: 'claude' },
      agentId: 'a1',
      name: 'Worker',
      connections: [{
        agent_id: 'a1',
        status: 'online',
        metadata: { runtime: 'agensis-desktop-acp', harnessId: 'hermes' },
      }],
      preferAcp: true,
    })).toBe('Hermes Agent');
  });

  it('infers harness from agent name when pin is stale', () => {
    expect(resolveAgentAcpHarness({
      metadata: { runtime: 'claude' },
      name: 'Hermes',
      handle: 'hermes',
    })).toBe('hermes');
    expect(agentFormRuntimeValueForAgent({
      metadata: { runtime: 'claude' },
      name: 'Grok coder',
      preferAcp: true,
    })).toBe('acp:grok');
  });

  it('does not claim Claude on desktop when harness is unknown', () => {
    expect(agentRuntimeLabel({
      metadata: { runtime: 'claude' },
      name: 'Helper',
      preferAcp: true,
    })).toBe('Desktop ACP');
    expect(agentFormRuntimeValueForAgent({
      metadata: { runtime: 'claude' },
      name: 'Helper',
      preferAcp: true,
    })).toBe('desktop');
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

    expect(choices.map(choice => choice.id)).toEqual(['desktop', 'claude', 'codex', 'amp']);
    expect(choices.find(choice => choice.id === 'claude')?.available).toBe(true);
    expect(choices.find(choice => choice.id === 'amp')?.reason).toBe('amp_project_unmatched');
    expect(choices.find(choice => choice.id === 'desktop')?.available).toBe(true);
  });

  it('keeps supported runtimes selectable when no daemon has reported yet', () => {
    expect(runtimeChoicesFromConnections([])).toEqual([
      { id: 'desktop', label: 'Desktop ACP', available: true, reason: null },
      { id: 'claude', label: 'Claude', available: null, reason: 'not_reported' },
      { id: 'codex', label: 'Codex', available: null, reason: 'not_reported' },
      { id: 'amp', label: 'Amp', available: null, reason: 'not_reported' },
    ]);
  });

  it('builds harness choices with acp: ids so Claude Code ≠ Claude pin', () => {
    const choices = runtimeChoicesFromAcpHarnesses([
      { id: 'grok', label: 'Grok Build', available: true },
      { id: 'hermes', label: 'Hermes Agent', available: true },
      { id: 'claude', label: 'Claude Code', available: false },
    ]);
    expect(choices.map(c => c.id)).toEqual(['acp:grok', 'acp:hermes', 'acp:claude']);
    expect(choices.find(c => c.id === 'acp:hermes')?.label).toBe('Hermes Agent');
    expect(choices.find(c => c.id === 'acp:claude')?.available).toBe(false);
  });
});
