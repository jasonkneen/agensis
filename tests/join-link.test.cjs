// ============================================================================
// tests/join-link.test.cjs
// ----------------------------------------------------------------------------
// The ONE join URL: short-lived, single-use, with explicit human,
// Connector-agent, and workspace-controller lanes, and never a place a
// long-lived credential is
// displayed. Controller-specific authority is pinned in the workspace-controller
// suites; this file exercises the shared individual-link contract.
//
// This is a credential-issuing surface reachable with no authentication beyond
// the URL, so these run against a REAL express app over a REAL socket with a
// fake database underneath — not by reading source. Status codes, response
// bodies and headers are what an attacker sees, so they are what is asserted.
//
// The fake DB models the redeeming UPDATE's WHERE clause faithfully (status,
// expiry, audience, grant kind) rather than stubbing a happy path, because
// "redeems exactly once" IS that predicate. A mock that always returns a row would pass a suite
// that proves nothing.
//
// Four properties are load-bearing and each has a test that would fail if the
// property were removed:
//
//   1. Single use          — the second redemption fails, including your own.
//   2. Expiry              — a link past expires_at is refused.
//   3. No oracle           — unknown, malformed, expired, revoked, spent and
//                            wrong-audience are byte-identical, same status.
//   4. No leak             — the join token appears in no response body, no
//                            activity row, and no console line; the AGENT
//                            token appears exactly once, in the one field that
//                            exists to deliver it.
//
// Plus the two audience requirements: the HTML carries the machine-readable
// block, and Accept: application/json returns the structured form — with the
// extra condition that NEITHER may depend on User-Agent.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const { createApp, __test } = require('../server/index.cjs');
const joinPage = require('../server/join-page.cjs');

const WORKSPACE = '11111111-2222-4333-8444-555555555555';
const LINK_ID = '99999999-8888-4777-8666-555555555555';
const USER = 'user-1';
const AGENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

// ---------------------------------------------------------------------------
// A fake database that enforces the redeeming predicate for real.
// ---------------------------------------------------------------------------

// Apply ONLY the predicates the statement actually carries.
//
// This is the difference between a test and a decoration. The first version of
// this mock enforced status/expiry/audience unconditionally, so deleting
// `and status = 'pending'` from the real UPDATE left all 19 tests green — the
// suite was measuring the mock. Deriving each condition from the SQL text means
// removing a guard in server/index.cjs removes it here too, and the
// single-use / expiry / audience tests go red as they should.
function matchesGuards(normalizedSql, row, lane) {
  if (normalizedSql.includes("status = 'pending'") && row.status !== 'pending') return false;
  if (normalizedSql.includes('expires_at > now()') && new Date(row.expires_at).getTime() <= Date.now()) return false;
  if (normalizedSql.includes("audience in ('both', $2)")
    && !(row.audience === 'both' || row.audience === lane)) return false;
  return true;
}

