// ============================================================================
// tests/unit/auditEntry.test.ts
// ----------------------------------------------------------------------------
// The audit panel's formatting rules. MUST live under tests/unit/**/*.test.ts —
// vitest.config.ts includes only that glob, and a test anywhere else silently
// never runs (this repo has been bitten by exactly that, twice).
//
// Pure functions only: src/lib/auditEntry.ts holds every rendering decision
// precisely so it can be checked without mounting a component.
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  AUDIT_EMPTY_STATE,
  AUDIT_TRUST_NOTE,
  auditActionLabel,
  formatActor,
  formatAuditTime,
  formatChange,
  formatDetail,
  formatTarget,
  isEscalation,
  isUnrestrictedShellGrant,
} from '../../src/lib/auditEntry';

describe('auditActionLabel', () => {
  it('names every action the log records', () => {
    expect(auditActionLabel('agent.permission_mode_changed')).toBe('Agent permission mode changed');
    expect(auditActionLabel('vault.secret_set')).toBe('Vault secret set');
    expect(auditActionLabel('member.removed')).toBe('Member removed');
  });

  it('falls back to the raw action rather than rendering nothing', () => {
    // A row recorded as 'unknown' (a typo caught in production) must still be
    // visible — showing an empty cell would hide the very thing worth noticing.
    expect(auditActionLabel('unknown')).toBe('Unrecognised action');
    expect(auditActionLabel('some.future_action')).toBe('some.future_action');
  });
});

describe('formatChange', () => {
  it('renders both sides when both exist', () => {
    expect(formatChange({ before_value: 'editor', after_value: 'admin' })).toBe('editor to admin');
  });

  it('renders one side alone rather than a dangling arrow', () => {
    // A removal has no after; a grant has no before. Printing 'editor to ' or
    // ' to admin' reads as a bug.
    expect(formatChange({ before_value: 'editor', after_value: '' })).toBe('editor');
    expect(formatChange({ before_value: '', after_value: 'admin' })).toBe('admin');
    expect(formatChange({ before_value: '', after_value: '' })).toBe('');
  });
});

describe('isEscalation', () => {
  it('marks a promotion but not a demotion', () => {
    // Marking a demotion as an escalation would train people to ignore the
    // marker, which costs more than not having it.
    expect(isEscalation({ action: 'member.role_changed', before_value: 'viewer', after_value: 'admin' })).toBe(true);
    expect(isEscalation({ action: 'member.role_changed', before_value: 'admin', after_value: 'viewer' })).toBe(false);
    expect(isEscalation({ action: 'member.role_changed', before_value: 'editor', after_value: 'editor' })).toBe(false);
  });

  it('marks a widening of permission mode but not a narrowing', () => {
    expect(isEscalation({ action: 'agent.permission_mode_changed', before_value: 'default', after_value: 'yolo' })).toBe(true);
    expect(isEscalation({ action: 'agent.permission_mode_changed', before_value: 'yolo', after_value: 'default' })).toBe(false);
  });

  it('marks grants and token mints unconditionally', () => {
    expect(isEscalation({ action: 'agent.permission_rule_granted', before_value: '', after_value: 'Bash(git clone:*)' })).toBe(true);
    expect(isEscalation({ action: 'agent.connect_token_minted', before_value: 'default', after_value: 'default' })).toBe(true);
  });

  it('does not mark removals or revocations', () => {
    expect(isEscalation({ action: 'member.removed', before_value: 'editor', after_value: '' })).toBe(false);
    expect(isEscalation({ action: 'agent.permission_rule_revoked', before_value: 'Bash(rm:*)', after_value: '' })).toBe(false);
    expect(isEscalation({ action: 'vault.secret_deleted', before_value: 'configured', after_value: '' })).toBe(false);
  });

  it('treats an unrecognised role or mode as an escalation, not as safe', () => {
    // Failing closed: an unfamiliar value must not read as "nothing happened".
    expect(isEscalation({ action: 'member.role_changed', before_value: '', after_value: 'superadmin' })).toBe(true);
  });
});

describe('isUnrestrictedShellGrant', () => {
  it('calls out yolo specifically', () => {
    // 'yolo' is unrestricted shell on whatever machine the daemon runs on.
    expect(isUnrestrictedShellGrant({ action: 'agent.permission_mode_changed', after_value: 'yolo' })).toBe(true);
    expect(isUnrestrictedShellGrant({ action: 'agent.connect_token_minted', after_value: 'yolo' })).toBe(true);
    expect(isUnrestrictedShellGrant({ action: 'agent.permission_mode_changed', after_value: 'accept_edits' })).toBe(false);
    expect(isUnrestrictedShellGrant({ action: 'member.role_changed', after_value: 'yolo' })).toBe(false);
  });
});

