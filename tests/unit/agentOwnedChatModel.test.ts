import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('agent-owned chat model routing', () => {
  it('does not render or keep a model choice in either chat composer', () => {
    for (const file of [
      'src/components/windows/ChatWindowContent.tsx',
      'src/components/chat/ChatThreadPanel.tsx',
    ]) {
      const source = read(file);
      expect(source).not.toContain('ModelSelector');
      expect(source).not.toContain('selectedModel');
      expect(source).not.toContain('setModel(');
    }
  });

  it('adapts agent conversation sends to automatic routing at the app boundary', () => {
    const source = read('src/components/windows/WindowBodies.tsx');
    expect(source).toContain("onAppSendMessage(content, 'auto'");
    expect(source).not.toMatch(/handleSendMessage[\s\S]{0,180}\(content: string, model: string/);
    expect(source).not.toMatch(/handleSendThreadReply[\s\S]{0,180}\(content: string, model: string/);
  });

  it('does not offer a global default model that can override an agent', () => {
    const source = read('src/components/settings/SettingsDialog.tsx');
    expect(source).not.toContain('id="default-ai-model"');
    expect(source).not.toContain('You can still switch per chat');
  });

  it('does not replace a failed delegated agent with anonymous direct AI', () => {
    const source = read('src/hooks/useSubThreads.ts');
    expect(source).not.toContain("apiUrl('/backend/ai-chat')");
    expect(source).toContain('no fallback model was run');
  });
});