function makeDb({ link = null, workspaceName = 'Acme', existingAgents = [] } = {}) {
  const calls = [];
  const activity = [];
  const agents = [];
  const state = { link: link ? { ...link } : null };

  const db = {
    calls,
    activity,
    agents,
    state,
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      calls.push({ sql: String(sql), normalized: n, params });

      // Boot noise: the schema bootstrap, its backfills, and the flows fanout
      // that every notifyDbSubscribers triggers. None of it is under test, and
      // letting it throw only fills the output with red herrings.
      if (n.startsWith('alter table') || n.startsWith('create table') || n.startsWith('create index')
        || n.startsWith('create extension') || n.startsWith('do $$')
        || n.startsWith('delete from rate_limits') || n.startsWith('delete from activity_events')
        || n.startsWith('delete from agent_jobs') || n.startsWith('insert into app_settings')
        || n.startsWith('select id, workspace_id, channel_id, events from flow_connections')) {
        return [];
      }
      if (n.startsWith('select value from app_settings')) {
        return params[0] === 'AUTH_SECRET' ? [{ value: 'join-link-test-secret' }] : [];
      }
      if (n.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
      if (n.startsWith('insert into rate_limits')) return [{ count: 1 }];

      // --- the display read -------------------------------------------------
      if (n.includes('from workspace_join_links l')) {
        const row = state.link;
        if (!row) return [];
        const live = row.token_hash === params[0]
          && matchesGuards(n, row, null);
        if (!live) return [];
        return [{
          id: row.id,
          workspace_id: row.workspace_id,
          role: row.role,
          label: row.label,
          audience: row.audience,
          expires_at: row.expires_at,
          workspace_name: workspaceName,
        }];
      }

      // --- THE guard: the conditional UPDATE that is the single-use rule -----
      if (n.startsWith('update workspace_join_links set status = \'redeemed\'')) {
        const [tokenHash, lane, userId] = params;
        const row = state.link;
        if (!row) return [];
        const matches = row.token_hash === tokenHash && matchesGuards(n, row, lane);
        if (!matches) return [];
        row.status = 'redeemed';
        row.redeemed_as = lane;
        row.redeemed_by = userId || null;
        row.redeemed_at = new Date();
        return [{ ...row }];
      }
      if (n.startsWith('update workspace_join_links set redeemed_agent_id')) {
        if (state.link) state.link.redeemed_agent_id = params[1];
        return [];
      }

      if (n.startsWith('select id, name from workspaces where id = $1')) {
        return [{ id: params[0], name: workspaceName }];
      }
      if (n.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) return [];
      if (n.startsWith('select id from workspace_members')) return [];
      if (n.startsWith('insert into workspace_members')) {
        return [{ id: 'member-1', workspace_id: params[0], user_id: params[1], role: params[2] }];
      }

      if (n.startsWith('select handle, name from workspace_agents')) {
        return existingAgents.map(handle => ({ handle, name: handle }));
      }
      if (n.startsWith('insert into workspace_agents')) {
        const row = {
          id: AGENT_ID,
          workspace_id: params[0],
          name: params[1],
          handle: params[2],
          description: params[3],
          connect_token_hash: params[4],
          metadata: params[5],
          created_by: params[6],
        };
        agents.push(row);
        return [row];
      }

      if (n.startsWith('insert into activity_events')) {
        const row = {
          workspace_id: params[0],
          user_id: params[1],
          event_type: params[2],
          entity_id: params[3],
          title: params[4],
          metadata: params[5],
        };
        activity.push(row);
        return [row];
      }

      throw new Error(`Unexpected SQL in join-link test: ${n.slice(0, 140)}`);
    },
  };

  const snapshot = () => ({
    link: state.link ? { ...state.link } : null,
    activity: activity.map(row => ({ ...row })),
    agents: agents.map(row => ({ ...row })),
  });
  const restore = saved => {
    state.link = saved.link;
    activity.splice(0, activity.length, ...saved.activity);
    agents.splice(0, agents.length, ...saved.agents);
  };
  const transaction = { unsafe: db.unsafe.bind(db) };
  transaction.savepoint = async callback => {
    const saved = snapshot();
    try {
      return await callback(transaction);
    } catch (error) {
      restore(saved);
      throw error;
    }
  };
  db.begin = async callback => {
    const saved = snapshot();
    try {
      return await callback(transaction);
    } catch (error) {
      restore(saved);
      throw error;
    }
  };
  return db;
}

function liveLink(overrides = {}) {
  return {
    id: LINK_ID,
    workspace_id: WORKSPACE,
    token_hash: '',
    label: 'Backend agent',
    role: 'editor',
    audience: 'both',
    status: 'pending',
    redeemed_as: '',
    redeemed_by: null,
    redeemed_agent_id: null,
    redeemed_at: null,
    expires_at: new Date(Date.now() + 10 * 60_000),
    created_by: USER,
    ...overrides,
  };
}

async function withServer(fn) {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

// Capture everything the process writes to the console for the duration of a
// call. "Never log the token" is only checkable by actually watching the logs.
async function captureConsole(fn) {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const name of Object.keys(originals)) {
    console[name] = (...args) => { lines.push(args.map(String).join(' ')); };
  }
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, originals);
  }
}

test.beforeEach(() => {
  __test.resetTestState();
  // The redeem budget is 10/min per IP and every case here shares 127.0.0.1.
  __test.joinLinkRateLimiter.reset();
  __test.joinRedeemRateLimiter.reset();
});

// ---------------------------------------------------------------------------
// 1. Redemption happens exactly once
// ---------------------------------------------------------------------------

