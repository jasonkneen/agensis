import { describe, expect, it } from 'vitest';
import {
  FIELD_WEIGHTS,
  PROMPT_INDEX_CHARS,
  buildSuggestionIndex,
  reasonLabel,
  suggestChannelMembers,
  tokenize,
} from '../../src/lib/channelMemberSuggestions';
import type { AgentConnection, ChatSession, WorkspaceAgent } from '../../src/types';

// ---------------------------------------------------------------------------
// These are RELATIVE-ORDER tests: each one puts two agents in front of the
// ranker that differ in exactly ONE signal and asserts which comes first. A
// test that baked in an expected ordering would be testing its own fixture.
//
// Every `it` names the mutation that must break it, and each of those mutations
// was applied to the scorer and confirmed to flip the assertion before the test
// was kept. A test that passes both with and without its listed mutation has
// not actually run.
// ---------------------------------------------------------------------------

let seq = 0;
function agent(partial: Partial<WorkspaceAgent> & { name: string }): WorkspaceAgent {
  seq += 1;
  return {
    id: partial.id ?? `agent-${seq}`,
    workspace_id: 'ws',
    name: partial.name,
    avatar: '',
    description: partial.description ?? '',
    system_prompt: partial.system_prompt ?? '',
    instructions: partial.instructions ?? '',
    tools: partial.tools ?? [],
    skills: partial.skills ?? [],
    handle: partial.handle ?? null,
    model: 'auto',
    run_mode: partial.run_mode ?? 'builtin',
    enabled: partial.enabled ?? true,
    created_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as WorkspaceAgent;
}

function connection(agentId: string, skills: string[]): AgentConnection {
  return {
    id: `conn-${agentId}`,
    workspace_id: 'ws',
    agent_id: agentId,
    name: agentId,
    handle: agentId,
    host: 'host',
    cwd: '/tmp',
    status: 'online',
    metadata: {},
    capabilities: { skills, clis: [], mcpServers: [] },
    connected_at: '2026-01-01T00:00:00Z',
    last_seen_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as AgentConnection;
}

/** A channel containing these agents. `folder` is what makes it a DM instead. */
function session(id: string, agentIds: string[], overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    workspace_id: 'ws',
    title: id,
    model: 'auto',
    participants: agentIds.map(agentId => ({
      id: `agent:${agentId}`,
      name: agentId,
      kind: 'agent' as const,
      agent_id: agentId,
      user_id: null,
    })),
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as ChatSession;
}

const rank = (result: { agentId: string }[], id: string) => result.findIndex(row => row.agentId === id);

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics and drops 1-char noise', () => {
    expect(tokenize('Incident-Response v2')).toEqual(['incident', 'response', 'v2']);
  });

  it('drops the universal stopwords so they never reach the index', () => {
    expect(tokenize('you are the agent for this')).toEqual(['agent']);
  });

  it('is empty for null, undefined and punctuation', () => {
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
    expect(tokenize('--- ///')).toEqual([]);
  });
});

describe('IDF is what stops boilerplate deciding the ranking', () => {
  // Ada matches a RARE token in her lowest-weight field (prompt, 0.6).
  // Bo and friends match a UBIQUITOUS token in a high-weight field (skills, 2.0).
  // Ada must still win: a word five of six agents use says nothing about which
  // of them belongs in this room.
  const ada = agent({ name: 'Ada', system_prompt: 'postgres tuning and vacuum strategy' });
  const others = ['Bo', 'Cy', 'Di', 'Ed', 'Fi'].map(name => agent({ name, skills: ['support'] }));
  const agents = [ada, ...others];

  it('a rare prompt hit outranks a ubiquitous skill hit', () => {
    // MUTATION: replace `idf.set(token, ...)` with a constant 1.0. Without IDF,
    // Bo scores 1.0 x 2.0 = 2.0 against Ada's 1.0 x 0.6 = 0.6 and every
    // `support` agent jumps above her.
    const index = buildSuggestionIndex(agents, [], []);
    const result = suggestChannelMembers(index, 'postgres support', { limit: 10 });
    expect(result[0].agentId).toBe(ada.id);
  });

  it('scores the ubiquitous token near zero rather than merely lower', () => {
    // The margin is the point. log(N/df) leaves ~0.6 on a token everybody has,
    // which is still enough to swing a close ranking; the BM25 form leaves ~0.1.
    const index = buildSuggestionIndex(agents, [], []);
    expect(index.idf.get('support')!).toBeLessThan(0.35);
    expect(index.idf.get('postgres')!).toBeGreaterThan(1.0);
  });
});

