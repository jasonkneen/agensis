import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('sub-thread window scope', () => {
  it('records the host chat whenever a sub-thread is opened', () => {
    const chat = read('src/components/windows/ChatWindowContent.tsx');
    expect(chat).toContain('onOpenSubThread?.(session, sessionId || undefined)');
    expect(chat).not.toContain('onOpenSubThread?.(session, inferredSessionId');

    const hook = read('src/hooks/useSubThreads.ts');
    expect(hook).toContain('setActiveSubThreadHostSessionId(hostSessionId || null)');
  });

  it('passes the active sub-thread only to its owning chat window', () => {
    const app = read('src/App.tsx');
    expect(app).toContain('activeSubThreadHostSessionId === winSession.id');
    expect(app).toContain('activeSubThread={ownsActiveSubThread ? activeSubThread : null}');
    expect(app).toContain('subThreadMessages={ownsActiveSubThread ? subThreadMessages : EMPTY_MESSAGES}');
  });

  it('ignores transcript responses for a sub-thread that is no longer active', () => {
    const hook = read('src/hooks/useSubThreads.ts');
    expect(hook).toContain('activeSubThreadIdRef.current === sessionId');
    expect(hook).toContain('activeSubThreadIdRef.current = null');
  });
});