test('an agent redeems a join link exactly once; the second attempt is refused', async () => {
  const token = __test.createJoinLinkToken();
  const db = makeDb({ link: liveLink({ token_hash: sha256(token) }) });
  __test.setTestDb(db);

  await withServer(async (base) => {
    const url = `${base}/backend/join/${token}/redeem`;
    const first = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ as: 'agent', name: 'Backend Agent', handle: 'backend' }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.data.as, 'agent');
    assert.match(firstBody.data.credential.token, /^aga_/);
    assert.equal(db.agents.length, 1);

    // Same caller, same link, immediately. Single-use means single-use.
    const second = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ as: 'agent', name: 'Backend Agent', handle: 'backend' }),
    });
    assert.equal(second.status, 410);
    const secondBody = await second.json();
    assert.equal(secondBody.data, null);
    assert.equal(secondBody.error.code, 'join_link_invalid');
    // Nothing was provisioned the second time round.
    assert.equal(db.agents.length, 1);
  });
});

test('a joining agent does not silently take an existing @handle', async () => {
  // workspace_agents indexes (workspace_id, handle) but does not constrain it,
  // so a collision does not throw — it creates a second @backend and every
  // mention of it becomes ambiguous. Self-service joining is where that happens:
  // whoever holds the URL picks their own name, with nobody looking.
  const token = __test.createJoinLinkToken();
  const db = makeDb({
    link: liveLink({ token_hash: sha256(token) }),
    existingAgents: ['backend', 'backend-2'],
  });
  __test.setTestDb(db);

  await withServer(async (base) => {
    const res = await fetch(`${base}/backend/join/${token}/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ as: 'agent', name: 'Backend', handle: 'backend' }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.agent.handle, 'backend-3');
  });
});

test('a human redeems with their own session and gets NO credential back', async () => {
  const token = __test.createJoinLinkToken();
  const db = makeDb({ link: liveLink({ token_hash: sha256(token) }) });
  __test.setTestDb(db);

  await withServer(async (base) => {
    const session = await __test.issueToken(USER, '1');
    const res = await fetch(`${base}/backend/join/${token}/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
      body: JSON.stringify({ as: 'human' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.as, 'human');
    // ABSENT, not empty. A human's access is their own sign-in; there is
    // nothing here for anyone to copy out of the page or the response.
    assert.equal('credential' in body.data, false);
    assert.equal(db.agents.length, 0, 'the human lane must not provision an agent');
    assert.equal(db.state.link.redeemed_as, 'human');
    assert.equal(db.state.link.redeemed_by, USER);
  });
});

test('an invalid presented session is refused without provisioning or consuming the link', async () => {
  const token = __test.createJoinLinkToken();
  const db = makeDb({ link: liveLink({ token_hash: sha256(token) }) });
  __test.setTestDb(db);

  await withServer(async (base) => {
    const res = await fetch(`${base}/backend/join/${token}/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer expired-session' },
      body: JSON.stringify({ as: 'human' }),
    });
    assert.equal(res.status, 401);
    assert.equal(db.agents.length, 0, 'an invalid human session must not provision an agent');
    assert.equal(db.state.link.status, 'pending', 'authentication failure must not consume the link');
    assert.equal(db.state.link.redeemed_as, '');
  });
});

test('missing or contradictory redemption intent is refused before the link is consumed', async () => {
  const token = __test.createJoinLinkToken();
  const db = makeDb({ link: liveLink({ token_hash: sha256(token) }) });
  __test.setTestDb(db);

  await withServer(async (base) => {
    const missing = await fetch(`${base}/backend/join/${token}/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ambiguous caller' }),
    });
    assert.equal(missing.status, 400);

    const session = await __test.issueToken(USER, '1');
    const contradictory = await fetch(`${base}/backend/join/${token}/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
      body: JSON.stringify({ as: 'agent', name: 'Ambient browser agent' }),
    });
    assert.equal(contradictory.status, 400);
    assert.equal(db.agents.length, 0);
    assert.equal(db.state.link.status, 'pending');
  });
});

// ---------------------------------------------------------------------------
// 2. Expiry
// ---------------------------------------------------------------------------

test('an expired join link is refused', async () => {
  const token = __test.createJoinLinkToken();
  const db = makeDb({
    link: liveLink({ token_hash: sha256(token), expires_at: new Date(Date.now() - 1000) }),
  });
  __test.setTestDb(db);

  await withServer(async (base) => {
    const res = await fetch(`${base}/backend/join/${token}/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ as: 'agent', name: 'Too Late' }),
    });
    assert.equal(res.status, 410);
    assert.equal(db.agents.length, 0);
    assert.equal(db.state.link.status, 'pending', 'an expired link must not be marked redeemed');
  });
});

