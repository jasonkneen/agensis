import { describe, expect, it } from 'vitest';
import {
  automaticAgentAvatar,
  isAutomaticAgentAvatar,
  renderAgentAvatar,
  resolveAgentAvatar,
} from '../../src/lib/agentAvatars';
import { isImageAvatar, renderablePetAssetUrl } from '../../src/lib/openpets';

describe('agent avatars', () => {
  it('uses a compact deterministic Blobatar marker for the automatic default', () => {
    expect(automaticAgentAvatar('Researcher')).toBe('blobatar:researcher');
    expect(automaticAgentAvatar('Researcher')).toBe(automaticAgentAvatar('Researcher'));
    expect(resolveAgentAvatar('', 'Researcher')).toBe('blobatar:researcher');
    expect(resolveAgentAvatar('AI', 'Researcher')).toBe('blobatar:researcher');
  });

  it('recognises automatic values so the form can switch back from a manual choice', () => {
    expect(isAutomaticAgentAvatar('')).toBe(true);
    expect(isAutomaticAgentAvatar('AI')).toBe(true);
    expect(isAutomaticAgentAvatar('blobatar:researcher')).toBe(true);
    expect(isAutomaticAgentAvatar('icon:bot')).toBe(false);
    expect(isAutomaticAgentAvatar('/agent-avatars/set1-fox-hoodie.png')).toBe(false);
  });

  it('gives bare-initials placeholders a Blobatar instead of rendering text', () => {
    expect(isAutomaticAgentAvatar('CO')).toBe(true);
    expect(resolveAgentAvatar('CO', 'Coder')).toBe('blobatar:coder');
    expect(isImageAvatar('CO')).toBe(true);
    expect(isAutomaticAgentAvatar('icon:bot')).toBe(false);
  });

  it('keeps manual choices and renders automatic values locally', () => {
    const manual = '/agent-avatars/set1-fox-hoodie.png';
    expect(resolveAgentAvatar(manual, 'Researcher')).toBe(manual);

    const rendered = renderAgentAvatar('blobatar:researcher');
    expect(rendered).toMatch(/^data:image\/svg\+xml,/);
    expect(rendered).toBe(renderAgentAvatar('blobatar:researcher'));
    expect(renderAgentAvatar('AI', 'Researcher')).toBe(renderAgentAvatar('', 'Researcher'));
    expect(isImageAvatar('blobatar:researcher')).toBe(true);
    expect(renderablePetAssetUrl('blobatar:researcher')).toBe(rendered);
  });
});