describe('the source of a claim changes what it is worth', () => {
  it('an advertised skill outranks the same string merely configured', () => {
    // BOTH agents are connected, so the liveness bonus cancels and field weight
    // is the only difference left. Ada sorts first on a tie, so a flip is real.
    // MUTATION: set FIELD_WEIGHTS.advertised = FIELD_WEIGHTS.configured. The two
    // then tie and the name tie-break puts Ada first.
    const ada = agent({ name: 'Ada', id: 'ada', skills: ['deploy'] });
    const bo = agent({ name: 'Bo', id: 'bo', skills: [] });
    const index = buildSuggestionIndex(
      [ada, bo],
      [connection('ada', []), connection('bo', ['deploy'])],
      [],
    );
    const result = suggestChannelMembers(index, 'deploy');
    expect(result[0].agentId).toBe('bo');
  });

  it('a tools[] hit cannot outrank a skills[] hit on the same token', () => {
    // `tools` gates nothing — the builtin lane builds its tool list from
    // toolset.specs(), never from this column, and server-side it is only ever
    // interpolated into a prompt as text. Matching it matches a LABEL.
    // Avery sorts first alphabetically, so if weight stopped deciding, Avery
    // would lead. MUTATION: set FIELD_WEIGHTS.advisory = FIELD_WEIGHTS.configured.
    const avery = agent({ name: 'Avery', id: 'avery', tools: ['postgres'] });
    const blake = agent({ name: 'Blake', id: 'blake', skills: ['postgres'] });
    const index = buildSuggestionIndex([avery, blake], [], []);
    const result = suggestChannelMembers(index, 'postgres');
    expect(result[0].agentId).toBe('blake');
    expect(FIELD_WEIGHTS.advisory).toBeLessThan(FIELD_WEIGHTS.configured);
  });

  it('a tools[]-derived chip never uses capability wording', () => {
    // The UI must not assert something the column does not grant. `advisory`
    // and `configured` share the hedged form; only `advertised` may say "skill".
    // MUTATION: change the 'advisory' case of reasonLabel to `skill: ${token}`.
    const advisory = reasonLabel('advisory', 'postgres', 'avery');
    expect(advisory).toBe('lists: postgres');
    expect(advisory).not.toContain('skill');
    expect(advisory).not.toContain('can ');
    expect(reasonLabel('configured', 'postgres', 'x')).toBe('lists: postgres');
    expect(reasonLabel('advertised', 'postgres', 'x')).toBe('skill: postgres');
  });
});

describe('length is not evidence', () => {
  it('a token that appears only past the prompt cutoff does not match at all', () => {
    // MUTATION: drop the `.slice(0, PROMPT_INDEX_CHARS)` when indexing the
    // prompt. The buried token is then indexed and Verbose matches `kubernetes`.
    const padding = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(20);
    expect(padding.length).toBeGreaterThan(PROMPT_INDEX_CHARS);
    const verbose = agent({ name: 'Verbose', id: 'verbose', system_prompt: `${padding} kubernetes` });
    const index = buildSuggestionIndex([verbose], [], []);
    const result = suggestChannelMembers(index, 'kubernetes');
    expect(result.find(row => row.agentId === 'verbose')?.matched).toBe(false);
  });

  it('repeating a token in a prompt does not make it beat a declared skill', () => {
    // MUTATION: accumulate in `addToken` (`existing + weight`) instead of
    // keeping the maximum. Bo's 30 repeats then swamp Ada's single skill.
    const ada = agent({ name: 'Ada', id: 'ada', skills: ['deploy'] });
    const bo = agent({ name: 'Bo', id: 'bo', system_prompt: 'deploy '.repeat(30) });
    const index = buildSuggestionIndex([ada, bo], [], []);
    expect(suggestChannelMembers(index, 'deploy')[0].agentId).toBe('ada');
  });
});