test('the default TTL is fifteen minutes and the override is clamped', async () => {
  assert.equal(__test.JOIN_LINK_DEFAULT_TTL_MS, 15 * 60_000);
  assert.equal(__test.joinLinkTtlMs(), 15 * 60_000);

  // withEnv is async (it asserts the pin held on both sides), so each call has
  // to be awaited or the three overlap and the last one wins.
  const { withEnv } = require('./helpers/test-env.cjs');
  // Below the floor and above the ceiling both clamp rather than being honoured:
  // a one-second link fails honest users, and a link outliving a day is not
  // short-lived in any sense that matters to the threat it exists to bound.
  await withEnv('AGENSIS_JOIN_LINK_TTL_MS', '1000', () => {
    assert.equal(__test.joinLinkTtlMs(), 60_000);
  });
  await withEnv('AGENSIS_JOIN_LINK_TTL_MS', String(90 * 24 * 60 * 60_000), () => {
    assert.equal(__test.joinLinkTtlMs(), 24 * 60 * 60_000);
  });
  await withEnv('AGENSIS_JOIN_LINK_TTL_MS', 'nonsense', () => {
    assert.equal(__test.joinLinkTtlMs(), 15 * 60_000);
  });
});

// ---------------------------------------------------------------------------
// 3. No oracle: every failure looks identical
// ---------------------------------------------------------------------------

test('unknown, malformed, expired, revoked and spent links are indistinguishable', async () => {
  const known = __test.createJoinLinkToken();

  // Each scenario, redeemed, produces (status, body). All must be equal.
  const scenarios = {
    unknown: () => ({ token: __test.createJoinLinkToken(), link: null }),
    expired: () => ({ token: known, link: liveLink({ token_hash: sha256(known), expires_at: new Date(Date.now() - 1) }) }),
    revoked: () => ({ token: known, link: liveLink({ token_hash: sha256(known), status: 'revoked' }) }),
    spent: () => ({ token: known, link: liveLink({ token_hash: sha256(known), status: 'redeemed' }) }),
    // A shape that cannot be a token at all — refused before the DB is touched,
    // and it must not be refused DIFFERENTLY for being cheap to refuse.
    malformed: () => ({ token: 'agj_short', link: null }),
    // Not a join token at all.
    foreign: () => ({ token: 'aga_someoneElsesAgentTokenValueHereThatIsLongEnough', link: null }),
    // An agent-only link redeemed by the human lane leaks nothing either: the
    // audience predicate is inside the same UPDATE, so a wrong-lane caller gets
    // the identical refusal rather than "this link exists but not for you".
    wrongAudience: () => ({ token: known, link: liveLink({ token_hash: sha256(known), audience: 'human' }) }),
  };

  const seen = {};
  for (const [name, build] of Object.entries(scenarios)) {
    const { token, link } = build();
    __test.resetTestState();
    __test.joinRedeemRateLimiter.reset();
    __test.setTestDb(makeDb({ link }));
    seen[name] = await withServer(async (base) => {
      const res = await fetch(`${base}/backend/join/${token}/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ as: 'agent', name: 'Prober' }),
      });
      return { status: res.status, body: await res.text() };
    });
  }

  const reference = seen.unknown;
  assert.equal(reference.status, 410);
  for (const [name, observed] of Object.entries(seen)) {
    assert.equal(observed.status, reference.status, `${name}: status differs from an unknown link`);
    assert.equal(observed.body, reference.body, `${name}: body differs from an unknown link`);
  }
});

test('the page refuses an unknown and an expired link identically, at the same status', async () => {
  const known = __test.createJoinLinkToken();
  const cases = {
    unknown: null,
    expired: liveLink({ token_hash: sha256(known), expires_at: new Date(Date.now() - 1) }),
    revoked: liveLink({ token_hash: sha256(known), status: 'revoked' }),
  };

  const seen = {};
  // ONE server for all three, swapping the database underneath: the page embeds
  // its own origin, so three servers on three ports would differ by port alone
  // and the comparison would be meaningless.
  __test.setTestDb(makeDb({ link: null }));
  await withServer(async (base) => {
    for (const [name, link] of Object.entries(cases)) {
      __test.setTestDb(makeDb({ link }));
      __test.joinLinkRateLimiter.reset();
      const res = await fetch(`${base}/backend/join/${known}`, { headers: { Accept: 'text/html' } });
      seen[name] = { status: res.status, body: await res.text() };
    }
  });
  for (const [name, observed] of Object.entries(seen)) {
    assert.equal(observed.status, 410, `${name}: an invalid link must be 410`);
    assert.equal(observed.body, seen.unknown.body, `${name}: page differs from an unknown link`);
    // The refusal page must not name the workspace — that alone would confirm
    // the link once existed and which workspace it belonged to.
    assert.ok(!observed.body.includes('Acme'), `${name}: the refusal page names the workspace`);
  }
});

// ---------------------------------------------------------------------------
// 4. The token never leaks
// ---------------------------------------------------------------------------

test('the join token appears in no response body, no activity row and no log line', async () => {
  const token = __test.createJoinLinkToken();
  const db = makeDb({ link: liveLink({ token_hash: sha256(token) }) });
  __test.setTestDb(db);

  const { result, lines } = await captureConsole(() => withServer(async (base) => {
    const page = await fetch(`${base}/backend/join/${token}`, { headers: { Accept: 'text/html' } });
    const pageBody = await page.text();
    const json = await fetch(`${base}/backend/join/${token}`, { headers: { Accept: 'application/json' } });
    const jsonBody = await json.text();
    const redeem = await fetch(`${base}/backend/join/${token}/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ as: 'agent', name: 'Backend Agent' }),
    });
    const redeemBody = await redeem.text();
    return { pageBody, jsonBody, redeemBody };
  }));

  // The PAGE and the JSON legitimately contain the token: it is in the URL the
  // caller already holds, and the redeem_url has to be spellable. What must
  // never happen is it turning up in the REDEEM response, where the long-lived
  // credential is, or anywhere the caller does not already control.
  assert.ok(!result.redeemBody.includes(token), 'the join token must not come back in the redemption response');

  for (const row of db.activity) {
    const serialized = JSON.stringify(row);
    assert.ok(!serialized.includes(token), 'the join token must never reach an activity row');
    // The link is identified by its database id, which grants nothing.
    if (row.event_type === 'join_link_redeemed') {
      assert.equal(row.metadata.join_link_id, LINK_ID);
    }
  }

  for (const line of lines) {
    assert.ok(!line.includes(token), `the join token reached a log line: ${line.slice(0, 120)}`);
  }

  // Nor may the token be handed to Postgres in the clear: only its hash is ever
  // bound, so a query log or a slow-query capture cannot resurrect it.
  for (const call of db.calls) {
    for (const param of call.params || []) {
      assert.ok(String(param) !== token, `the raw join token was bound to SQL: ${call.normalized.slice(0, 80)}`);
    }
  }
});