describe('formatActor', () => {
  const base = { actor_label: '', actor_user_id: null, actor_agent_id: null };

  it('prefers the label the server captured', () => {
    expect(formatActor({ ...base, actor_label: 'Jason', actor_user_id: 'u-123456789' })).toBe('Jason');
  });

  it('resolves a user id through the caller when it can', () => {
    expect(formatActor(
      { ...base, actor_user_id: 'u-123456789' },
      id => (id === 'u-123456789' ? 'jason@example.com' : undefined),
    )).toBe('jason@example.com');
  });

  it('shortens an unresolved id rather than showing a bare uuid', () => {
    expect(formatActor({ ...base, actor_user_id: '0f8c1e22-aaaa-bbbb' })).toBe('User 0f8c1e22');
    expect(formatActor({ ...base, actor_agent_id: '9a7b6c55-dddd' })).toBe('Agent 9a7b6c55');
  });

  it('says Unattributed rather than rendering blank', () => {
    // An unattributed row is a real property (an unauthenticated claim path
    // whose key-minter is unknown), not a rendering failure. Blank would read
    // as the latter.
    expect(formatActor(base)).toBe('Unattributed');
  });
});

describe('formatTarget', () => {
  it('prefers the label captured at the time', () => {
    expect(formatTarget({ target_label: 'scout', target_id: 'a-1', target_type: 'agent' })).toBe('scout');
  });

  it('truncates a long bare id and falls back to the type', () => {
    expect(formatTarget({ target_label: '', target_id: '0f8c1e2233445566', target_type: 'agent' })).toBe('0f8c1e22...');
    expect(formatTarget({ target_label: '', target_id: 'short', target_type: 'agent' })).toBe('short');
    expect(formatTarget({ target_label: '', target_id: null, target_type: 'agent' })).toBe('agent');
  });
});

describe('formatDetail', () => {
  it('shows only allowlisted keys', () => {
    expect(formatDetail({ key: 'STRIPE_KEY', lane: 'shared' })).toBe('Key: STRIPE_KEY · Lane: shared');
    expect(formatDetail({ email_domain: 'partner.com' })).toBe('Domain: partner.com');
  });

  it('drops any key nobody has vetted', () => {
    // An allowlist, not a filter: a `detail` key added by a future writer must
    // not reach the screen just because it exists. Adding it here is the moment
    // to decide it carries nothing sensitive.
    expect(formatDetail({ key: 'K', unvetted_field: 'surprise', token: 'aga_secret' }))
      .toBe('Key: K');
  });

  it('never renders a nested object', () => {
    expect(formatDetail({ key: 'K', nested: { secret: 'x' } })).toBe('Key: K');
  });

  it('handles a missing or non-object detail', () => {
    expect(formatDetail(null)).toBe('');
    expect(formatDetail({})).toBe('');
  });
});

describe('formatAuditTime', () => {
  it('renders a compact absolute timestamp, not a relative one', () => {
    // Audit reading is forensic. '2 hours ago' is not an answer to "when".
    // Same-year rows drop the year to keep the Time column short.
    const sameYear = formatAuditTime('2026-07-29T10:30:05.000Z', 'en-GB', Date.parse('2026-08-02T12:00:00.000Z'));
    expect(sameYear).toMatch(/Jul/);
    expect(sameYear).toMatch(/29/);
    expect(sameYear).not.toMatch(/2026/);
    expect(sameYear).not.toMatch(/ago/);
    // Seconds are noise in a dense table.
    expect(sameYear).not.toMatch(/:05/);

    const olderYear = formatAuditTime('2025-07-29T10:30:05.000Z', 'en-GB', Date.parse('2026-08-02T12:00:00.000Z'));
    expect(olderYear).toMatch(/25|2025/);
  });

  it('returns empty for an unparseable timestamp instead of Invalid Date', () => {
    expect(formatAuditTime('not-a-date')).toBe('');
  });
});

describe('the panel copy', () => {
  it('says the log was not backfilled', () => {
    // Without this, empty reads as "no privileged actions have ever happened",
    // which is the opposite of true — the actions left no trace to backfill.
    expect(AUDIT_EMPTY_STATE).toMatch(/not backfilled/i);
  });

  it('claims tamper-evident and explicitly not tamper-proof', () => {
    // The risk most likely to bite is social: shipping something called an audit
    // log invites the assumption that it is tamper-proof.
    expect(AUDIT_TRUST_NOTE).toMatch(/tamper-evident, not/i);
    expect(AUDIT_TRUST_NOTE).toMatch(/direct database access/i);
  });

  it('uses no emoji anywhere in the panel copy', () => {
    const emoji = /\p{Extended_Pictographic}/u;
    expect(emoji.test(AUDIT_EMPTY_STATE)).toBe(false);
    expect(emoji.test(AUDIT_TRUST_NOTE)).toBe(false);
  });
});