describe('popularity never outranks relevance', () => {
  // The single most damaging way this feature can be wrong: an always-online
  // agent in a dozen channels quietly outranking the agent whose declared skill
  // IS the subject of the channel.
  //
  // The numbers here are deliberately hostile. Ada's only hit is a PREFIX match
  // in her PROMPT — the weakest match the scorer can produce (0.6 x 0.5) — and
  // it scores ~0.29, BELOW the ~0.35 an agent in every channel earns from the
  // prior alone. Nothing but the matched/unmatched tier keeps her on top.
  const ada = agent({ name: 'Ada', id: 'ada', system_prompt: 'triageflow rotation notes' });
  const zed = agent({ name: 'Zed', id: 'zed' });
  const moe = agent({ name: 'Moe', id: 'moe' });
  const sessions = [session('c1', ['zed']), session('c2', ['zed']), session('c3', ['zed'])];

  it('a weak match outranks a popular, online, non-matching agent', () => {
    // MUTATION: remove the `if (a.matched !== b.matched)` tier from the sort.
    // Zed's 0.35 then beats Ada's 0.294 and the room is suggested the agent who
    // is merely busy instead of the one who might know something.
    const index = buildSuggestionIndex([ada, zed, moe], [connection('zed', [])], sessions);
    const result = suggestChannelMembers(index, 'triage', { limit: 10 });
    expect(rank(result, 'ada')).toBeLessThan(rank(result, 'zed'));
  });

  it('and the margin really is against it — the tier is load-bearing, not decorative', () => {
    const index = buildSuggestionIndex([ada, zed, moe], [connection('zed', [])], sessions);
    const result = suggestChannelMembers(index, 'triage', { limit: 10 });
    const adaScore = result.find(row => row.agentId === 'ada')!.score;
    const zedScore = result.find(row => row.agentId === 'zed')!.score;
    expect(adaScore).toBeLessThan(zedScore);
  });
});

describe('the fallback when the name matches nobody', () => {
  it('an empty name returns the most-used agents rather than nothing', () => {
    // An empty panel reads as broken. MUTATION: `if (!queryTokens.length) return []`.
    const ada = agent({ name: 'Ada', id: 'ada' });
    const bo = agent({ name: 'Bo', id: 'bo' });
    const index = buildSuggestionIndex([ada, bo], [], [session('c1', ['ada'])]);
    const result = suggestChannelMembers(index, '');
    expect(result.length).toBe(2);
    expect(result[0].agentId).toBe('ada');
  });

  it('labels the fallback as unmatched so the UI cannot present it as a match', () => {
    // `matched` is what ChannelMemberStep reads to swap the heading from
    // "Suggested" to "Most used here". MUTATION: hardcode `matched: true`.
    const ada = agent({ name: 'Ada', id: 'ada' });
    const index = buildSuggestionIndex([ada], [], [session('c1', ['ada'])]);
    const [only] = suggestChannelMembers(index, 'zzzznope');
    expect(only.matched).toBe(false);
    expect(only.reason.field).toBe('prior');
    expect(only.reason.label).toBe('in 1 channel');
  });

  it('an agent in no channels at all still reads honestly', () => {
    const index = buildSuggestionIndex([agent({ name: 'Ada', id: 'ada' })], [], []);
    expect(suggestChannelMembers(index, '')[0].reason.label).toBe('in no channels yet');
  });
});

