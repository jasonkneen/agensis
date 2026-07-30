import { describe, expect, it } from 'vitest';

import { directAiModel, isSharedModelRoute } from '../../src/lib/chatModelRouting';
import { availableChatModelId } from '../../src/lib/sharedModels';
import { AI_MODELS } from '../../src/types';

describe('shared chat model routing', () => {
  it('keeps a shared route selected even when the session has an agent model', () => {
    const shared = 'agensis/workspace-1/agent-1/qwen';
    expect(isSharedModelRoute(shared)).toBe(true);
    expect(directAiModel(shared, 'claude-opus-4-8')).toBe(shared);
    expect(directAiModel('auto', 'claude-opus-4-8')).toBe('claude-opus-4-8');
  });

  it('falls back to auto after a shared daemon route disappears', () => {
    expect(availableChatModelId('agensis/workspace-1/agent-1/qwen', AI_MODELS)).toBe('auto');
    expect(availableChatModelId('auto', AI_MODELS)).toBe('auto');
  });
});
