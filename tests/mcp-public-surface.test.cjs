// ============================================================================
// tests/mcp-public-surface.test.cjs
// ----------------------------------------------------------------------------
// The MCP tool surface is a PUBLIC CONTRACT and nothing pinned it.
//
// `/backend/skill` (and `/api/skill`, `/skill`, `/.well-known/agent-skill`) is
// served with NO authentication — only an IP rate limiter — and its body is
// `listToolSummaries()`, i.e. every published tool name and description. Any
// third party can read that table, and the whole point of publishing it is that
// they bind to it. `tools/list` then hands out the full JSON Schema per tool to
// any bearer of a valid token.
//
// So renaming a tool, dropping one, or adding a required argument is a BREAKING
// CHANGE FOR CLIENTS WE CANNOT SEE OR REDEPLOY. Nothing said so.
//
// WHY THE PRE-EXISTING TESTS PINNED ONLY FIVE NAMES.
// tests/builtin-tool-loop.test.cjs checks the builtin toolset against
// buildTools(), but those assertions are RELATIVE — they compare one derived
// list to another, so a rename that moves
// both sides together stays green:
//
//     assert.deepEqual(specNames, expected)   // both derived from buildTools()
//
// It does incidentally protect five names, hardcoded as a sanity check inside a
// different assertion (builtin-tool-loop.test.cjs:340): create_thread_item,
// call_provider, post_message, create_task, read_channel. Rename one of those
// and it fails. Rename an unpinned name and the relative assertions still stay
// green — verified by mutation: renaming `list_members` fails this file and
// nothing else.
//
// That test is the right one for "the two doors describe a tool identically" and
// is worth keeping. This file is the absolute half: literal expected values, so
// a rename has to be typed out here on purpose.
//
// ADDING A TOOL IS FINE — add it to the table below in the same commit. The
// friction is the point: one line, acknowledging that a new tool joins a public,
// unauthenticated surface. What must never happen quietly is a RENAME or a new
// REQUIRED argument.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const { __test, listToolSummaries } = require('../server/mcp.cjs');

// name -> exact `required` array from the tool's inputSchema.
// Sorted by name so a diff on this table is readable.
const PUBLIC_TOOL_SURFACE = {
  add_memory: ['fact'],
  call_provider: ['skill_id', 'operation'],
  claim_job: [],
  claim_resource_operation: [],
  create_channel: ['title'],
  create_task: ['title'],
  create_thread_item: ['session_id', 'kind', 'content'],
  create_workspace_resource: ['steward_agent_id', 'name', 'facet'],
  delete_workspace_resource: ['resource_id'],
  dispatch_agent: ['channel_id', 'content'],
  fail_job: ['job_id'],
  get_connect_command: [],
  get_resource_operation: ['operation_id'],
  get_workspace_memory: [],
  get_workspace_resource: ['resource_id'],
  list_agents: [],
  list_channels: [],
  list_docs: [],
  list_members: [],
  list_resource_operations: [],
  list_skills: [],
  list_tasks: [],
  list_thread_items: ['session_id'],
  list_workspace_resources: [],
  post_message: ['channel_id', 'content'],
  read_channel: ['channel_id'],
  read_doc: ['doc_id'],
  read_skill: ['skill'],
  register_agent: [],
  registration_status: ['registration_id'],
  report_resource_operation_progress: ['operation_id', 'lease_version', 'phase', 'message'],
  renew_resource_operation: ['operation_id', 'lease_version'],
  request_resource_operation: ['resource_id', 'operation', 'idempotency_key'],
  restore_workspace_resource: ['resource_id'],
  search_docs: ['query'],
  search_messages: ['query'],
  settle_resource_operation: ['operation_id', 'lease_version', 'status'],
  submit_job_result: ['job_id', 'response'],
  update_task: ['task_id'],
  update_thread_item: ['item_id'],
  update_workspace_resource: ['resource_id'],
  whoami: [],
  write_doc: [],
};

const DRIFT_NOTE = [
  '',
  'The MCP tool surface is published UNAUTHENTICATED at /backend/skill and is',
  'consumed by clients we cannot see or redeploy. Renaming a tool or adding a',
  'required argument breaks them silently.',
  '',
  'Adding a tool: add it to PUBLIC_TOOL_SURFACE in this file, same commit.',
  'Renaming or changing required args: make sure you mean it, then update the',
  'table. Do not delete this test to make it pass.',
].join('\n');

test('the public MCP tool name set is exactly what external clients bind to', () => {
  const actual = __test.buildTools().map((tool) => tool.name).sort();
  const expected = Object.keys(PUBLIC_TOOL_SURFACE).sort();
  assert.deepEqual(actual, expected, DRIFT_NOTE);
});

test('no tool has gained, lost or reordered a required argument', () => {
  // Required args are pinned for ALL tools, not just the ergonomic ones: a new
  // required argument is a breaking change for any client that was calling the
  // tool without it, whichever tool it is.
  const actual = {};
  for (const tool of __test.buildTools()) {
    actual[tool.name] = (tool.inputSchema && tool.inputSchema.required) || [];
  }
  assert.deepEqual(actual, PUBLIC_TOOL_SURFACE, DRIFT_NOTE);
});

test('every tool schema still refuses unknown properties', () => {
  // A schema-driven client builds its own flag parser from `properties` and
  // rejects unknown flags LOCALLY because additionalProperties is false.
  //
  // Note this is a CLIENT-side guarantee only: the MCP dispatcher never
  // validates arguments against inputSchema (see AGENTS.md, and the reason
  // call_provider carries an explicit `unknownProviderCallArgs` by-name refusal
  // rather than trusting its own schema). That asymmetry is exactly why the
  // published schema has to stay honest — it is the only thing a client has.
  const offenders = __test.buildTools()
    .filter((tool) => !tool.inputSchema || tool.inputSchema.additionalProperties !== false)
    .map((tool) => tool.name);
  assert.deepEqual(offenders, [], 'these tool schemas no longer set additionalProperties:false');
});

test('every published tool carries a description', () => {
  // listToolSummaries() is the body of the unauthenticated /backend/skill
  // manifest. A tool with no description ships an empty cell to every reader.
  const undescribed = listToolSummaries()
    .filter((tool) => !tool.description || !String(tool.description).trim())
    .map((tool) => tool.name);
  assert.deepEqual(undescribed, [], 'these tools are published with no description');
});

test('the published summary lists the same tools as tools/list', () => {
  // Two functions, one surface: listToolSummaries() feeds /backend/skill and
  // buildTools() feeds tools/list. A client reading the public manifest must not
  // discover a tool that tools/list does not serve, or vice versa.
  const summary = listToolSummaries().map((tool) => tool.name).sort();
  const full = __test.buildTools().map((tool) => tool.name).sort();
  assert.deepEqual(summary, full, '/backend/skill and tools/list disagree about which tools exist');
});
