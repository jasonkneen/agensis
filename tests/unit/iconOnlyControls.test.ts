import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

describe('icon-only controls expose an accessible name', () => {
  it('names the cross-channel sub-threads close button', () => {
    const source = fs.readFileSync(path.join(root, 'src/components/windows/ChatWindowContent.tsx'), 'utf8');
    expect(source).toContain('aria-label="Close sub-threads"');
    expect(source).toContain('title="Close sub-threads"');
  });

  it('names each automation delete button from the rule name', () => {
    const source = fs.readFileSync(path.join(root, 'src/components/windows/AutomationsWindowContent.tsx'), 'utf8');
    expect(source).toContain('aria-label={`Delete ${automation.name || \'automation\'}`}');
    expect(source).toContain('title={`Delete ${automation.name || \'automation\'}`}');
  });
});
