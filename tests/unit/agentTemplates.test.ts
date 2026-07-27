import { describe, expect, it } from 'vitest';
import { AGENT_TEMPLATES, dedupeHandle } from '../../src/lib/agentTemplates';

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
});
