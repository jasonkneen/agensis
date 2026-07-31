import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

describe('composer controls', () => {
  it('does not render inert microphone or attachment controls', () => {
    const chat = read('src/components/windows/ChatWindowContent.tsx');
    const subthread = read('src/components/chat/SubThreadPanel.tsx');
    const home = read('src/components/home/HomeCanvas.tsx');

    expect(chat).not.toContain('aria-label="Voice input"');
    expect(subthread).not.toContain('aria-label="Voice input"');
    expect(home).not.toContain('title="Voice"');
    expect(home).not.toContain('title="Attach"');
  });
});
