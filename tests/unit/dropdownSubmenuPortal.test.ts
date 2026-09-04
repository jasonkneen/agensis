import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'packages/ui/src/components/ui/dropdown-menu.tsx'),
  'utf8',
);

describe('dropdown submenu placement', () => {
  it('portals nested content out of the parent menu clipping box', () => {
    const start = source.indexOf('function DropdownMenuSubContent');
    const end = source.indexOf('\nexport {', start);
    const implementation = source.slice(start, end);
    expect(implementation).toContain('<DropdownMenuPrimitive.Portal>');
    expect(implementation).toContain('<DropdownMenuPrimitive.SubContent');
    expect(implementation.indexOf('<DropdownMenuPrimitive.Portal>'))
      .toBeLessThan(implementation.indexOf('<DropdownMenuPrimitive.SubContent'));
  });

  it('leaves room for collision handling at narrow window edges', () => {
    expect(source).toMatch(/function DropdownMenuSubContent\(\{[\s\S]*collisionPadding = 8/);
  });
});
