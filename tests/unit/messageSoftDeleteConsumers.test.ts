import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

describe('message soft-delete realtime consumers', () => {
  it.each([
    'src/hooks/useChat.ts',
    'src/hooks/useSessionMessages.ts',
    'src/hooks/useSubThreads.ts',
    'src/hooks/useHuddleTranscript.ts',
  ])('%s routes retained rows through the tombstone redactor', (file) => {
    const source = read(file);
    expect(source).toContain('redactDeletedMessage');
    expect(source).not.toMatch(/payload\.eventType === 'UPDATE'[\s\S]{0,250}row\.deleted_at[\s\S]{0,120}filter\(/);
  });

  it('delegates every mounted app chat transcript to the same redacting message hook', () => {
    const app = read('src/App.tsx');
    const bodies = read('src/components/windows/WindowBodies.tsx');
    expect(app).toContain('<ChatWindowBody');
    expect(bodies).toContain('useSessionMessages(isActiveSession ? null : sessionId)');
    expect(bodies).not.toMatch(/messages=.*filter\([^)]*deleted_at/);
  });

  it('sub-thread cold loads exclude deleted sessions but retain redacted message anchors', () => {
    const source = read('src/hooks/useSubThreads.ts');
    expect(source).toMatch(/if \(session\.deleted_at\) continue/);
    expect(source).toMatch(/\(result\.messages \|\| \[\]\)\.map\(normalizeMessage\)/);
  });

  it('an optimistic delete renders a tombstone instead of removing the root', () => {
    const source = read('src/components/windows/ChatWindowContent.tsx');
    expect(source).toContain('toDeletedMessageTombstone(merged)');
    expect(source).not.toMatch(/filter\(message => !overrides\[message\.id\]\?\.deleted\)/);
  });
});
