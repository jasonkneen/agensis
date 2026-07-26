import { describe, expect, it } from 'vitest';
import {
  describeSkillSource,
  describeSkillUnavailable,
  formatSkillBytes,
  parseSkillContent,
  type SkillContentAvailable,
} from '../../src/lib/skillContent';

// The pane's whole contract: show the real text, or say plainly that there is
// none and why. These pin the "or" half — a wrong or vague empty state sends
// somebody debugging their daemon when nothing is wrong with it.

describe('parseSkillContent', () => {
  it('reads an available document', () => {
    const result = parseSkillContent({
      available: true,
      source: 'daemon',
      markdown: '# Deploy targets',
      path: '/home/j/.claude/skills/deploy-targets/SKILL.md',
      byteSize: 120,
      truncated: false,
      agentName: 'Coder',
    });
    expect(result.available).toBe(true);
    const available = result as SkillContentAvailable;
    expect(available.source).toBe('daemon');
    expect(available.markdown).toBe('# Deploy targets');
    expect(available.agentName).toBe('Coder');
  });

  it('keeps the reason for an unavailable document', () => {
    const result = parseSkillContent({ available: false, reason: 'not-synced' });
    expect(result).toEqual({ available: false, reason: 'not-synced', path: '' });
  });

  it('collapses an unrecognised reason rather than rendering it', () => {
    // The response is untrusted. A reason the client does not know how to
    // phrase must not reach the screen as a raw server string.
    const result = parseSkillContent({ available: false, reason: 'because I said so' });
    expect(result).toEqual({ available: false, reason: 'not-found', path: '' });
  });

  it('treats a missing payload as a failed request, not an empty skill', () => {
    // "The backend never answered" and "this skill has no body" have different
    // fixes; this build of the app can easily be newer than the backend.
    expect(parseSkillContent(null)).toEqual({ available: false, reason: 'request-failed' });
    expect(parseSkillContent('nonsense')).toEqual({ available: false, reason: 'request-failed' });
  });

  it('never trusts a markdown field that is not a string', () => {
    const result = parseSkillContent({ available: true, source: 'host', markdown: { toString: () => 'x' } });
    expect((result as SkillContentAvailable).markdown).toBe('');
  });
});

describe('describeSkillUnavailable', () => {
  it('says the file is on the machine when a daemon only sent the name', () => {
    const { title, detail } = describeSkillUnavailable('not-synced', { name: 'browse' });
    expect(title).toMatch(/on the machine/i);
    expect(detail).toContain('browse');
    // The user has nothing to fix — say so, or they will go looking.
    expect(detail).toMatch(/nothing is missing on your side/i);
  });

  it('names the env var for a host read that is switched off', () => {
    expect(describeSkillUnavailable('host-fs-disabled').detail).toContain('AGENSIS_ALLOW_PROJECT_FS');
  });

  it('has distinct wording for every reason', () => {
    const reasons = ['not-synced', 'host-fs-disabled', 'not-found', 'unreadable', 'request-failed'] as const;
    const titles = reasons.map(r => describeSkillUnavailable(r).title);
    expect(new Set(titles).size).toBe(reasons.length);
  });

  it('reads without a skill name', () => {
    const { detail } = describeSkillUnavailable('not-found');
    expect(detail).not.toContain('“”');
    expect(detail).toContain('this skill');
  });
});

describe('describeSkillSource', () => {
  const base = { available: true, markdown: '', path: '', byteSize: 0, truncated: false } as const;

  it('names the machine a mirrored body came from', () => {
    expect(describeSkillSource({ ...base, source: 'daemon', agentName: 'Coder' })).toContain('Coder');
  });

  it('falls back when the agent is unnamed', () => {
    expect(describeSkillSource({ ...base, source: 'daemon' })).toMatch(/the machine that has this skill/);
  });

  it('says a sandbox document is the agent\'s own text', () => {
    // It is renderSkillBlock verbatim, so the claim is literally true and worth
    // making — it tells a reader they are looking at the agent's instructions,
    // not a summary of them.
    expect(describeSkillSource({ ...base, source: 'sandbox' })).toMatch(/exact text the agent is given/);
  });

  it('says a host file came from the backend host, not a daemon', () => {
    expect(describeSkillSource({ ...base, source: 'host' })).toMatch(/agensis backend/);
  });
});

describe('formatSkillBytes', () => {
  it('formats small and large sizes', () => {
    expect(formatSkillBytes(512)).toBe('512 B');
    expect(formatSkillBytes(2048)).toBe('2.0 KB');
    expect(formatSkillBytes(65536)).toBe('64 KB');
  });

  it('renders nothing for an unknown size', () => {
    expect(formatSkillBytes(0)).toBe('');
    expect(formatSkillBytes(Number.NaN)).toBe('');
  });
});
