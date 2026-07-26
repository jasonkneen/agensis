// ============================================================================
// tests/channel-mention-dispatch.test.cjs
// ----------------------------------------------------------------------------
// @channel — one mention that addresses every agent participant of a channel —
// and the reply-timing setting that decides whether an UN-addressed post is
// allowed to wake anyone at all.
//
// What is under test:
//   1. @channel resolves to the session's STORED agent roster, in roster order,
//      and to nobody outside it;
//   2. it advances ONE agent at a time (a burst, not a fan-out) and stops when
//      every addressed agent has answered — which is what makes N agents cost
//      N sequential turns bounded by max_agent_turns rather than N at once;
//   3. an agent that somehow holds the handle `channel` cannot capture the
//      mention;
//   4. the handle is refused at the doors that mint one — the generic db write
//      and MCP self-registration;
//   5. @channel adds nobody to the roster (it addresses it, it does not join it);
//   6. conversation_mode is read again: 'mention' means an un-addressed post
//      dispatches nobody, while an @mention still dispatches in both modes.
//
// (1)-(3) are exercised against pickMentionNextAgent, which is the single
// function continueConversation asks "who runs next" — testing it directly pins
// the decision without needing a whole fake burst pipeline for every case.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');
const { CHANNEL_MENTION_MAX_AGENTS } = require('../shared/channelMentions.cjs');

test.afterEach(() => __test.resetTestState());

const SCOUT = { id: 'a-scout', name: 'Scout', handle: 'scout', enabled: true };
const CODER = { id: 'a-coder', name: 'Coder', handle: 'coder', enabled: true };
const WRITER = { id: 'a-writer', name: 'Writer', handle: 'writer', enabled: true };
const OFF = { id: 'a-off', name: 'Off', handle: 'off', enabled: false };

function byHandleMap(agents) {
  const map = new Map();
  for (const agent of agents) {
    if (agent.enabled === false) continue;
    map.set(__test.slugHandle(agent.handle || agent.name), agent);
    const nameHandle = __test.slugHandle(agent.name);
    if (!map.has(nameHandle)) map.set(nameHandle, agent);
  }
  return map;
}

function human(content) {
  return { role: 'user', sender_kind: 'user', sender_id: 'u1', content };
}
function agentReply(agent, content = 'done') {
  return { role: 'assistant', sender_kind: 'agent', sender_id: agent.id, sender_name: agent.name, content };
}

// --- 1: who @channel reaches ------------------------------------------------

test('@channel picks the first roster agent, then the next, one per turn', () => {
  const roster = [SCOUT, CODER, WRITER];
  const byHandle = byHandleMap([...roster, OFF]);

  // Turn 1: nobody has answered yet.
  let burst = [human('@channel status please')];
  let next = __test.pickMentionNextAgent(burst, byHandle, '', roster);
  assert.equal(next.id, SCOUT.id, 'first in roster order');

  // Turn 2: Scout has answered, so the next unsatisfied addressee runs.
  burst = [human('@channel status please'), agentReply(SCOUT)];
  next = __test.pickMentionNextAgent(burst, byHandle, SCOUT.id, roster);
  assert.equal(next.id, CODER.id);

  // Turn 3.
  burst = [human('@channel status please'), agentReply(SCOUT), agentReply(CODER)];
  next = __test.pickMentionNextAgent(burst, byHandle, CODER.id, roster);
  assert.equal(next.id, WRITER.id);

  // Everyone addressed has answered: the burst ends. This is the guarantee that
  // makes @channel bounded — it does not keep finding work forever.
  burst = [human('@channel go'), agentReply(SCOUT), agentReply(CODER), agentReply(WRITER)];
  assert.equal(__test.pickMentionNextAgent(burst, byHandle, WRITER.id, roster), null);
});

test('@channel reaches nobody outside the roster, and nobody when the roster is empty', () => {
  // The roster is the ONLY input. An agent that exists in the workspace but was
  // never added to the channel is not in the channel, so @channel does not wake
  // it — the presence-leak failure mode cannot happen through this path because
  // presence is not one of the arguments.
  const byHandle = byHandleMap([SCOUT, CODER, WRITER]);
  const burst = [human('@channel everyone')];
  assert.equal(__test.pickMentionNextAgent(burst, byHandle, '', []), null, 'no roster, no dispatch');
  assert.equal(__test.pickMentionNextAgent(burst, byHandle, '', [WRITER]).id, WRITER.id);
});

