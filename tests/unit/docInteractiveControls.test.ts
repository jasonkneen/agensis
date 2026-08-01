import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const docSource = readFileSync(
  resolve(process.cwd(), 'src/components/windows/DocWindowContent.tsx'),
  'utf8',
);
const styleSource = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

describe('document embedded controls', () => {
  it('uses a native button for sketch clearing so keyboard activation works', () => {
    expect(docSource).toContain('<button type="button" class="doc-sketch-clear">Clear</button>');
    expect(docSource).not.toContain('role="button" tabindex="0" class="doc-sketch-clear"');
    expect(styleSource).toContain('.doc-sketch-clear:focus-visible');
  });
});
