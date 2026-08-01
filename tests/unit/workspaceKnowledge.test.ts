import { describe, expect, it } from 'vitest';
import type { SystemCapabilities } from '../../src/lib/backendClient';
import { buildContextCounts } from '../../src/hooks/useWorkspaceKnowledge';

describe('workspace knowledge capability boundary', () => {
  it('treats malformed capability arrays as empty instead of crashing the shell', () => {
    const malformed = {
      skills: null,
      clis: null,
      packages: null,
      codexAppServer: null,
    } as unknown as SystemCapabilities;

    expect(buildContextCounts([], [], [], [], [], malformed)).toEqual({
      docs: 0,
      facts: 0,
      tasks: 0,
      agents: 0,
      skills: 0,
      commands: 0,
      tools: 0,
      webhooks: 0,
    });
  });
});
