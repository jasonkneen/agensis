'use strict';

// POST /backend/agent-jobs/:jobId/cancel — stop ONE running agent turn.
//
// The handler is mounted against a fake app and exercised for real, rather than
// grepped, because the properties that matter here are about ORDER and about
// what happens when a step fails — neither of which a source-text assertion can
// see:
//
//   1. the durable status='cancelled' compare-and-set must WIN BEFORE any
//      runtime effect fires (builtin-turn.cjs:105-111). Abort first and a crash
//      in between leaves a row that says 'running' with nothing running;
//   2. already-terminal is a 200 no-op, not an error — the button gets pressed
//      exactly when nobody is sure whether anything is still happening;
//   3. a dead daemon socket must not fail the call: the row is authoritative
//      and the late-result guard discards whatever the daemon sends later;
//   4. it is 'write'-gated AND under the DM read gate. A viewer must not halt
//      the work in a channel, and a workspace member outside a private
//      conversation must not reach into it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { mountAgentJobCancelRoutes } = require('../server/agent-job-cancel-routes.cjs');

const RUNNING_JOB = {
  id: 'job-1',
  workspace_id: 'ws-1',
  session_id: 'sess-1',
  agent_id: 'agent-1',
  connection_id: 'conn-1',
  status: 'running',
  s_id: 'sess-1',
  s_workspace_id: 'ws-1',
  visibility: 'workspace',
  folder: 'Channels',
  deleted_at: null,
};

function harness(overrides = {}) {
  const events = [];
  let handler = null;
  const app = {
    post(path, _auth, fn) {
      if (path === '/backend/agent-jobs/:jobId/cancel') handler = fn;
    },
  };

  const state = {
    job: overrides.job === undefined ? { ...RUNNING_JOB } : overrides.job,
    // Rows the CAS returns. Empty array = the CAS lost the race.
    casRows: overrides.casRows === undefined
      ? [{ ...RUNNING_JOB, status: 'cancelled', finished_at: 'now' }]
      : overrides.casRows,
  };

  const deps = {
    requireAuth: (req, res, next) => next(),
    jsonError: (res, status, error) => res.status(status).json({ error: error?.message }),
    badRequest: message => Object.assign(new Error(message), { status: 400 }),
    getDb: () => ({
      unsafe: async (sql) => {
        if (/from agent_jobs j/.test(sql)) {
          events.push('select');
          return state.job ? [state.job] : [];
        }
        if (/update agent_jobs/.test(sql)) {
          events.push('cas');
          return state.casRows;
        }
        events.push('reread');
        return state.job ? [state.job] : [];
      },
    }),
    notifyDbSubscribers: () => { events.push('notify'); },
    enforceWorkspaceRole: async (_userId, _workspaceId, role) => {
      events.push(`role:${role}`);
      if (overrides.denyRole) throw Object.assign(new Error('Forbidden'), { status: 403 });
    },
    enforceSessionRead: async () => {
      events.push('session-read');
      if (overrides.denySession) throw Object.assign(new Error('Not found'), { status: 404 });
    },
    cancelBuiltinJob: () => {
      events.push('builtin-abort');
      if (overrides.builtinThrows) throw new Error('boom');
      return true;
    },
    sendToConnection: () => {
      events.push('daemon-frame');
      if (overrides.socketThrows) throw new Error('socket gone');
      return overrides.socketDelivers !== false;
    },
    scheduleTaskQueueDrain: () => { events.push('drain'); },
    rateLimitBlocked: () => Boolean(overrides.rateLimited),
    agentJobCancelRateLimiter: {},
    onWarn: () => {},
  };

  mountAgentJobCancelRoutes(app, deps);
  assert.ok(handler, 'the cancel route was not mounted');

  async function call(jobId = 'job-1') {
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    await handler({ params: { jobId }, userId: 'user-1', body: {} }, res);
    return res;
  }

  return { call, events };
}

