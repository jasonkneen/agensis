import { describe, expect, it } from 'vitest';

// The operator CLI's pure output layer (cli/src/render.mjs). Everything here is
// a function of its arguments — no network, no streams, no clock — so it is
// pinned in the fast runner rather than in the node:test suite that drives the
// whole command.
//
// The node:test suite (tests/ops-cli.test.cjs) covers exit codes and stream
// discipline; this file covers the shape of what is written.
import {
  chooseFormat,
  formatTable,
  formatTimestamp,
  redact,
  renderHuman,
  truncateId,
} from '../../cli/src/render.mjs';

describe('redact', () => {
  it('removes every agensis credential prefix', () => {
    const prefixes = ['aga_', 'agw_', 'agx_', 'agf_', 'agc_', 'ago_', 'cbk_'];
    for (const prefix of prefixes) {
      expect(redact(`token=${prefix}AbC123_xyz-456 rest`)).toBe('token=[redacted] rest');
    }
  });

  it('removes an exact secret that matches no prefix at all', () => {
    // verifyMcpToken also accepts a user LOGIN token, which has no prefix. A
    // pattern-only redactor prints it in full, so the resolved credential is
    // also redacted by identity.
    const session = 'ZmFrZS1zZXNzaW9uLXRva2VuLXZhbHVl';
    expect(redact(`auth ${session}`)).toContain(session);
    expect(redact(`auth ${session}`, [session])).toBe('auth [redacted]');
  });

  it('ignores short strings so output does not turn to confetti', () => {
    expect(redact('the cat sat', ['cat'])).toBe('the cat sat');
  });

  it('passes through text with no credentials in it', () => {
    expect(redact('channels: 3')).toBe('channels: 3');
    expect(redact(null as unknown as string)).toBe('');
  });
});

describe('chooseFormat', () => {
  it('defaults to JSON when stdout is not a terminal', () => {
    expect(chooseFormat({ isTTY: false })).toEqual({ ok: true, format: 'json' });
  });

  it('defaults to columns on a terminal', () => {
    expect(chooseFormat({ isTTY: true })).toEqual({ ok: true, format: 'human' });
  });

  it('lets explicit flags beat the TTY check in both directions', () => {
    expect(chooseFormat({ isTTY: true, json: true }).format).toBe('json');
    expect(chooseFormat({ isTTY: false, human: true }).format).toBe('human');
  });

  it('refuses both flags at once', () => {
    expect(chooseFormat({ json: true, human: true }).ok).toBe(false);
  });
});

describe('truncateId', () => {
  it('shortens a uuid but keeps it recognisable', () => {
    expect(truncateId('11111111-2222-3333-4444-555555555555')).toBe('11111111…');
  });

  it('leaves short values and --full-ids alone', () => {
    expect(truncateId('short')).toBe('short');
    expect(truncateId('11111111-2222-3333-4444-555555555555', true))
      .toBe('11111111-2222-3333-4444-555555555555');
  });
});

describe('formatTimestamp', () => {
  it('renders an ISO timestamp as YYYY-MM-DD HH:mm', () => {
    expect(formatTimestamp('2026-07-29T09:05:00')).toBe('2026-07-29 09:05');
  });

  it('passes unparseable values through rather than printing Invalid Date', () => {
    expect(formatTimestamp('not a date')).toBe('not a date');
    expect(formatTimestamp('')).toBe('');
  });
});

describe('formatTable', () => {
  it('aligns columns to their widest cell', () => {
    const out = formatTable(
      [{ id: 'a', title: 'general' }, { id: 'bbbb', title: 'x' }],
      ['id', 'title'],
    );
    const [header, rule, first] = out.split('\n');
    expect(header).toBe('id    title');
    expect(rule).toBe('----  -------');
    expect(first).toBe('a     general');
  });

  it('says so when there is nothing to show', () => {
    expect(formatTable([], ['id'])).toBe('(none)');
  });

  it('renders booleans as words and objects as JSON', () => {
    const out = formatTable([{ ok: true, meta: { a: 1 } }], ['ok', 'meta']);
    expect(out).toContain('yes');
    expect(out).toContain('{"a":1}');
  });
});

describe('renderHuman', () => {
  it('turns { key: rows } into a table without knowing the tool', () => {
    const out = renderHuman({ channels: [{ id: 'c1', title: 'general' }] });
    expect(out).toContain('id');
    expect(out).toContain('general');
  });

  it('prints a scalar object as key: value lines', () => {
    expect(renderHuman({ kind: 'agent', handle: 'q' })).toBe('kind: agent\nhandle: q');
  });

  it('handles an empty result set', () => {
    expect(renderHuman({ channels: [] })).toBe('(none)');
  });
});
