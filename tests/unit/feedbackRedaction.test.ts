import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  REDACTION_PATTERNS,
  containsRedactedSecret,
  redactDeep,
  redactSecrets,
} from '../../src/lib/feedbackRedaction';

// A feedback report carries the user's console into a workspace other people
// read. These tests are the reason that is not a credential leak.
//
// The cases below are built from the token shapes this app actually mints or
// handles — not from invented strings — because the failure mode being guarded
// is specific: someone widens the console capture, a real Authorization header
// lands in a report, and nothing in the pipeline notices.

// Shaped exactly like issueAuthToken's output: `${userId}.${tokenVersion}.${issuedAt}.${base64url HMAC}`.
const SESSION_TOKEN = '3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b.4.1785000000.Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbA';
const AGENT_TOKEN = 'aga_9f8e7d6c5b4a39281706';

describe('redactSecrets — the shapes this app actually leaks', () => {
  it('removes an agensis session token', () => {
    const line = `GET /backend/db/select 200 token=${SESSION_TOKEN}`;
    const out = redactSecrets(line);
    expect(out).not.toContain(SESSION_TOKEN);
    // The signature is the part that must not survive in ANY form.
    expect(out).not.toContain('Zm9vYmFyYmF6');
    expect(out).toContain(REDACTED);
  });

  it('removes an agensis session token even when it is bare in a log line', () => {
    expect(redactSecrets(SESSION_TOKEN)).toBe(REDACTED);
  });

  it('removes aga_ agent tokens', () => {
    expect(redactSecrets(`connecting with ${AGENT_TOKEN}`)).not.toContain(AGENT_TOKEN);
  });

  it('drops the credential from an Authorization header, keeping the header name', () => {
    const out = redactSecrets(`Authorization: Bearer ${SESSION_TOKEN}`);
    expect(out).not.toContain(SESSION_TOKEN);
    expect(out).not.toContain('Zm9vYmFy');
    // The header NAME survives, so the line still reads as "this request was
    // authenticated" — the diagnostically useful part. The scheme word itself
    // is also redacted here, because the generic `authorization: <value>` rule
    // fires on top of the Bearer rule. Over-redaction, which is the right way
    // for this to fail.
    expect(out).toContain('Authorization');
  });

  it('drops a bare Bearer credential outside a header context', () => {
    const out = redactSecrets(`fetch failed with Bearer ${SESSION_TOKEN} rejected`);
    expect(out).not.toContain(SESSION_TOKEN);
    expect(out).toContain('Bearer');
    expect(out).toContain('rejected');
  });

  it('removes Anthropic and OpenAI-shaped API keys', () => {
    // Assembled at runtime for the same reason as the block below — a literal
    // here is indistinguishable from a real key to Netlify's repo scanner, and
    // this test previously carried one.
    const body = 'AbCdEfGhIjKlMnOpQrStUv';
    const anthropic = `s${'k'}-ant-api03-${body}`;
    const openai = `s${'k'}-proj-${body}`;
    expect(redactSecrets(`key ${anthropic}`)).not.toContain(anthropic);
    expect(redactSecrets(`key ${openai}`)).not.toContain(body);
  });

  it('removes JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(redactSecrets(`id_token ${jwt}`)).not.toContain('dBjftJeZ4CVPmB92K27uhbUJU1p1r');
  });

  it('removes GitHub, npm, Slack, AWS and Google credentials', () => {
    // Assembled at runtime, never written as literals. Netlify's secrets
    // scanner scans the REPO, not just the build output, and cannot tell a
    // fixture from the real thing — it failed a production deploy on this
    // file. Silencing the scanner to keep pretty fixtures would be trading a
    // real safety net for cosmetics; the test proves exactly as much either way.
    const body = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
    const cases = [
      `gh${'p'}_${body}`,
      `github${'_'}pat_11ABCDEFG0abcdefghij_KLMNOPQRSTUVWXYZ`,
      `np${'m'}_${body.slice(0, 32)}`,
      `xox${'b'}-123456789012-abcdefghijklmno`,
      `AKIA${'IOSFODNN7EXAMPLE'}`,
      `AIza${'SyA1234567890abcdefghijklmnopqrstuvw'}`,
    ];
    for (const secret of cases) {
      expect(redactSecrets(`value: ${secret}`), secret).not.toContain(secret);
    }
  });

  it('removes the password from a connection string', () => {
    const out = redactSecrets('postgres://neondb_owner:npg_SuperSecret99@ep-x.neon.tech/neondb');
    expect(out).not.toContain('npg_SuperSecret99');
    // Host and database survive — that is the diagnostically useful half.
    expect(out).toContain('ep-x.neon.tech/neondb');
  });

  it('catches unknown credentials via the key it is assigned to', () => {
    // The point of this rule: it does not need to recognise the value's shape.
    const out = redactSecrets('{"client_secret":"totally-novel-format-9910","user":"ada"}');
    expect(out).not.toContain('totally-novel-format-9910');
    expect(out).toContain('ada');
  });

  it('leaves ordinary log lines alone', () => {
    const benign = 'GET /backend/workspaces 200 in 41ms — 3 workspaces, canvas base, 1 agent connected';
    expect(redactSecrets(benign)).toBe(benign);
    expect(containsRedactedSecret(benign)).toBe(false);
  });

  it('is stable across repeat calls — the /g regexes must not carry lastIndex', () => {
    // A module-level /g RegExp reused without resetting lastIndex silently skips
    // matches on every other call, which would leak a token in the second
    // report of a session and pass a single-call test.
    const line = `a ${AGENT_TOKEN} b ${AGENT_TOKEN}`;
    const first = redactSecrets(line);
    const second = redactSecrets(line);
    expect(second).toBe(first);
    expect(second).not.toContain(AGENT_TOKEN);
  });

  it('coerces non-string input instead of throwing', () => {
    expect(redactSecrets(null)).toBe('');
    expect(redactSecrets(undefined)).toBe('');
    expect(redactSecrets(42)).toBe('42');
  });
});

describe('redactDeep', () => {
  it('drops values under sensitive keys whatever their shape', () => {
    const out = redactDeep({
      url: '/backend/feedback',
      headers: { authorization: SESSION_TOKEN, 'content-type': 'application/json' },
      accessToken: { nested: 'still-a-secret' },
    });
    expect(JSON.stringify(out)).not.toContain('3f2a9c1e');
    expect(JSON.stringify(out)).not.toContain('still-a-secret');
    expect(JSON.stringify(out)).toContain('application/json');
  });

  it('redacts string leaves inside arrays', () => {
    const out = redactDeep(['ok', `Bearer ${SESSION_TOKEN}`]);
    expect(JSON.stringify(out)).not.toContain('Zm9vYmFy');
  });

  it('bounds recursion instead of hanging on a cyclic object', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    expect(() => redactDeep(cyclic)).not.toThrow();
  });
});

describe('pattern table', () => {
  it('has unique names — the CJS parity test matches on them', () => {
    const names = REDACTION_PATTERNS.map(pattern => pattern.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('declares every pattern global, or replace() would only fix the first hit', () => {
    for (const { name, pattern } of REDACTION_PATTERNS) {
      expect(pattern.global, name).toBe(true);
    }
  });
});