describe('what counts as a channel for the prior', () => {
  it('DMs contribute nothing — every agent has one, so they carry no information', () => {
    // MUTATION: remove the `folder === 'Direct messages'` filter from
    // isRankableChannel. Ada's 9 DMs then dwarf Bo's single real channel and she
    // is suggested for every unrelated name in the workspace.
    const ada = agent({ name: 'Ada', id: 'ada' });
    const bo = agent({ name: 'Bo', id: 'bo' });
    const dms = Array.from({ length: 9 }, (_, i) =>
      session(`dm${i}`, ['ada'], { folder: 'Direct messages' }));
    const index = buildSuggestionIndex([ada, bo], [], [...dms, session('c1', ['bo'])]);
    expect(index.channelCount.get('ada')).toBeUndefined();
    expect(suggestChannelMembers(index, '')[0].agentId).toBe('bo');
  });

  it('sub-threads and deleted channels do not count either', () => {
    const ada = agent({ name: 'Ada', id: 'ada' });
    const index = buildSuggestionIndex([ada], [], [
      session('t1', ['ada'], { parent_message_id: 'm1' }),
      session('d1', ['ada'], { deleted_at: '2026-01-02T00:00:00Z' }),
    ]);
    expect(index.channelCount.get('ada')).toBeUndefined();
  });

  it('a participant row written as bare <uuid> still counts', () => {
    // The roster has held two shapes for the same agent. Counting only the
    // `agent:<uuid>` form would undercount every channel the older writer made.
    const ada = agent({ name: 'Ada', id: 'ada' });
    const bare = {
      ...session('c1', []),
      participants: [{ id: 'ada', name: 'Ada', kind: 'agent' as const, agent_id: 'ada' }],
    } as ChatSession;
    const index = buildSuggestionIndex([ada], [], [bare]);
    expect(index.channelCount.get('ada')).toBe(1);
  });
});

describe('selection changes what is suggested next', () => {
  it('picking an agent lifts the ones it usually works with', () => {
    // MUTATION: make `affinity` a constant. Zoe and Bea then tie on the prior
    // and the name tie-break puts Bea first, losing the only "and who usually
    // goes with them" signal this feature has.
    const ana = agent({ name: 'Ana', id: 'ana' });
    const zoe = agent({ name: 'Zoe', id: 'zoe' });
    const bea = agent({ name: 'Bea', id: 'bea' });
    const sessions = [
      session('c1', ['ana', 'zoe']),
      session('c2', ['ana', 'zoe']),
      session('c3', ['ana', 'zoe']),
      session('c4', ['bea']),
      session('c5', ['bea']),
      session('c6', ['bea']),
    ];
    const index = buildSuggestionIndex([ana, zoe, bea], [], sessions);

    // All three sit in 3 channels, so the prior is level and only the name
    // tie-break separates them: Bea comes before Zoe.
    const cold = suggestChannelMembers(index, '');
    expect(rank(cold, 'bea')).toBeLessThan(rank(cold, 'zoe'));

    // Picking Ana lifts her usual collaborator above the agent she has never
    // shared a channel with — reversing the name order that held a moment ago.
    const withAna = suggestChannelMembers(index, '', { selectedAgentIds: ['ana'] });
    expect(rank(withAna, 'zoe')).toBeLessThan(rank(withAna, 'bea'));
    expect(withAna[0].agentId).toBe('zoe');
  });

  it('an already-selected agent is never suggested again', () => {
    const ada = agent({ name: 'Ada', id: 'ada', skills: ['deploy'] });
    const index = buildSuggestionIndex([ada], [], []);
    expect(suggestChannelMembers(index, 'deploy', { selectedAgentIds: ['ada'] })).toEqual([]);
  });
});

describe('prefix matching reaches without overreaching', () => {
  it('a prefix hit scores strictly below an exact hit', () => {
    // "#deploy" should still find `deployment-manager`, but never ahead of an
    // agent whose skill is literally `deploy`. Zara sorts LAST by name, so if
    // the multiplier stopped mattering Avery would lead.
    // MUTATION: set PREFIX_MULTIPLIER to 1.0.
    const avery = agent({ name: 'Avery', id: 'avery', skills: ['deployment-manager'] });
    const zara = agent({ name: 'Zara', id: 'zara', skills: ['deploy'] });
    const index = buildSuggestionIndex([avery, zara], [], []);
    const result = suggestChannelMembers(index, 'deploy');
    expect(result[0].agentId).toBe('zara');
    expect(result[1].agentId).toBe('avery');
  });

  it('#design finds @designer — the match a human makes first', () => {
    const designer = agent({ name: 'Dana', id: 'dana', handle: 'designer' });
    const other = agent({ name: 'Otto', id: 'otto', handle: 'otto' });
    const index = buildSuggestionIndex([designer, other], [], []);
    const [top] = suggestChannelMembers(index, 'design');
    expect(top.agentId).toBe('dana');
    expect(top.reason.label).toBe('@designer');
  });

  it('a query token under 3 characters does not fan out across prefixes', () => {
    // "op" must not drag in `operations`, `openai`, `optimizer` and everything
    // else that happens to start with it. MUTATION: set MIN_PREFIX_QUERY_LENGTH
    // to 1.
    const ops = agent({ name: 'Ops', id: 'ops', skills: ['operations'] });
    const index = buildSuggestionIndex([ops], [], []);
    expect(suggestChannelMembers(index, 'op')[0].matched).toBe(false);
  });
});

