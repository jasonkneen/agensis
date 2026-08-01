import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('participant popover controls', () => {
  it('keeps the remove button outside Radix menuitem roving focus', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/components/windows/ChatWindowContent.tsx'),
      'utf8',
    );
    const start = source.indexOf('{participants.map(participant => (');
    const end = source.indexOf('{/* Thread widgets show themselves', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    expect(block).toContain('<div key={participant.id}');
    expect(block).not.toContain('<DropdownMenuItem key={participant.id}');
    expect(block).toContain('aria-label={`Remove ${participant.name} from this channel`}');
  });
});