test('@channel never asks an agent to answer itself', () => {
  // An agent writing "@channel" in its own message must not be dispatched by it,
  // and the agent that just spoke never replies to itself back-to-back. Both
  // rules already governed plain @mentions; @channel inherits them rather than
  // getting its own copy.
  const roster = [SCOUT, CODER];
  const byHandle = byHandleMap(roster);

  const selfMention = [human('kick off'), { ...agentReply(SCOUT, '@channel anyone else?'), sender_id: SCOUT.id }];
  const next = __test.pickMentionNextAgent(selfMention, byHandle, SCOUT.id, roster);
  assert.equal(next.id, CODER.id, 'the other agent, not the author');
});

test('a named agent written before @channel is asked first', () => {
  // Order of appearance decides order of dispatch, so "@scout — and @channel for
  // awareness" asks Scout first rather than whoever happens to head the roster.
  const roster = [CODER, WRITER, SCOUT];
  const byHandle = byHandleMap(roster);
  const burst = [human('@scout take this, @channel for awareness')];
  assert.equal(__test.pickMentionNextAgent(burst, byHandle, '', roster).id, SCOUT.id);
});

test('@channel skips a disabled roster agent', () => {
  // expandChannelMention filters these out before pickMentionNextAgent sees
  // them; this pins that a disabled agent passed in anyway is still skipped, so
  // the two guards cannot both be removed by accident.
  const byHandle = byHandleMap([SCOUT, CODER]);
  const burst = [human('@channel go')];
  assert.equal(__test.pickMentionNextAgent(burst, byHandle, '', [OFF, CODER]).id, CODER.id);
});

test('the roster expansion is capped, so one @channel cannot queue an unbounded burst', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, name: `A${i}`, handle: `a${i}`, enabled: true }));
  const expanded = __test.agentsAddressedByRow(human('@channel'), byHandleMap(many), many.slice(0, CHANNEL_MENTION_MAX_AGENTS));
  assert.equal(expanded.length, CHANNEL_MENTION_MAX_AGENTS);
});

// --- 3: the handle cannot be captured ---------------------------------------

test('an agent holding the handle `channel` cannot capture the mention', () => {
  // Belt and braces. The braces (isReservedAgentHandle, below) stop such a row
  // being created; this is the belt, for a row written straight into the
  // database or one predating the check. `@channel` is resolved BEFORE any
  // handle lookup, so the impostor is simply never consulted.
  const impostor = { id: 'a-evil', name: 'Channel', handle: 'channel', enabled: true };
  const roster = [SCOUT];
  const byHandle = byHandleMap([impostor, SCOUT]);

  const next = __test.pickMentionNextAgent([human('@channel please')], byHandle, '', roster);
  assert.equal(next.id, SCOUT.id, 'the roster answered, not the impostor');

  // And the impostor is not reachable by the mention at all: parseAgentMentions
  // strips `channel` before any lookup happens.
  assert.deepEqual(__test.parseAgentMentions('@channel please'), []);
  assert.deepEqual(__test.parseAllMentions('@channel please'), ['channel']);
});

test('an agent named "Channel" with a normal handle is still reachable by its own handle', () => {
  // Over-blocking is its own bug. `channel` is reserved as a HANDLE; a display
  // name is free text and reserving it too would refuse a name a human is
  // entitled to use.
  const named = { id: 'a-named', name: 'Channel', handle: 'chan-team', enabled: true };
  const byHandle = byHandleMap([named]);
  const next = __test.pickMentionNextAgent([human('@chan-team hello')], byHandle, '', []);
  assert.equal(next.id, named.id);
});

// --- 5: @channel adds nobody to the roster ----------------------------------

test('@channel does not add participants — it addresses the ones already there', async () => {
  let updated = false;
  __test.setTestDb({
    async unsafe(sql) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n.startsWith('select id, name, handle, enabled from workspace_agents')) return [SCOUT, CODER];
      if (n.startsWith('update chat_sessions set participants')) { updated = true; return []; }
      return [];
    },
  });

  const added = await __test.ensureMentionedParticipants('w1', { id: 's1', participants: [] }, 'hello @channel');
  assert.equal(added, 0, '@channel adds nobody');
  assert.equal(updated, false, 'and writes nothing');
});

test('a real handle alongside @channel is still added', async () => {
  let merged = null;
  __test.setTestDb({
    async unsafe(sql, params) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n.startsWith('select id, name, handle, enabled from workspace_agents')) return [SCOUT, CODER];
      if (n.startsWith('update chat_sessions set participants')) {
        assert.ok(Array.isArray(params[0]), 'participants must be bound as an array, never stringified');
        merged = params[0];
        return [{ id: 's1', participants: merged }];
      }
      return [];
    },
  });

  const added = await __test.ensureMentionedParticipants('w1', { id: 's1', participants: [] }, '@channel and @coder');
  assert.equal(added, 1);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].agent_id, CODER.id);
});