describe('agents that cannot answer are never suggested', () => {
  it('a disabled agent is absent even on an exact skill match', () => {
    // Suggesting a disabled agent is suggesting silence.
    // MUTATION: drop the `agent.enabled === false` filter.
    const off = agent({ name: 'Off', id: 'off', skills: ['incidents'], enabled: false });
    const on = agent({ name: 'On', id: 'on' });
    const index = buildSuggestionIndex([off, on], [], []);
    expect(suggestChannelMembers(index, 'incidents').map(r => r.agentId)).toEqual(['on']);
  });

  it('an offline connection does not count as advertising anything', () => {
    const ada = agent({ name: 'Ada', id: 'ada' });
    const offline = { ...connection('ada', ['browse']), status: 'offline' as const };
    const index = buildSuggestionIndex([ada], [offline], []);
    expect(suggestChannelMembers(index, 'browse')[0].matched).toBe(false);
  });
});

describe('the ranking is stable', () => {
  it('same input, same order, ties broken by name', () => {
    // A list that reshuffles between renders reads as broken even when it is
    // not. MUTATION: drop the `a.name.localeCompare(b.name)` tie-break.
    const agents = [
      agent({ name: 'Cy', id: 'cy', skills: ['ops'] }),
      agent({ name: 'Ada', id: 'ada', skills: ['ops'] }),
      agent({ name: 'Bo', id: 'bo', skills: ['ops'] }),
    ];
    const index = buildSuggestionIndex(agents, [], []);
    const first = suggestChannelMembers(index, 'ops').map(r => r.agentId);
    const second = suggestChannelMembers(index, 'ops').map(r => r.agentId);
    expect(first).toEqual(['ada', 'bo', 'cy']);
    expect(second).toEqual(first);
  });

  it('returns at most the requested number', () => {
    const agents = Array.from({ length: 20 }, (_, i) => agent({ name: `A${i}`, skills: ['ops'] }));
    const index = buildSuggestionIndex(agents, [], []);
    expect(suggestChannelMembers(index, 'ops')).toHaveLength(5);
  });
});

describe('suggesting costs nothing the user can feel', () => {
  it('scores 500 agents inside one animation frame', () => {
    // The claim this feature rests on is "no network, no model, one frame".
    // MUTATION: replace the postings lookup with a scan of every agent's full
    // token bag per query token, or drop the binary search for the prefix range.
    const agents = Array.from({ length: 500 }, (_, i) => agent({
      name: `Agent ${i}`,
      skills: [`skill-${i % 40}`, 'shared-skill'],
      tools: [`tool-${i % 25}`],
      description: `Handles ${i % 12} incidents and deployment reviews for team ${i}`,
      system_prompt: `You are agent ${i}. `.repeat(30),
    }));
    const sessions = Array.from({ length: 200 }, (_, i) =>
      session(`c${i}`, [agents[i % 500].id, agents[(i + 7) % 500].id]));
    const index = buildSuggestionIndex(agents, [], sessions);

    const started = performance.now();
    for (let i = 0; i < 20; i += 1) {
      suggestChannelMembers(index, 'incident deployment review team');
    }
    const perCall = (performance.now() - started) / 20;
    expect(perCall).toBeLessThan(16);
  });
});
