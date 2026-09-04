import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatChange } from '../../src/lib/auditEntry';

const panel = fs.readFileSync(
  path.resolve(process.cwd(), 'src/components/settings/AuditLogPanel.tsx'),
  'utf8',
);

describe('audit change formatting', () => {
  it('does not render a transition that did not transition', () => {
    // The server records before and after unconditionally, so re-asserting a
    // value writes a row where both match. Rendering that as "yolo to yolo"
    // claimed a change that never happened — and fifteen of them in a column
    // was the single loudest thing in the panel.
    expect(formatChange({ before_value: 'yolo', after_value: 'yolo' })).toBe('yolo (unchanged)');
    expect(formatChange({ before_value: 'default', after_value: 'yolo' })).toBe('default to yolo');
  });

  it('still shows a one-sided value', () => {
    expect(formatChange({ before_value: null, after_value: 'active' })).toBe('active');
    expect(formatChange({ before_value: 'archived', after_value: null })).toBe('archived');
    expect(formatChange({ before_value: null, after_value: null })).toBe('');
  });

  it('ignores whitespace when deciding a row is a no-op', () => {
    expect(formatChange({ before_value: 'yolo ', after_value: ' yolo' })).toBe('yolo (unchanged)');
  });
});

describe('audit row grouping', () => {
  // The grouping lives in a useMemo inside the panel, so this asserts the
  // properties that make it safe rather than re-implementing it: only ADJACENT
  // rows may merge, and only when every displayed field matches. Grouping
  // non-adjacent rows would let an audit log imply two events were one, which
  // is the one thing this panel must never do.
  it('only merges adjacent rows, and only on a full field match', () => {
    const memo = /const groups = useMemo\(\(\) => \{[\s\S]*?\}, \[rows\]\);/.exec(panel);
    expect(memo, 'grouping memo should exist').toBeTruthy();
    const body = memo![0];

    // Compares against the LAST emitted group only — i.e. adjacency.
    expect(body).toMatch(/out\[out\.length - 1\]/);
    // Every displayed column participates in the match. If a field is shown but
    // not compared, two visibly different rows could collapse into one.
    for (const field of ['actor', 'action', 'target', 'change', 'detail']) {
      expect(body, `grouping must compare ${field}`).toContain(`previous.row.${field} === row.${field}`);
    }
  });

  it('shows the count and the far end of the time range', () => {
    // A collapsed row that does not say how many it stands for, or over what
    // period, is hiding data rather than summarising it.
    expect(panel).toMatch(/x\{count\}/);
    expect(panel).toMatch(/to \{oldestTime\}/);
    expect(panel).toMatch(/identical entries between/);
  });
});
