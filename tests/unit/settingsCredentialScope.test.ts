import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

describe('workspace credential UI scope', () => {
  it('shows workspace control minting only to the actual owner', () => {
    const app = read('src/App.tsx');
    const settings = read('src/components/settings/SettingsDialog.tsx');

    expect(app).toContain('isWorkspaceOwner={Boolean(activeWorkspace?.user_id && activeWorkspace.user_id === user.id)}');
    expect(settings).toContain('{isWorkspaceOwner ? (');
    expect(settings).toContain('Only the workspace owner can issue its control credential.');
    expect(settings).toContain('cannot silently read private conversations');
  });

  it('clears one-time credentials and plaintext vault drafts on workspace change', () => {
    const settings = read('src/components/settings/SettingsDialog.tsx');

    expect(settings).toMatch(/setInfo\(null\);[\s\S]*?setAuto\(false\);[\s\S]*?}, \[workspaceId\]\);/);
    expect(settings).toMatch(/setDrafts\(\{\}\);[\s\S]*?setReveal\(\{\}\);[\s\S]*?}, \[workspaceId\]\);/);
  });
});