test('the agent credential appears exactly once in the redemption response', async () => {
  const token = __test.createJoinLinkToken();
  __test.setTestDb(makeDb({ link: liveLink({ token_hash: sha256(token) }) }));

  await withServer(async (base) => {
    const res = await fetch(`${base}/backend/join/${token}/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ as: 'agent', name: 'Backend Agent' }),
    });
    const text = await res.text();
    const body = JSON.parse(text);
    const agentToken = body.data.credential.token;

    // One occurrence, in one field. This is the property that makes the whole
    // response auditable: there is no second, more convenient string that also
    // happens to contain the secret — which is exactly how the original leak
    // happened (a `claude mcp add ...` one-liner beside a masked token field).
    const occurrences = text.split(agentToken).length - 1;
    assert.equal(occurrences, 1, 'the agent token must appear in exactly one field');

    // And the config block, which an agent is told to write to disk, ships the
    // PLACEHOLDER — the same rule server/skills.cjs follows.
    const config = JSON.stringify(body.data.mcp.config);
    assert.ok(config.includes('aga_YOUR_AGENT_TOKEN'), 'the config template must use the placeholder');
    assert.ok(!config.includes(agentToken), 'the config template must not embed the live token');
  });
});

test('a join link is not a bearer token anywhere in the auth chain', () => {
  const source = require('./helpers/fly-lane.cjs').flyLaneSource();

  // verifyMcpToken is the chain an MCP client's Authorization header runs
  // through. Neither the secure join link nor the legacy human invite is an MCP
  // credential; individual agents receive their own aga_ token only after the
  // secure join redemption endpoint provisions them.
  const at = source.indexOf('async function verifyMcpToken');
  assert.ok(at > 0, 'verifyMcpToken must still exist');
  const chain = codeOnly(source.slice(at, source.indexOf('\n}', at)));
  assert.ok(!/join/i.test(chain), `a join link must not be accepted as an MCP bearer:\n${chain}`);
  assert.ok(!/invite/i.test(chain), `a legacy human invite must not be accepted as an MCP bearer:\n${chain}`);
  assert.ok(!/function verifyInviteToken/.test(source), 'the retired invite verifier must not remain available for accidental reuse');

  // And no verify* function may read the table at all. Only the two dedicated
  // join routes touch it, plus the manage-role mint/list/revoke routes.
  const verifiers = source.split(/\n(?=(?:async )?function verify)/).filter(part => /^(?:async )?function verify/.test(part));
  assert.ok(verifiers.length >= 4, 'the verify* functions must still be findable');
  for (const fn of verifiers) {
    const name = (fn.match(/function (\w+)/) || [])[1];
    assert.ok(
      !/workspace_join_links/.test(fn.slice(0, fn.indexOf('\n}'))),
      `${name} must not authenticate anything against workspace_join_links`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. Two audiences, one URL, no User-Agent sniffing
// ---------------------------------------------------------------------------

test('the HTML page carries the machine-readable block, the JSON-LD and the prose', async () => {
  const token = __test.createJoinLinkToken();
  __test.setTestDb(makeDb({ link: liveLink({ token_hash: sha256(token) }) }));

  await withServer(async (base) => {
    const res = await fetch(`${base}/backend/join/${token}`, { headers: { Accept: 'text/html' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();

    // (a) the fenced machine block, VISIBLE in the rendered page
    assert.ok(html.includes(joinPage.MACHINE_BEGIN), 'the machine block must be present');
    assert.ok(html.includes(joinPage.MACHINE_END), 'the machine block must be terminated');
    // It is inside a <pre>, i.e. rendered text — not a comment or a meta tag,
    // so an agent that only receives the rendered page still finds it.
    assert.match(html, new RegExp(`<pre>[^<]*${joinPage.MACHINE_BEGIN.replace(/[-]/g, '\\-')}`));

    // (b) JSON-LD, parseable, carrying the actionable payload
    const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(ld, 'the page must carry a JSON-LD block');
    const parsed = JSON.parse(ld[1]);
    assert.equal(parsed['@context'], 'https://schema.org');
    assert.equal(parsed.agensis.kind, 'workspace_join_invitation');
    assert.match(parsed.agensis.agent.redeem_url, /\/redeem$/);
    assert.equal(parsed.agensis.agent.body.as, 'agent');

    // (c) plain prose an LLM can act on without parsing anything
    assert.ok(html.includes('If you are an AI agent reading this page'));
    assert.ok(html.includes('Send an HTTP POST to this URL, with no Authorization header'));

    // (d) the human half is there too — one page, both audiences
    assert.ok(html.includes('You have been invited to join Acme'));
    assert.ok(html.includes('Sign in and join'));
  });
});

test('Accept: application/json returns the structured form, and ?format=json does too', async () => {
  const token = __test.createJoinLinkToken();
  __test.setTestDb(makeDb({ link: liveLink({ token_hash: sha256(token) }) }));

  await withServer(async (base) => {
    const viaHeader = await fetch(`${base}/backend/join/${token}`, { headers: { Accept: 'application/json' } });
    assert.equal(viaHeader.status, 200);
    const headerBody = await viaHeader.json();
    assert.equal(headerBody.data.kind, 'workspace_join_invitation');
    assert.equal(headerBody.data.single_use, true);
    assert.equal(headerBody.data.agent.method, 'POST');

    // The escape hatch for a client that cannot set headers.
    const viaQuery = await fetch(`${base}/backend/join/${token}?format=json`);
    const queryBody = await viaQuery.json();
    assert.deepEqual(queryBody.data, headerBody.data);
  });
});

test('the response does not depend on User-Agent', async () => {
  const token = __test.createJoinLinkToken();
  __test.setTestDb(makeDb({ link: liveLink({ token_hash: sha256(token) }) }));

  await withServer(async (base) => {
    const agents = [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      'curl/8.4.0',
      'python-requests/2.31.0',
      'Claude-User/1.0',
      '',
    ];
    const bodies = [];
    for (const ua of agents) {
      const res = await fetch(`${base}/backend/join/${token}`, {
        headers: ua ? { Accept: 'text/html', 'User-Agent': ua } : { Accept: 'text/html' },
      });
      bodies.push(await res.text());
    }
    for (const body of bodies) {
      assert.equal(body, bodies[0], 'the page must be byte-identical whatever the User-Agent claims');
    }
  });
});

// Strip line comments so a test about CODE is not defeated (or satisfied) by
// prose. The join block talks about User-Agent at length precisely because it
// refuses to read it.
function codeOnly(source) {
  return source
    .split('\n')
    .filter(line => !/^\s*(\/\/|--|\*|\/\*)/.test(line))
    .join('\n');
}

test('no join code branches on User-Agent', () => {
  // The join routes are now their own module (Wave 2 of the index.cjs
  // reduction), so this is the whole file rather than a slice between two
  // comment markers — the old end marker stayed in index.cjs when the start
  // marker moved, which put `end` BEFORE `start` in the concatenated lane and
  // silently emptied the block being checked.
  const joinRoutes = fs.readFileSync(path.join(root, 'server/join-pages-routes.cjs'), 'utf8');

  for (const [where, block] of [
    ['the join routes', codeOnly(joinRoutes)],
    ['the renderer', codeOnly(fs.readFileSync(path.join(root, 'server/join-page.cjs'), 'utf8'))],
  ]) {
    // Every way an Express handler can reach the header.
    assert.ok(!/user-agent/i.test(block), `${where} must not read User-Agent`);
    assert.ok(!/\bua\b|userAgent/i.test(block), `${where} must not carry a User-Agent derived value`);
    // Nor may it sniff for a browser by another name.
    assert.ok(!/isBrowser|isBot|isCrawler/i.test(block), `${where} must not classify the caller`);
  }
});

// ---------------------------------------------------------------------------
// 6. The preview: visible to the owner, incapable of leaking
// ---------------------------------------------------------------------------

test('the preview renders both views and mints nothing', async () => {
  // No link in the database at all, and no auth. If the preview touched the DB
  // the fake would throw on the unexpected SQL, which is the point.
  const db = makeDb({ link: null });
  __test.setTestDb(db);

  await withServer(async (base) => {
    const html = await fetch(`${base}/backend/join/preview`, { headers: { Accept: 'text/html' } });
    assert.equal(html.status, 200);
    const page = await html.text();
    assert.ok(page.includes('Preview.'), 'a preview must say so on its face');
    assert.ok(page.includes(joinPage.MACHINE_BEGIN), 'the preview must show the agent view too');
    assert.ok(page.includes('Example Workspace'), 'the preview uses invented data');

    const json = await fetch(`${base}/backend/join/preview?format=json`);
    const body = await json.json();
    assert.equal(body.data.preview, true);
    assert.equal(body.data.workspace, 'Example Workspace');

    // The preview never mints and never looks anything up. Asserted on what the
    // database actually saw, not on intent: no agent row, no activity row, and
    // not one statement naming the join-links table. (The app's own boot-time
    // schema work also lands in db.calls, which is why this asks about the table
    // rather than about the call count.)
    assert.equal(db.agents.length, 0, 'the preview must not create an agent');
    assert.equal(db.activity.length, 0, 'the preview must not write an activity row');
    const touched = db.calls
      .filter(c => c.normalized.includes('workspace_join_links'))
      // The boot-time CREATE TABLE names it too; that is the schema, not a read.
      .filter(c => !c.normalized.startsWith('create table'))
      .map(c => c.normalized.slice(0, 80));
    assert.deepEqual(touched, [], 'the preview route must not query the join-links table');
  });
});

test('the preview handler cannot reach the database or a token minter', () => {
  const source = require('./helpers/fly-lane.cjs').flyLaneSource();
  const start = source.indexOf("app.get(['/backend/join/preview', '/join/preview']");
  assert.ok(start > 0, 'the preview route must still exist');
  const end = source.indexOf("app.get(['/backend/join/:token'", start);
  assert.ok(end > start, 'the preview route must come before the token route');
  const handler = source.slice(start, end);

  // Structural, not aspirational: the preview handler has no way to mint or read
  // anything, because none of these appear inside it.
  for (const forbidden of ['getDb(', 'crypto.', 'createJoinLinkToken', 'createAgentConnectToken', 'hashAgentToken']) {
    assert.ok(!handler.includes(forbidden), `the preview handler must not reference ${forbidden}`);
  }
  // And its token is a constant that cannot address a real row.
  assert.equal(__test.isJoinLinkToken(joinPage.PREVIEW_TOKEN), false,
    'the preview token must fail the join-token shape check');
});

// ---------------------------------------------------------------------------
// 7. Headers, and the URL-in-the-path problem
// ---------------------------------------------------------------------------

test('the page is uncacheable, unindexable, and sends no referrer', async () => {
  const token = __test.createJoinLinkToken();
  __test.setTestDb(makeDb({ link: liveLink({ token_hash: sha256(token) }) }));

  await withServer(async (base) => {
    const res = await fetch(`${base}/backend/join/${token}`, { headers: { Accept: 'text/html' } });
    // The token IS the URL, so a Referer on the outbound click would hand the
    // whole secret to the next origin. This is the header that prevents it.
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('cache-control') || '', /no-store/);
    assert.match(res.headers.get('x-robots-tag') || '', /noindex/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    // The page has no script and no external asset, which is what makes this
    // policy achievable rather than aspirational.
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
  });
});

test('the service worker leaves /join to the network', () => {
  // This repo has already shipped a soft-404 caused by the SW handing the app
  // shell to paths the SPA does not own. If /join fell into the navigation
  // fallback, a visitor whose browser already has the agensis worker registered
  // would get an empty <div id="root"> instead of the join page — and an agent
  // fetching it would find no instructions at all. The allowlist is what
  // prevents that, so it is asserted rather than assumed.
  const config = fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8');
  const line = config.split('\n').find(l => l.includes('navigateFallbackAllowlist'));
  assert.ok(line, 'the SW must still use an allowlist, not a denylist');
  // A substring check on the whole line, deliberately, rather than parsing the
  // regex literals out of it: the first version of this test tried to extract
  // each pattern and its `[^/]+` stopped dead at the escaped slash in
  // `/^\/join/`, so adding /join to the allowlist did not fail it. A test that
  // cannot see the regression is worse than no test.
  assert.ok(!/join/.test(line), `/join must not be in the SW navigation fallback:\n${line.trim()}`);

  // And no runtime cache may store it either: the URL is a secret and the page
  // is single-use, so a cached copy is both a leak and a lie.
  const runtime = config.slice(config.indexOf('runtimeCaching'));
  for (const urlPatternLine of runtime.split('\n').filter(l => l.includes('urlPattern:'))) {
    assert.ok(!/join/.test(urlPatternLine), `a runtime cache rule matches /join: ${urlPatternLine.trim()}`);
  }
});

test('netlify sets the same two headers on the proxied route', () => {
  const toml = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');
  // The backend sets these too, but Netlify serves the proxied response and its
  // site-wide strict-origin-when-cross-origin would otherwise send the full URL
  // on a SAME-origin navigation to /app — token included.
  const block = toml.slice(toml.indexOf('for = "/join/*"'));
  assert.match(block, /Referrer-Policy = "no-referrer"/);
  assert.match(block, /Cache-Control = "no-store/);

  // And the proxy itself must sit above the catch-all, or every join link 404s.
  const proxyAt = toml.indexOf('from = "/join/*"');
  const catchAllAt = toml.indexOf('from = "/*"');
  assert.ok(proxyAt > 0, 'the /join/* proxy must exist');
  assert.ok(proxyAt < catchAllAt, 'the /join/* proxy must be declared before the /* catch-all');
});

// ---------------------------------------------------------------------------
// 8. Schema in three places, and the jsonb bind
// ---------------------------------------------------------------------------

test('workspace_join_links is defined in all three schema places', () => {
  const runtime = require('./helpers/fly-lane.cjs').flyLaneSource();
  const canonical = fs.readFileSync(path.join(root, 'database/neon-schema.sql'), 'utf8');
  const migrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
    .map(name => fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8'))
    .join('\n');

  for (const [where, source] of [['ensureRuntimeSchema', runtime], ['neon-schema.sql', canonical], ['a migration', migrations]]) {
    assert.ok(/CREATE TABLE IF NOT EXISTS workspace_join_links/.test(source), `missing from ${where}`);
    assert.ok(/token_hash text NOT NULL UNIQUE/.test(source), `token_hash must be unique in ${where}`);
    // The column that does not exist is the assertion: there is no `token`
    // column anywhere, so a plaintext link cannot be stored even by mistake.
    const table = source.slice(source.indexOf('CREATE TABLE IF NOT EXISTS workspace_join_links'));
    const body = table.slice(0, table.indexOf(');'));
    assert.ok(!/^\s*token text/m.test(body), `${where} must not store a plaintext token`);
  }
});

test('join links are not reachable through the generic table client', () => {
  const core = require('../shared/backend-core.cjs');
  // Not in the allowlists: the dedicated manage-role routes are the only doors.
  // A table in ALLOWED_TABLES is one `select('*')` away from shipping
  // token_hash to a browser.
  assert.equal(core.ALLOWED_TABLES.has('workspace_join_links'), false);
});