test('the durable cancel wins before any runtime effect fires', async () => {
  const { call, events } = harness();
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.stopped, true);

  const cas = events.indexOf('cas');
  assert.ok(cas > -1, 'the compare-and-set must run');
  for (const effect of ['builtin-abort', 'daemon-frame', 'drain']) {
    assert.ok(events.indexOf(effect) > cas, `${effect} must not run before the durable write`);
  }
});

test('authorization runs on the row that was read, before the write', async () => {
  const { call, events } = harness();
  await call();
  assert.ok(events.indexOf('select') < events.indexOf('role:write'), 'authorize what was read');
  assert.ok(events.indexOf('role:write') < events.indexOf('cas'), 'authorize before mutating');
  assert.ok(events.includes('session-read'), 'the DM gate must run under the workspace role');
});

test('stopping is a write, never a read — a viewer must not halt the work', async () => {
  const { call, events } = harness();
  await call();
  assert.ok(events.includes('role:write'));
  assert.ok(!events.includes('role:read'), "'read' would let a viewer stop other people's agents");
});

test('a denied role stops before the compare-and-set', async () => {
  const { call, events } = harness({ denyRole: true });
  const res = await call();
  assert.equal(res.statusCode, 403);
  assert.ok(!events.includes('cas'), 'nothing may be written when authorization fails');
});

test('a private conversation the caller is not in cannot be reached into', async () => {
  const { call, events } = harness({ denySession: true });
  const res = await call();
  assert.equal(res.statusCode, 404);
  assert.ok(!events.includes('cas'));
});

test('an already-finished job is a 200 no-op, not an error', async () => {
  const { call, events } = harness({ job: { ...RUNNING_JOB, status: 'done' } });
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.stopped, false);
  assert.ok(!events.includes('cas'), 'a terminal job must not be re-written');
  assert.ok(!events.includes('daemon-frame'), 'and no daemon must be woken for it');
});

test('losing the compare-and-set reports what actually holds', async () => {
  // The reaper, a session close or a second click got there first.
  const { call, events } = harness({ casRows: [] });
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.stopped, false);
  assert.ok(events.includes('reread'), 'report the real row rather than claiming this call did it');
  assert.ok(!events.includes('daemon-frame'), 'and do not signal for a cancel this call did not win');
});

test('a missing job is a 404 and writes nothing', async () => {
  const { call, events } = harness({ job: null });
  const res = await call();
  assert.equal(res.statusCode, 404);
  assert.ok(!events.includes('cas'));
});

test('a dead daemon socket still leaves the job cancelled', async () => {
  // The row is authoritative. Reporting failure here would tell the user the
  // agent is still running when it has in fact been terminally cancelled.
  const { call } = harness({ socketThrows: true });
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.stopped, true);
  assert.equal(res.body.data.signalled, false);
});

test('an undeliverable frame is reported without failing the call', async () => {
  const { call } = harness({ socketDelivers: false });
  const res = await call();
  assert.equal(res.body.data.stopped, true);
  assert.equal(res.body.data.signalled, false);
});

test('a throwing in-process abort does not abandon the daemon signal', async () => {
  const { call, events } = harness({ builtinThrows: true });
  const res = await call();
  assert.equal(res.body.data.stopped, true);
  assert.ok(events.includes('daemon-frame'), 'one failing effect must not skip the others');
  assert.ok(events.includes('drain'));
});

test('the cancelled row is broadcast so the button disappears everywhere', async () => {
  const { call, events } = harness();
  await call();
  assert.ok(events.includes('notify'));
  assert.ok(events.indexOf('notify') > events.indexOf('cas'), 'never announce an uncommitted cancel');
});

test('cancelling frees the agent for whatever is queued behind it', async () => {
  const { call, events } = harness();
  await call();
  assert.ok(events.includes('drain'), 'a cancelled turn releases the slot exactly like a finished one');
});

test('a blank job id is rejected before touching the database', async () => {
  const { call, events } = harness();
  const res = await call('   ');
  assert.equal(res.statusCode, 400);
  assert.equal(events.length, 0);
});

test('a rate-limited call never reaches the database', async () => {
  const { call, events } = harness({ rateLimited: true });
  await call();
  assert.equal(events.length, 0);
});
