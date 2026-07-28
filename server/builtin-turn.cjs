'use strict';

const crypto = require('crypto');

// The builtin agent turn: the tool-use loop, the Anthropic stream, and the
// toolset an in-process agent reaches.
//
// Wave 4 of the server/index.cjs reduction, and the last of it. Owns one piece
// of state — builtinToolsetInstance, a lazy singleton. resetTestState() never
// cleared it and reset() does not either; it is derived from injected deps and
// holds no per-test data.
//
// METERED PER MODEL CALL, NOT PER TURN. streamAnthropicTurn is ONE STEP of the
// loop and runs up to BUILTIN_TOOL_LOOP_MAX_STEPS + 1 times per turn, so the
// accumulator and the recorder both live inside it. Recording per turn
// under-reports a tool-heavy turn by up to 9x, and a usage number nobody can
// tell is wrong is worse than no number.
//
// THE TOOLSET IS SHARED VERBATIM with the external MCP door (mcpToolDeps), so
// what an in-process turn can reach and what an MCP client can reach cannot
// drift apart. That is deliberate: two tool surfaces means two authorization
// surfaces.
//
// Bounded three ways — steps, total calls, and result size — because each is a
// different runaway: a loop that never converges, a step that fans out, and a
// tool that returns a database.

function createBuiltinTurn(deps = {}) {
 const {
  VOICE_HUDDLE_NOTE,
  agentContextFromRow,
  agentRuntimePayload,
  buildAgentActivityDigest,
  buildAgentConnectionCommand,
  buildAgentTurnContext,
  buildDaemonPrompt,
  buildSystemPrompt,
  callProviderOperation,
  continueConversation,
  createAnthropicUsageAccumulator,
  createBuiltinToolset,
  dbQuery,
  enforceWorkspaceRole,
  fenceSkillContent,
  formatElapsedMs,
  getAnthropicApiKey,
  getDb,
  getRegistrationStatus,
  insertActiveAgentJob,
  // The rest of the job + connection + queue surface mcpToolDeps() hands to the
  // toolset. All thunks: these modules are constructed around this one, so a
  // captured binding would be undefined.
  claimMcpJob, submitMcpJobResult, agentStepParts, agentStepContent,
  dispatchTaskAssignment, scheduleTaskQueueDrain, hasMcpPresence,
  findConnectedAgent, updateAgentHeartbeat,
  isAgentEnabled,
  listConfiguredSandboxCredentialKeys,
  listWorkspaceSkills,
  loadChannelIntentNote,
  loadSandboxSkillNote,
  loadSkillContent,
  logMessageActivity,
  mirrorAgentReplyToTaskComment,
  notifyDbSubscribers,
  providerCallRateLimiter,
  recordAnthropicUsage,
  registerAgentRequest,
  resolveAnthropicModel,
  resolveRunTarget,
  resolveWorkThreadParent,
  resolveWorkspaceAgentByHandle,
  roleHasWorkspaceCapability,
  sendWs,
  sessionHasLiveHuddle,
  slugHandle,
 } = deps;

 // Lazy singleton; see the header.
 let builtinToolsetInstance = null;

 // Something a listener hears as the end of a spoken sentence.
 //
 // DELIBERATELY looser than the client's own sentence splitter
 // (src/lib/voiceStream.ts, which rules out decimals and initials): this only
 // decides WHEN the row is written, never what is said, and the two live in
 // different languages so a shared regex would be a copy either way. Firing on a
 // boundary the client then declines costs one extra UPDATE; missing one it would
 // have accepted costs up to BUILTIN_FLUSH_INTERVAL_MS of silence in a live call.
 const SPEAKABLE_BOUNDARY_RE = /[.!?…](\s|$)|[:;]\s/;

 // Floor between streamed content writes. Each one broadcasts to every subscriber
 // of the session, so this is a real cost — it is a floor, not a schedule.
 const BUILTIN_FLUSH_INTERVAL_MS = 250;

 /**
  * Is it time to write the streamed reply to the database?
  *
  * The throttle exists because every write fans out over realtime. But in a voice
  * huddle the write carrying a finished sentence is the one that gets SPOKEN —
  * the browser hands Cartesia each sentence the moment its terminator arrives —
  * so making that particular write wait out the remainder of a 250ms window is
  * up to 250ms of silence on the very first thing the agent says. A completed
  * sentence therefore jumps the queue; everything else still waits its turn.
  *
  * Pure, and exported, because "when does the first sentence reach the listener"
  * is exactly the kind of timing claim that should be a test rather than a
  * paragraph.
  */
 function streamFlushDue({ text, written, lastFlushAt, now, minIntervalMs = BUILTIN_FLUSH_INTERVAL_MS }) {
  const full = String(text || '');
  const done = String(written || '');
  if (!full || full === done) return false;
  if (now - lastFlushAt >= minIntervalMs) return true;
  // A rewrite (not a prefix) is tested whole: there is no meaningful "new tail",
  // and a rewritten block is not the streaming case this shortcut serves.
  const tail = full.startsWith(done) ? full.slice(done.length) : full;
  return SPEAKABLE_BOUNDARY_RE.test(tail);
 }

 // Model calls per turn that may carry tools. Hitting it does NOT truncate the
 // turn: the loop makes ONE further call with the tools removed, so the model has
 // to answer with what it has. Worst case is therefore MAX_STEPS + 1 model calls.
 const BUILTIN_TOOL_LOOP_MAX_STEPS = 8;

 // Tool executions per turn, across all steps. A single response can carry several
 // tool_use blocks, so bounding steps alone does not bound the work. Further calls
 // are refused with a result the model can read, not dropped.
 const BUILTIN_TOOL_LOOP_MAX_CALLS = 24;

 // A tool result is model input, so it is charged for on every subsequent call of
 // the loop. Long results are truncated with a visible marker rather than silently
 // clipped, so the model knows it is not seeing everything.
 const BUILTIN_TOOL_RESULT_MAX_CHARS = 12_000;

 // Told to the model alongside the tools. This REINFORCES the voice-huddle rule
 // (VOICE_HUDDLE_NOTE) rather than competing with it: narration was the symptom of
 // having no tools, and the fix is to call them, still without describing them.
 const BUILTIN_TOOL_NOTE = [
  'You have real workspace tools on this turn. When you need one, MAKE THE TOOL CALL.',
  'Never write out a tool call, its arguments, or its result as prose and continue as though it happened — a described call has not run. If you have not called it, it has not happened.',
  'Never say you have created, posted, updated or fetched anything until a tool has actually returned success for it.',
  `You get at most ${BUILTIN_TOOL_LOOP_MAX_STEPS} rounds of tool use in one turn. Work in as few as you can, and finish with a plain answer for the human.`,
  'If a tool returns an error, read it and either fix the arguments and retry once, or tell the human plainly what you could not do. Do not loop on the same failing call.',
 ].join('\n');

 /** A tool result, rendered as the text the model reads. Bounded — see the cap. */
 function toolResultText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  if (text.length <= BUILTIN_TOOL_RESULT_MAX_CHARS) return text;
  return `${text.slice(0, BUILTIN_TOOL_RESULT_MAX_CHARS)}\n… [truncated: result was ${text.length} characters]`;
 }

 /**
  * Drive a model/tool conversation to a text answer.
  *
  * Deliberately free of the database and of Anthropic: `callModel` and `callTool`
  * are injected, which is what lets the cap, the termination rule and the
  * error-recovery path be tested without a live API key or a live workspace.
  *
  *   callModel({ messages, tools })  -> { text, toolUses, stopReason }
  *   callTool({ name, args, id })    -> { ok: true, value } | { ok: false, error }
  *                                      (never throws — see runToolForIdentity)
  *   onSegment(text)                 -> a finished text block, before its tools run
  *   onToolStart({ name, args, id }) -> a handle passed back to onToolResult
  *   onToolResult(handle, outcome)   -> the same call, now settled
  *
  * Returns `{ text, steps, toolCalls, hitCap }`.
  */
 async function runToolUseLoop({
  messages,
  tools = [],
  callModel,
  callTool,
  onSegment = null,
  onToolStart = null,
  onToolResult = null,
  maxSteps = BUILTIN_TOOL_LOOP_MAX_STEPS,
  maxToolCalls = BUILTIN_TOOL_LOOP_MAX_CALLS,
 }) {
  const convo = Array.isArray(messages) ? messages.slice() : [];
  const hasTools = Array.isArray(tools) && tools.length > 0;
  let toolCalls = 0;
  let steps = 0;
  let text = '';

  while (steps < maxSteps) {
   steps += 1;
   const turn = await callModel({ messages: convo, tools: hasTools ? tools : [] });
   text = turn?.text || '';
   const uses = Array.isArray(turn?.toolUses) ? turn.toolUses : [];
   if (uses.length === 0) return { text, steps, toolCalls, hitCap: false };

   // The text block came BEFORE the tool calls in the model's own output, so it is
   // settled first — that ordering is what makes the transcript read
   // message · chips · message instead of one bubble that grows.
   if (text && onSegment) await onSegment(text);

   convo.push({
    role: 'assistant',
    content: [
     ...(text ? [{ type: 'text', text }] : []),
     ...uses.map((use) => ({ type: 'tool_use', id: use.id, name: use.name, input: use.input || {} })),
    ],
   });

   const results = [];
   for (const use of uses) {
    let outcome;
    if (use.inputError) {
     // The model's own arguments were unparseable. Nothing was called, so this is
     // reported as a failed call rather than executed with a guess.
     outcome = { ok: false, error: use.inputError };
    } else if (toolCalls >= maxToolCalls) {
     outcome = { ok: false, error: `Tool budget for this turn is used up (${maxToolCalls} calls). Answer with what you have.` };
    } else {
     toolCalls += 1;
     const handle = onToolStart ? await onToolStart({ name: use.name, args: use.input || {}, id: use.id }) : null;
     outcome = await callTool({ name: use.name, args: use.input || {}, id: use.id });
     if (onToolResult) await onToolResult(handle, outcome);
    }
    results.push({
     type: 'tool_result',
     tool_use_id: use.id,
     content: outcome.ok ? toolResultText(outcome.value) : String(outcome.error || 'Tool failed'),
     is_error: !outcome.ok,
    });
   }
   convo.push({ role: 'user', content: results });
  }

  // Out of steps and the model still wanted a tool. Ask once more with NO tools
  // attached so it has to answer — a turn that ends here must still say something,
  // not leave the human with a wall of chips and no reply.
  const closing = await callModel({ messages: convo, tools: [] });
  return { text: closing?.text || '', steps: steps + 1, toolCalls, hitCap: true };
 }

 // The backend capabilities every workspace tool is given, whichever door invoked
 // it. Single-sourced so the MCP endpoint and the builtin loop cannot end up
 // handing the same tool two different sets of primitives — the transport-only
 // deps (token verification, rate limiting) are added at the MCP call site.
 function mcpToolDeps() {
  return {
   getDb,
   continueConversation,
   notifyDbSubscribers,
   slugHandle,
   claimMcpJob,
   submitMcpJobResult,
   dispatchTaskAssignment,
   resolveWorkspaceAgentByHandle,
   registerAgentRequest,
   getRegistrationStatus,
   getAgentConnectionCommand: buildAgentConnectionCommand,
   enforceWorkspaceRole,
   roleHasWorkspaceCapability,
   // The credential-injecting provider proxy. Passed in (rather than reached for)
   // so mcp.cjs stays unit-testable with a mocked fetch and no live provider.
   callProviderOperation,
   providerCallRateLimiter,
   // The skill layer, injected the same way and for the same reason. `list_skills`
   // and `read_skill` share these with the browser route, so an agent and a human
   // can never be shown different text for the same skill.
   listWorkspaceSkills,
   loadSkillContent: (db, workspaceId, skill) => loadSkillContent({
    db,
    workspaceId,
    skill,
    listConfiguredCredentialKeys: listConfiguredSandboxCredentialKeys,
   }),
   fenceSkillContent,
  };
 }

 function getBuiltinToolset() {
  if (!builtinToolsetInstance) builtinToolsetInstance = createBuiltinToolset(mcpToolDeps());
  return builtinToolsetInstance;
 }

 /**
  * The identity a builtin turn's tool calls run as, or NULL.
  *
  * Identical in shape to what `verifyAgentConnectToken` hands the MCP door, and
  * built the same way: from the agent ROW. `workspaceId` is the agent's own
  * column, never a value that travelled with the request — which is what makes
  * cross-workspace access structurally impossible rather than merely checked.
  *
  * FAILS CLOSED, and that is the point. A row with no `workspace_id` (a select
  * that forgot the column — this repo has shipped that exact bug more than once)
  * or one that disagrees with the workspace the turn is running in returns null,
  * and the caller runs the turn with NO tools rather than with tools pointed at a
  * workspace nobody can name. Losing tools is a visibly worse answer; guessing a
  * tenant is a breach.
  */
 function builtinToolIdentity(agent, expectedWorkspaceId = null) {
  const workspaceId = agent && agent.workspace_id ? String(agent.workspace_id) : '';
  if (!workspaceId) return null;
  if (expectedWorkspaceId && workspaceId !== String(expectedWorkspaceId)) return null;
  return {
   kind: 'agent',
   agentId: agent.id,
   workspaceId,
   name: agent.name,
   handle: agent.handle || slugHandle(agent.name),
   agent: agentRuntimePayload(agent),
  };
 }

 /** `read_channel · {"channel_id":"…"}`, bounded — the chip label for one call. */
 function builtinStepDetail(args) {
  let text;
  try {
   text = JSON.stringify(args ?? {});
  } catch {
   text = '';
  }
  if (!text || text === '{}') return '';
  return text.replace(/\s+/g, ' ').slice(0, 200);
 }

 const AMP_THREAD_ID_RE = /^T-[A-Za-z0-9-]{20,100}$/;

 function isAmpRuntimeAgent(agent) {
  return String(agent?.metadata?.runtime || '').trim().toLowerCase() === 'amp';
 }

 function connectionSupportsAmpRuntime(connection) {
  return connection?.capabilities?.runtimes?.amp?.id === 'amp';
 }

 function validAmpThreadId(value) {
  const threadId = String(value || '').trim();
  return AMP_THREAD_ID_RE.test(threadId) ? threadId : '';
 }

 // An Amp thread belongs to one Agensis conversation lane, not merely to the
 // agent. The same Amp agent can be working in several channels and threads at
 // once; reusing its newest thread globally would cross-contaminate all of them.
 async function loadAmpThreadBinding({ workspaceId, agentId, sessionId, threadParentId = null }) {
  const rows = await getDb().unsafe(
   `select metadata from agent_jobs
      where workspace_id = $1
        and agent_id = $2
        and session_id = $3
        and (status = 'done' or (status = 'error' and coalesce(metadata->>'ampThreadId', '') <> ''))
        and metadata->>'runtime' = 'amp'
        and coalesce(metadata->>'ampLaneThreadParentId', metadata->>'threadParentId', '') = $4
      order by finished_at desc nulls last, created_at desc
      limit 1`,
   [workspaceId, agentId, sessionId, threadParentId ? String(threadParentId) : ''],
  );
  const metadata = rows[0]?.metadata && typeof rows[0].metadata === 'object'
   ? rows[0].metadata
   : {};
  const ampThreadId = validAmpThreadId(metadata.ampThreadId);
  if (rows.length > 0 && !ampThreadId) {
   // A lane that already acquired an Amp binding but lost/corrupted it is not
   // a new lane. Mark continuation as required so the daemon refuses rather
   // than silently creating a replacement orb with unrelated context.
   return { id: 'amp', continuationRequired: true };
  }
  return ampThreadId
   ? { id: 'amp', continuationRequired: true, threadId: ampThreadId, threadUrl: `https://ampcode.com/threads/${ampThreadId}` }
   : { id: 'amp' };
 }

 async function runAgentTurn(agent, { workspaceId, sessionId, threadParentId = null, createdBy = null, coParticipants = [] }) {
  if (!isAgentEnabled(agent)) return { ok: false, pending: false };
  const handle = slugHandle(agent.handle || agent.name);
  const runMode = resolveRunTarget(agent);
  const contextMessages = await buildAgentTurnContext(sessionId, agent, threadParentId);
  // The agent works in a thread and only broadcasts its answer. A turn seeded at
  // channel level opens (or re-uses) the thread on the human message that started
  // it, so the "Thinking …" placeholder, its tool chips and its intermediate text
  // blocks all land there; the final answer is flagged broadcast_to_channel so
  // that — and only that — surfaces in the channel view. A turn already running
  // inside a thread keeps working there and broadcasts nothing, as before.
  // ACCEPTED TRADEOFF: while the agent works, the channel shows only the human's
  // message and its reply count. There is deliberately no channel-level
  // "working…" row.
  const workThread = threadParentId
   ? { parentId: threadParentId, broadcast: false }
   : await resolveWorkThreadParent(sessionId);
  const workThreadParentId = workThread.parentId;
  const broadcastToChannel = workThread.broadcast;
  const agentContext = agentContextFromRow(agent, coParticipants);
  const recentActivity = await buildAgentActivityDigest(workspaceId, agent.id, sessionId);
  if (recentActivity && agentContext) {
   agentContext.systemPrompt = `${agentContext.systemPrompt}\n\n<your_recent_activity>\nYou are one continuous agent across this workspace's DMs and channels. Recent activity elsewhere (reference it when asked what you're working on):\n${recentActivity}\n</your_recent_activity>`.trim();
  }
  // Someone is on a voice call in this conversation, so this turn will be spoken
  // out loud. Every lane below gets the same note — builtin through the system
  // prompt, daemon/MCP/external through the daemon prompt.
  const voiceHuddle = await sessionHasLiveHuddle(sessionId);
  if (voiceHuddle && agentContext) {
   agentContext.systemPrompt = `${agentContext.systemPrompt}\n\n<voice_huddle>\n${VOICE_HUDDLE_NOTE}\n</voice_huddle>`.trim();
  }
  // The channel's house style, for every lane: builtin through the system
  // prompt, daemon/MCP/external through the daemon prompt.
  const intentNote = await loadChannelIntentNote(sessionId);
  // The sandbox provisioning skill layer, for a Sandbox Agent. '' for every other
  // agent, so this costs one pure array check per turn and no query.
  const sandboxSkillNote = await loadSandboxSkillNote(workspaceId, agent);
  if (sandboxSkillNote && agentContext) {
   agentContext.systemPrompt = `${agentContext.systemPrompt}\n\n${sandboxSkillNote}`.trim();
  }
  if (intentNote && agentContext) {
   agentContext.systemPrompt = `${agentContext.systemPrompt}\n\n<channel_intent>\n${intentNote}\n</channel_intent>`.trim();
  }

  // If one or more MCP clients are working AS this agent (joined via the invite link and
  // polling claim_job), serve this turn through the pull queue: enqueue a job; whichever
  // client claims it answers. Takes precedence over builtin/daemon. This is what makes
  // "@q answers via MCP" and "3× Q all working as Q" work, with zero per-agent config.
  if (hasMcpPresence(agent.id)) {
   const responseMessageId = crypto.randomUUID();
   const pendingRows = await getDb().unsafe(
    `insert into messages (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name)
        values ($1, $2, 'assistant', 'Thinking 0s', $3, 'agent', $4, $5)
        returning *`,
    [responseMessageId, sessionId, workThreadParentId, String(agent.id), agent.name],
   );
   notifyDbSubscribers('messages', 'INSERT', pendingRows);
   const prompt = buildDaemonPrompt(contextMessages, agent, coParticipants, recentActivity, voiceHuddle, intentNote, sandboxSkillNote);
   const jobRows = await insertActiveAgentJob(
    `insert into agent_jobs (workspace_id, agent_id, session_id, created_by, prompt, status, metadata)
        values ($1, $2, $3, $4, $5, 'queued', $6::jsonb)
        returning *`,
    [
     workspaceId, agent.id, sessionId, createdBy, prompt,
     // Pass the OBJECT (not JSON.stringify'd): postgres.js encodes it as a real jsonb
     // object, so `metadata->>'mode'` in claimMcpJob/reaper matches. JSON.stringify here
     // would double-encode into a jsonb STRING scalar and the SQL key lookup returns null.
     //
     // threadParentId stays the DISPATCH level (null for a channel turn) so
     // continueConversation resumes where the human is talking; workThreadParentId
     // is where the agent's own messages live, and broadcastToChannel tells
     // finalizeAgentJobResult to flag the final answer for the channel view.
     { handle, threadParentId: threadParentId || null, workThreadParentId, broadcastToChannel, responseMessageId, mode: 'mcp' },
    ],
    responseMessageId,
   );
   if (!jobRows) return { ok: false, pending: true }; // a concurrent turn won the race
   notifyDbSubscribers('agent_jobs', 'INSERT', jobRows);
   return { ok: true, pending: true }; // a polling client will claim it; conversation resumes on submit
  }

  // An 'external' agent with no live MCP poller. Do NOT fall through to the
  // builtin lane: that answers as the agent using the workspace's own model, and
  // the reply is indistinguishable from the registered client — which reads as a
  // working agent when nothing is attached. That is worse than silence, because
  // the human acts on it. Queue the turn (a client that reconnects will claim it)
  // and post a clearly-attributed stand-in notice instead of impersonating.
  if (runMode === 'external') {
   const jobRows = await insertActiveAgentJob(
    `insert into agent_jobs (workspace_id, agent_id, session_id, created_by, prompt, status, metadata)
        values ($1, $2, $3, $4, $5, 'queued', $6::jsonb)
        returning *`,
    [
     workspaceId, agent.id, sessionId, createdBy,
     buildDaemonPrompt(contextMessages, agent, coParticipants, recentActivity, voiceHuddle, intentNote, sandboxSkillNote),
     { handle, threadParentId: threadParentId || null, workThreadParentId, broadcastToChannel, mode: 'mcp' },
    ],
   );
   if (jobRows) notifyDbSubscribers('agent_jobs', 'INSERT', jobRows);
   // "Nobody is attached" is not a working note — it is the answer the human has to
   // act on, so it is broadcast rather than buried in the work thread. Same for
   // every other stand-in notice below: silence in the channel would read as a
   // working agent.
   const noticeRows = await getDb().unsafe(
    `insert into messages (session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name, broadcast_to_channel)
        values ($1, 'assistant', $2, $3, 'agent', $4, $5, $6)
        returning *`,
    [
     sessionId,
     `_@${handle} is an MCP client and is not attached right now, so nobody has answered this yet._\n\nYour message is queued — it will be picked up when that client next connects. This notice is from agensis, not from @${handle}.`,
     workThreadParentId,
     String(agent.id),
     agent.name,
     broadcastToChannel,
    ],
   );
   notifyDbSubscribers('messages', 'INSERT', noticeRows);
   return { ok: true, pending: true };
  }

  if (runMode === 'builtin') {
   const jobRows = await insertActiveAgentJob(
    `insert into agent_jobs (workspace_id, agent_id, session_id, created_by, prompt, status, started_at, metadata)
        values ($1, $2, $3, $4, $5, 'running', now(), $6::jsonb)
        returning *`,
    // Object, not JSON.stringify — same double-encode trap as the daemon insert below.
    [workspaceId, agent.id, sessionId, createdBy, '', { handle, threadParentId: threadParentId || null, workThreadParentId, broadcastToChannel, mode: 'builtin' }],
   );
   if (!jobRows) return { ok: false, pending: true }; // a concurrent turn won the race
   notifyDbSubscribers('agent_jobs', 'INSERT', jobRows);
   // Insert a 'Thinking' placeholder first, then stream the built-in reply into it
   // token-by-token (message UPDATE broadcasts) so it renders live in the thread
   // like a daemon agent — instead of popping in complete when the call finishes.
   const responseMessageId = crypto.randomUUID();
   const placeholderRows = await getDb().unsafe(
    `insert into messages (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name)
         values ($1, $2, 'assistant', 'Thinking 0s', $3, 'agent', $4, $5)
         returning *`,
    [responseMessageId, sessionId, workThreadParentId, String(agent.id), agent.name],
   );
   notifyDbSubscribers('messages', 'INSERT', placeholderRows);
   // The turn's tools and the identity they run as. Built from the agent ROW, so
   // every tool call is scoped to the agent's OWN workspace — see
   // builtinToolIdentity. `specs` is a projection of the same list the MCP
   // endpoint serves, filtered by the same `kinds`/scope rules.
   const toolset = getBuiltinToolset();
   const toolIdentity = builtinToolIdentity(agent, workspaceId);
   if (!toolIdentity) {
    console.warn('[agensis] builtin turn running without tools: agent row has no usable workspace', agent.id);
   }
   const toolSpecs = toolIdentity ? toolset.specs(toolIdentity) : [];
   const turnStartedAt = Date.now();
   // Only this lane gets the note — the daemon/MCP/external lanes build their
   // prompt from buildDaemonPrompt and run their own tools, and this branch is
   // reached after all of them, so agentContext cannot leak into one.
   if (toolSpecs.length > 0 && agentContext) {
    agentContext.systemPrompt = `${agentContext.systemPrompt}\n\n<tools>\n${BUILTIN_TOOL_NOTE}\n</tools>`.trim();
   }
   let writeChain = Promise.resolve();
   let writing = false;
   // Declared out here with writeChain/writing because the catch below sets it:
   // once the stream is over — successfully or not — the terminal write owns the
   // row and no throttled partial may land behind it.
   let finished = false;
   // The row currently being streamed into. A turn with tools is really
   // [text][tool][text][tool][text], so each finished text block is SEALED into
   // its own message and the next block gets a fresh row — the same shape
   // handleAgentJobSegment gives a daemon turn, for the same reason: one bubble
   // that grows swallows five separate thoughts with no boundary a human can read.
   //
   // Null between blocks. The replacement row is created LAZILY, by the first
   // delta that actually has text for it, so a long run of tool calls does not
   // leave an empty "Thinking …" bubble parked in the thread.
   //
   // Out here with the rest because the FAILURE path needs it too: once a block
   // has been sealed, the dispatch placeholder is a finished message, and writing
   // the error over it would destroy something the agent actually said.
   let currentMessageId = responseMessageId;
   try {
    // Throttle + serialize DB writes: at most one update in flight at a time and
    // no more than ~4x/sec, always writing the LATEST accumulated text. Because
    // each delta carries the full text so far, awaiting the in-flight write (in
    // both the success and error paths) prevents a late partial from clobbering
    // the final content.
    //
    // TWO exceptions to the throttle, both for voice (see streamFlushDue):
    //   - a write that completes a SENTENCE goes immediately, because that is the
    //     write a huddle speaks;
    //   - a write skipped because another was in flight is retried when that one
    //     settles, instead of waiting for a delta that may never come — the last
    //     sentence of a reply used to sit unwritten until the stream ended.
    let latest = '';
    let written = '';
    let lastFlush = 0;
    let flushQueued = false;
    // Set while a block is being sealed, so a queued flush cannot write into the
    // row after it has become a finished message (or into a null id).
    let sealing = false;
    const flush = () => {
     // Past the end of the stream the final write below is authoritative; a
     // straggler here would overwrite it (and, on the error path, replace the
     // error with a partial reply).
     if (finished || sealing) return;
     if (writing) { flushQueued = true; return; }
     if (!streamFlushDue({ text: latest, written, lastFlushAt: lastFlush, now: Date.now() })) return;
     writing = true;
     lastFlush = Date.now();
     const target = latest;
     const write = (async () => {
      try {
       if (currentMessageId) {
        const rows = await getDb().unsafe(
         `update messages set content = $2 where id = $1 and session_id = $3 returning *`,
         [currentMessageId, target || 'Thinking…', sessionId],
        );
        if (rows.length > 0) notifyDbSubscribers('messages', 'UPDATE', rows);
       } else {
        // Materialise the next block's row now that there is something to show.
        const nextId = crypto.randomUUID();
        const rows = await getDb().unsafe(
         `insert into messages (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name)
              values ($1, $2, 'assistant', $3, $4, 'agent', $5, $6) returning *`,
         [nextId, sessionId, target || 'Thinking…', workThreadParentId, String(agent.id), agent.name],
        );
        currentMessageId = nextId;
        if (rows.length > 0) notifyDbSubscribers('messages', 'INSERT', rows);
       }
       // Only after the write landed: a failed one has not been written, and the
       // next flush must still be allowed to try this text again.
       written = target;
      } finally {
       writing = false;
       if (flushQueued) {
        flushQueued = false;
        flush();
       }
      }
     })();
     // Absorbed here, not only at the awaits below: the finally above can replace
     // `writeChain` with a fresh promise before this one settles, and a rejection
     // nobody is holding becomes an unhandledRejection in a long-lived server. The
     // awaits at the end of the turn are what order the writes; this only makes
     // sure the error cannot escape. The terminal write is authoritative either way.
     write.catch(() => { });
     writeChain = write;
    };

    // A text block is finished (the model went on to call tools). Settle the row
    // it was streaming into and hand the next block a clean slate.
    const sealSegment = async (text) => {
     sealing = true;
     await writeChain.catch(() => { });
     try {
      if (currentMessageId) {
       const rows = await getDb().unsafe(
        `update messages set content = $2 where id = $1 and session_id = $3 returning *`,
        [currentMessageId, text, sessionId],
       );
       if (rows.length > 0) notifyDbSubscribers('messages', 'UPDATE', rows);
      } else {
       const rows = await getDb().unsafe(
        `insert into messages (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name)
             values ($1, $2, 'assistant', $3, $4, 'agent', $5, $6) returning *`,
        [crypto.randomUUID(), sessionId, text, workThreadParentId, String(agent.id), agent.name],
       );
       if (rows.length > 0) notifyDbSubscribers('messages', 'INSERT', rows);
      }
     } finally {
      currentMessageId = null;
      latest = '';
      written = '';
      lastFlush = 0;
      flushQueued = false;
      sealing = false;
     }
    };

    // One tool call, surfaced. These are the SAME `tool_step` rows a daemon turn
    // writes (handleAgentJobStep) — same discriminator, same tool_name/tool_detail
    // columns, same chip rendering — so a builtin turn shows its work in the UI
    // that already exists rather than in a second style of its own.
    //
    // They hang off workThreadParentId, i.e. as SIBLINGS of the reply inside the
    // work thread, exactly where the daemon path resolves them to. Falling back to
    // the placeholder's own id keeps a session with no work thread behaving as
    // before.
    const stepParentId = workThreadParentId || responseMessageId;
    const insertToolStep = async (rawName, rawDetail) => {
     // Normalised through the same agentStepParts the daemon path uses, so the
     // `content` fallback line and the two structured columns can never disagree.
     const step = agentStepParts({ name: rawName, detail: rawDetail });
     const rows = await getDb().unsafe(
      `insert into messages (session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name, message_kind, tool_name, tool_detail)
           values ($1, 'assistant', $2, $3, 'agent', $4, $5, 'tool_step', $6, $7) returning *`,
      [sessionId, agentStepContent(step), stepParentId, String(agent.id), agent.name, step.name, step.detail],
     );
     if (rows.length > 0) notifyDbSubscribers('messages', 'INSERT', rows);
     return rows[0] ? rows[0].id : null;
    };

    const responseText = await (async () => {
     const loop = await runToolUseLoop({
      messages: contextMessages.length > 0 ? contextMessages : [{ role: 'user', content: '(no message)' }],
      tools: toolSpecs,
      async callModel({ messages, tools }) {
       return streamAnthropicTurn({
        model: resolveAnthropicModel(agent.model),
        messages,
        memory: null,
        documents: null,
        workspaceContext: null,
        agentContext,
        tools,
        workspaceId,
       }, (partial) => { latest = partial; flush(); });
      },
      // runToolForIdentity never throws: a tool that blows up comes back as
      // { ok: false, error } and the loop hands that to the model as a readable
      // tool_result it can recover from, instead of killing the turn.
      async callTool({ name, args }) {
       return toolset.call({ name, args, identity: toolIdentity, db: getDb() });
      },
      onSegment: sealSegment,
      async onToolStart({ name, args }) {
       // Keep the placeholder's clock honest while a slow tool runs — but only
       // while it still holds a status line. Never write over streamed text.
       if (currentMessageId && !latest) {
        const rows = await getDb().unsafe(
         `update messages set content = $2 where id = $1 and session_id = $3 returning *`,
         [currentMessageId, `Thinking ${formatElapsedMs(Date.now() - turnStartedAt)}`, sessionId],
        ).catch(() => []);
        if (rows.length > 0) notifyDbSubscribers('messages', 'UPDATE', rows);
       }
       // The chip carries the tool's NAME and the agent's own arguments. It never
       // carries a result: a tool result can be untrusted provider text, and the
       // chip is chrome the human reads at a glance.
       return { name, id: await insertToolStep(name, builtinStepDetail(args)) };
      },
      async onToolResult(handle, outcome) {
       if (!handle || !handle.id || outcome.ok) return;
       // A failed call says so on its own chip, so a turn that quietly gave up on
       // a tool is visible rather than inferred from a vague reply. The error TEXT
       // stays out of the chip and goes to the model only — a tool result can be
       // untrusted provider output, and a chip is chrome the human reads at a glance.
       const rows = await getDb().unsafe(
        `update messages set content = $2, tool_detail = $3 where id = $1 and session_id = $4 returning *`,
        [handle.id, agentStepContent({ name: handle.name, detail: 'failed' }), 'failed', sessionId],
       ).catch(() => []);
       if (rows.length > 0) notifyDbSubscribers('messages', 'UPDATE', rows);
      },
     });
     return loop.text;
    })();
    // The stream is over, so the writes below own the row from here.
    finished = true;
    const updatedRows = await getDb().unsafe(
     `update agent_jobs set status = 'done', response = $2, finished_at = now(), updated_at = now() where id = $1 returning *`,
     [jobRows[0].id, responseText],
    );
    notifyDbSubscribers('agent_jobs', 'UPDATE', updatedRows);
    // A builtin turn finalizes its own job here and never reaches
    // finalizeAgentJobResult, so this is its own terminal hook for the task queue.
    scheduleTaskQueueDrain(workspaceId, agent.id, 'builtin_done');
    // Wait for any in-flight throttled write to finish, THEN write the complete
    // text last so it can never be clobbered by a late-landing partial update.
    await writeChain.catch(() => { });
    // The turn is over: this row IS the answer, so it graduates out of the work
    // thread into the channel view (it stays a thread message — the flag only adds
    // it to the channel). The throttled partial writes above deliberately leave the
    // flag alone, which is what keeps the channel quiet while the agent works.
    const finalText = responseText || `@${handle} finished without output.`;
    const messageRows = currentMessageId
     ? await getDb().unsafe(
      `update messages set content = $2, broadcast_to_channel = $4 where id = $1 and session_id = $3 returning *`,
      [currentMessageId, finalText, sessionId, broadcastToChannel],
     )
     // Every block was sealed and the last round produced no delta to materialise
     // a row — the answer still has to exist, and it is what gets broadcast.
     : await getDb().unsafe(
      `insert into messages (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name, broadcast_to_channel)
           values ($1, $2, 'assistant', $3, $4, 'agent', $5, $6, $7) returning *`,
      [crypto.randomUUID(), sessionId, finalText, workThreadParentId, String(agent.id), agent.name, broadcastToChannel],
     );
    if (messageRows.length > 0) {
     notifyDbSubscribers('messages', currentMessageId ? 'UPDATE' : 'INSERT', messageRows);
     void logMessageActivity(messageRows);
     void mirrorAgentReplyToTaskComment(messageRows[0]);
    }
    return { ok: true, pending: false };
   } catch (error) {
    // Let any in-flight partial write settle so it can't clobber the error text —
    // and stop any further one from being started behind it.
    finished = true;
    await writeChain.catch(() => { });
    const errorText = error?.message || 'Built-in agent failed';
    const updatedRows = await getDb().unsafe(
     `update agent_jobs set status = 'error', error = $2, finished_at = now(), updated_at = now() where id = $1 returning *`,
     [jobRows[0].id, errorText],
    );
    notifyDbSubscribers('agent_jobs', 'UPDATE', updatedRows);
    scheduleTaskQueueDrain(workspaceId, agent.id, 'builtin_error');
    // A failure is the outcome of the turn, so it broadcasts too — a channel that
    // silently shows nothing reads as "still working" forever.
    //
    // Written into the LIVE row, never blindly into the dispatch placeholder: once
    // a text block has been sealed, that placeholder is a finished message the
    // agent actually said, and overwriting it with the error would destroy it. With
    // no live row the notice is a new message of its own.
    const noticeText = `@${handle} failed: ${errorText}`;
    const messageRows = currentMessageId
     ? await getDb().unsafe(
      `update messages set content = $2, broadcast_to_channel = $4 where id = $1 and session_id = $3 returning *`,
      [currentMessageId, noticeText, sessionId, broadcastToChannel],
     )
     : await getDb().unsafe(
      `insert into messages (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name, broadcast_to_channel)
           values ($1, $2, 'assistant', $3, $4, 'agent', $5, $6, $7) returning *`,
      [crypto.randomUUID(), sessionId, noticeText, workThreadParentId, String(agent.id), agent.name, broadcastToChannel],
     );
    if (messageRows.length > 0) notifyDbSubscribers('messages', currentMessageId ? 'UPDATE' : 'INSERT', messageRows);
    return { ok: false, pending: false };
   }
  }

  const connection = findConnectedAgent(workspaceId, agent.id, agent.handle || agent.name);
  if (!connection) {
   const assistantRows = await getDb().unsafe(
    `insert into messages (session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name, broadcast_to_channel)
        values ($1, 'assistant', $2, $3, 'agent', $4, $5, $6)
        returning *`,
    [
     sessionId,
     `@${handle} is configured, but no daemon is connected. Open AI Agents, copy its connection command, and run it where the agent should execute.`,
     workThreadParentId,
     String(agent.id),
     agent.name,
     broadcastToChannel,
    ],
   );
   notifyDbSubscribers('messages', 'INSERT', assistantRows);
   return { ok: false, pending: false };
  }

  // Runtime selection is a cross-version protocol boundary. An older daemon
  // does not understand job.runtime and would run this prompt through its normal
  // coding CLI. Refuse before creating or dispatching a job unless this exact
  // live connection has advertised Amp support; the daemon's own preflight then
  // owns the more specific installed/auth/project/setup failure.
  if (isAmpRuntimeAgent(agent) && !connectionSupportsAmpRuntime(connection)) {
   const assistantRows = await getDb().unsafe(
    `insert into messages (session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name, broadcast_to_channel)
        values ($1, 'assistant', $2, $3, 'agent', $4, $5, $6)
        returning *`,
    [
     sessionId,
     `@${handle} cannot start an Amp orb because the connected agensis-agent has not advertised Amp support yet. Wait for capabilities to sync, or update agensis-agent and reconnect.`,
     workThreadParentId,
     String(agent.id),
     agent.name,
     broadcastToChannel,
    ],
   );
   notifyDbSubscribers('messages', 'INSERT', assistantRows);
   return { ok: false, pending: false };
  }

  const responseMessageId = crypto.randomUUID();
  const pendingMessageRows = await getDb().unsafe(
   `insert into messages (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name)
      values ($1, $2, 'assistant', 'Thinking 0s', $3, 'agent', $4, $5)
      returning *`,
   [responseMessageId, sessionId, workThreadParentId, String(agent.id), agent.name],
  );
  notifyDbSubscribers('messages', 'INSERT', pendingMessageRows);

  const daemonPrompt = buildDaemonPrompt(contextMessages, agent, coParticipants, recentActivity, voiceHuddle, intentNote, sandboxSkillNote);
  const ampRuntime = isAmpRuntimeAgent(agent)
   ? await loadAmpThreadBinding({ workspaceId, agentId: agent.id, sessionId, threadParentId: workThreadParentId })
   : null;
  const jobRows = await insertActiveAgentJob(
   `insert into agent_jobs (workspace_id, agent_id, connection_id, session_id, created_by, prompt, status, started_at, metadata)
      values ($1, $2, $3, $4, $5, $6, 'running', now(), $7::jsonb)
      returning *`,
   [
    workspaceId,
    agent.id,
    connection.connectionId,
    sessionId,
    createdBy,
    daemonPrompt,
    // Pass the OBJECT (not JSON.stringify'd) — see the identical note on the MCP
    // insert above. Stringifying binds a jsonb STRING scalar, so every delta's
    // `metadata || ...` APPENDED instead of merging and metadata became an array;
    // metadata->>'responseMessageId' then returned null and finalizeStuckJob could
    // never clear the "Thinking …" placeholder, hanging the thread forever.
    {
     handle,
     threadParentId: threadParentId || null,
     workThreadParentId,
     broadcastToChannel,
     responseMessageId,
     mode: 'daemon',
     ...(ampRuntime ? {
      runtime: 'amp',
      ampLaneThreadParentId: workThreadParentId || null,
      ...(ampRuntime.threadId ? { ampThreadId: ampRuntime.threadId, ampThreadUrl: ampRuntime.threadUrl } : {}),
     } : {}),
    },
   ],
   responseMessageId,
  );
  if (!jobRows) return { ok: false, pending: true }; // a concurrent turn won the race
  notifyDbSubscribers('agent_jobs', 'INSERT', jobRows);
  await updateAgentHeartbeat(connection.ws, { busy: true }).catch(() => { });
  const agentPayload = agentRuntimePayload(agent);
  sendWs(connection.ws, {
   type: 'agent_job',
   job: {
    id: jobRows[0].id,
    workspaceId,
    sessionId,
    threadParentId: threadParentId || null,
    prompt: daemonPrompt,
    handle,
    model: agentPayload.model,
    permissionMode: agentPayload.permissionMode,
    permission_mode: agentPayload.permission_mode,
    permissionFlags: agentPayload.permissionFlags,
    agent: agentPayload,
    ...(ampRuntime ? { runtime: ampRuntime } : {}),
    responseMessageId,
   },
  });
  return { ok: true, pending: true };
 }

 async function runAnthropicCompletion({ model, messages, memory, documents, workspaceContext, agentContext, workspaceId = null, usageKind = 'completion' }) {
  const apiKey = await getAnthropicApiKey(workspaceId);
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  const resolvedModel = resolveAnthropicModel(model);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
   method: 'POST',
   headers: {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
   },
   body: JSON.stringify({
    model: resolvedModel,
    max_tokens: 4096,
    messages: Array.isArray(messages) ? messages.map((m) => ({ role: m.role, content: m.content })) : [],
    system: buildSystemPrompt(memory, documents, workspaceContext, agentContext),
   }),
  });

  if (!response.ok) {
   throw new Error(await response.text());
  }

  const payload = await response.json();
  // Metered from the API's OWN reported usage, never estimated from the text.
  // Awaited rather than fire-and-forget so a caller's own error handling cannot
  // race the write; it cannot throw, so awaiting costs only the insert.
  await recordAnthropicUsage(dbQuery, {
   workspaceId,
   model: resolvedModel,
   kind: usageKind,
   usage: payload.usage,
  });
  return (payload.content || [])
   .map((part) => part?.type === 'text' ? part.text : '')
   .filter(Boolean)
   .join('\n');
 }

 /**
  * ONE streamed Anthropic turn, tool-use aware.
  *
  * Streams the SSE response, invoking onDelta(fullTextSoFar) as TEXT accumulates,
  * and separately assembles any `tool_use` blocks the model emits. Returns
  * `{ text, toolUses, stopReason }` — the caller decides whether to run the tools
  * and come back (see runToolUseLoop) or to stop.
  *
  * Tool-use arrives as its own content block: `content_block_start` names the tool
  * and its id, then a run of `input_json_delta` frames carries the arguments as
  * PARTIAL JSON which is only parseable once the block stops. A block whose JSON
  * never parses is surfaced with `{}` arguments plus `inputError`, so the caller
  * can hand the model a readable failure instead of silently calling a tool with
  * the wrong arguments.
  *
  * `messages[].content` is passed through untouched: a plain string for ordinary
  * chat, or an array of content blocks once the loop starts appending assistant
  * tool_use / user tool_result turns.
  */
 async function streamAnthropicTurn({ model, messages, memory, documents, workspaceContext, agentContext, tools = null, maxTokens = 4096, workspaceId = null, usageKind = 'builtin_turn' }, onDelta) {
  const apiKey = await getAnthropicApiKey(workspaceId);
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  const resolvedModel = resolveAnthropicModel(model);
  const payload = {
   model: resolvedModel,
   max_tokens: maxTokens,
   stream: true,
   messages: Array.isArray(messages) ? messages.map((m) => ({ role: m.role, content: m.content })) : [],
   system: buildSystemPrompt(memory, documents, workspaceContext, agentContext),
  };
  // Omitted entirely when empty — an empty `tools: []` is not the same request as
  // no tools at all, and the final "answer now" call of the loop depends on the
  // model having no tool to reach for.
  if (Array.isArray(tools) && tools.length > 0) payload.tools = tools;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
   method: 'POST',
   headers: {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
   },
   body: JSON.stringify(payload),
  });

  if (!response.ok || !response.body) {
   throw new Error(await response.text().catch(() => 'Anthropic stream failed'));
  }

  let full = '';
  let buffer = '';
  let stopReason = '';
  // ONE model call is ONE usage row, and this function is called once per step of
  // the builtin tool loop — up to BUILTIN_TOOL_LOOP_MAX_STEPS + 1 times in a
  // single human turn. That multiplier is exactly why metering lives here rather
  // than around the loop: recording once per turn would under-report a
  // tool-heavy turn by up to 9x, and the tool-heavy turns are the expensive ones.
  const usage = createAnthropicUsageAccumulator();
  // Blocks are addressed by index across the whole message, and text and tool_use
  // blocks share that numbering, so they are tracked in one map and split apart at
  // the end rather than assumed to arrive in any particular order.
  const blocks = new Map();
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
   buffer += decoder.decode(chunk, { stream: true });
   // SSE frames are separated by a blank line; each frame has a `data:` line.
   let sep;
   while ((sep = buffer.indexOf('\n\n')) !== -1) {
    const frame = buffer.slice(0, sep);
    buffer = buffer.slice(sep + 2);
    const line = frame.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
     const parsed = JSON.parse(data);
     // Fed EVERY frame — the accumulator picks out message_start (input and
     // cache tokens) and message_delta (the running output total) and ignores
     // the rest, so no frame handler below has to know about billing.
     usage.event(parsed);
     if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
      blocks.set(parsed.index, {
       id: String(parsed.content_block.id || ''),
       name: String(parsed.content_block.name || ''),
       json: '',
      });
      continue;
     }
     if (parsed.type === 'content_block_delta') {
      if (parsed.delta?.type === 'text_delta') {
       full += parsed.delta.text || '';
       if (onDelta) onDelta(full);
       continue;
      }
      if (parsed.delta?.type === 'input_json_delta') {
       const block = blocks.get(parsed.index);
       if (block) block.json += parsed.delta.partial_json || '';
      }
      continue;
     }
     if (parsed.type === 'message_delta' && parsed.delta?.stop_reason) {
      stopReason = String(parsed.delta.stop_reason);
     }
    } catch { /* ignore malformed chunk */ }
   }
  }

  const toolUses = [];
  for (const index of [...blocks.keys()].sort((a, b) => a - b)) {
   const block = blocks.get(index);
   if (!block.name) continue; // a tool_use block with no tool is not a call
   const raw = block.json.trim();
   let input = {};
   let inputError = '';
   if (raw) {
    try {
     const parsed = JSON.parse(raw);
     if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
     else inputError = 'Tool arguments must be a JSON object.';
    } catch {
     inputError = 'Tool arguments were not valid JSON.';
    }
   }
   toolUses.push({ id: block.id, name: block.name, input, inputError });
  }
  // Recorded after the stream drains, so a turn that is cut off mid-flight still
  // books the tokens it had already reported rather than nothing.
  await recordAnthropicUsage(dbQuery, {
   workspaceId,
   model: resolvedModel,
   kind: usageKind,
   counts: usage.result(),
  });
  return { text: full, toolUses, stopReason };
 }

 return {
  builtinStepDetail,
  builtinToolIdentity,
  connectionSupportsAmpRuntime,
  getBuiltinToolset,
  isAmpRuntimeAgent,
  loadAmpThreadBinding,
  mcpToolDeps,
  runAgentTurn,
  runAnthropicCompletion,
  runToolUseLoop,
  streamAnthropicTurn,
  streamFlushDue,
  toolResultText,
  validAmpThreadId,
  BUILTIN_FLUSH_INTERVAL_MS,
  BUILTIN_TOOL_LOOP_MAX_CALLS,
  BUILTIN_TOOL_LOOP_MAX_STEPS,
  BUILTIN_TOOL_NOTE,
  BUILTIN_TOOL_RESULT_MAX_CHARS,
  SPEAKABLE_BOUNDARY_RE,
 };
}

module.exports = { createBuiltinTurn };
