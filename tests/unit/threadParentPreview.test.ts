import { describe, expect, it } from 'vitest';
import { clipToBlockBoundary } from '../../src/lib/threadParentPreview';

describe('thread parent preview clipping', () => {
  it('hard-clips a single oversized paragraph instead of rendering the whole parent', () => {
    const text = 'a'.repeat(1_000);
    const clipped = clipToBlockBoundary(text, 220);
    expect(clipped.length).toBeLessThan(230);
    expect(clipped.endsWith('…')).toBe(true);
  });

  it('never leaves a long opening code fence unterminated', () => {
    const text = `\`\`\`ts\n${'const value = 1;\n'.repeat(100)}\`\`\`\n\nAfter`;
    const clipped = clipToBlockBoundary(text, 220);
    expect((clipped.match(/```/g) || [])).toHaveLength(2);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped).not.toContain('After');
  });

  it('stops at the last complete markdown block when one is available', () => {
    const first = 'Short first block.';
    const text = `${first}\n\n${'second '.repeat(100)}`;
    expect(clipToBlockBoundary(text, 100)).toBe(first);
  });
});
