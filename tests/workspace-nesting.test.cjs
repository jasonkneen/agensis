'use strict';

// ============================================================================
// tests/workspace-nesting.test.cjs
// ----------------------------------------------------------------------------
// Groupable workspaces — `workspaces.parent_id`. Foundation only: no user can
// create a child yet, so nothing here is reachable in the product. It is tested
// now precisely because of that: the day a child exists, a mistake in this
// authorization rule shows one client's data to another, which is the worst
// failure this feature can have.
//
// Three things are asserted:
//   1. THE THREE-PLACE SCHEMA RULE (AGENTS.md) — runtime bootstrap, canonical
//      schema, migration — plus the ON DELETE choice and the cycle guards.
//   2. THE INHERITANCE RULE — members flow DOWN from ancestors and NEVER up or
//      sideways. The negative cases carry the weight here.
//   3. RE-PARENTING — who may set parent_id, and that no write can make a
//      workspace its own ancestor.
//
// The mock `db(sql, params) => rows` implements enough of Postgres to answer
// the hierarchy queries honestly, including the recursive CTE — a mock that
// just returned [] would pass every negative test for the wrong reason.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../shared/backend-core.cjs');
const tree = require('../shared/workspace-tree.cjs');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// ---------------------------------------------------------------------------
// 1. Schema — all three places, or a fresh DB drifts from a deployed one.
// ---------------------------------------------------------------------------

function migrationSource() {
  const names = fs.readdirSync(path.join(root, 'supabase/migrations'))
    .filter((name) => name.endsWith('_workspace_parent_id.sql'));
  assert.equal(names.length, 1, 'expected exactly one workspace parent_id migration');
  return read(path.join('supabase/migrations', names[0]));
}

test('workspaces.parent_id exists in all three schema places', () => {
  const runtime = require('./helpers/fly-lane.cjs').flyLaneSource();
  const canonical = read('database/neon-schema.sql');
  const migration = migrationSource();

  // Runtime bootstrap + migration add the column idempotently; the canonical
  // schema declares it inline on CREATE TABLE workspaces.
  assert.match(runtime, /ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS parent_id uuid/);
  assert.match(migration, /ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS parent_id uuid/);
  assert.match(canonical, /parent_id uuid REFERENCES workspaces\(id\) ON DELETE RESTRICT/);

  for (const source of [runtime, canonical, migration]) {
    assert.match(source, /CREATE INDEX IF NOT EXISTS idx_workspaces_parent_id ON workspaces\(parent_id\)/);
  }
});

test('the parent FK is ON DELETE RESTRICT — never CASCADE, never SET NULL', () => {
  // CASCADE would silently destroy every client workspace under a deleted
  // agency parent. SET NULL would silently promote them to top level AND strip
  // every member whose access was inherited. Only RESTRICT forces the operator
  // to decide.
  for (const source of [require('./helpers/fly-lane.cjs').flyLaneSource(), read('database/neon-schema.sql'), migrationSource()]) {
    assert.match(source, /REFERENCES workspaces\(id\) ON DELETE RESTRICT/);
    assert.doesNotMatch(source, /parent_id\)?\s+REFERENCES workspaces\(id\) ON DELETE CASCADE/);
    assert.doesNotMatch(source, /workspaces_parent_id_fkey[\s\S]{0,200}ON DELETE (CASCADE|SET NULL)/);
  }
});

test('cycles are refused by the database itself, not only by the API gate', () => {
  // A cycle is a denial of service, not a cosmetic problem: the ancestor walk
  // sits in the authorization path. The CHECK covers the 1-cycle; the trigger
  // covers every longer one, for every writer (daemon, MCP, psql, migration).
  for (const source of [require('./helpers/fly-lane.cjs').flyLaneSource(), read('database/neon-schema.sql'), migrationSource()]) {
    assert.match(source, /CHECK \(parent_id IS NULL OR parent_id <> id\)/);
    assert.match(source, /CREATE OR REPLACE FUNCTION workspaces_reject_parent_cycle\(\)/);
    assert.match(source, /cannot be its own ancestor/);
    assert.match(source, /CREATE TRIGGER trg_workspaces_reject_parent_cycle/);
    assert.match(source, /BEFORE INSERT OR UPDATE OF parent_id ON workspaces/);
  }

  // The trigger's step counter must agree with the JS depth cap, or one layer
  // accepts a chain the other rejects. The runtime bootstrap interpolates the
  // shared constant directly; the two .sql files cannot, so the literal they
  // carry is pinned to it here.
  assert.match(require('./helpers/fly-lane.cjs').flyLaneSource(), /steps > \$\{WORKSPACE_MAX_DEPTH\}/);
  const literal = new RegExp(`steps > ${tree.WORKSPACE_MAX_DEPTH}\\b`);
  assert.match(read('database/neon-schema.sql'), literal);
  assert.match(migrationSource(), literal);
});

test('parent_id reaches the client — projected by BOTH backends', () => {
  // `icon` and `is_system` were each missing from this exact projection while
  // the column existed, and the UI degraded silently instead of erroring. The
  // column, the SELECT list and the projection function all have to agree.
  const server = require('./helpers/fly-lane.cjs').flyLaneSource();
  const netlify = read('netlify/functions/backend.mjs');
  for (const source of [server, netlify]) {
    assert.match(source, /w\.is_system, w\.parent_id/, 'the /backend/workspaces SELECT must list w.parent_id');
    assert.match(source, /parent_id: row\.parent_id \|\| null/, 'publicWorkspace must project parent_id');
  }
  // And the frontend type knows about it, so a consumer is not guessing.
  assert.match(read('src/types/index.ts'), /parent_id\?: string \| null;/);
});

// ---------------------------------------------------------------------------
// 2. Authorization — the inheritance rule.
// ---------------------------------------------------------------------------

// The shape the feature exists for. `work` is the agency; clientA and clientB
// are separate customers who must never see each other.
//
//   work
//    +- clientA
//    |    +- clientA-team
//    +- clientB
//   solo
const HIERARCHY = {
  work: null,
  clientA: 'work',
  'clientA-team': 'clientA',
  clientB: 'work',
  solo: null,
};

/**
 * A mock `db` that answers the hierarchy queries for real.
 *   owners:        { [workspaceId]: userId }
 *   roles:         { `${workspaceId}:${userId}`: role }
 *   parents:       { [workspaceId]: parentId | null }
 *   rowWorkspaces: { [table]: { [rowId]: workspaceId } }
 */
function makeDb({ owners = {}, roles = {}, parents = HIERARCHY, rowWorkspaces = {} } = {}) {
  const ancestorsOf = (id) => {
    const chain = [];
    const seen = new Set([String(id)]);
    let current = parents[id] == null ? null : String(parents[id]);
    while (current && !seen.has(current) && chain.length < tree.WORKSPACE_MAX_DEPTH) {
      seen.add(current);
      chain.push(current);
      current = parents[current] == null ? null : String(parents[current]);
    }
    return chain;
  };

  async function db(sql, params = []) {
    const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();

    if (n.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
      return owners[params[0]] === params[1] ? [{ ok: 1 }] : [];
    }
    if (n.startsWith('select role from workspace_members where workspace_id = $1 and user_id = $2')) {
      const role = roles[`${params[0]}:${params[1]}`];
      return role ? [{ role }] : [];
    }
    // userCanAccessWorkspace's direct owner-or-member union.
    if (n.startsWith('select 1 from workspaces where id = $1 and user_id = $2 union all')) {
      const direct = owners[params[0]] === params[1] || roles[`${params[0]}:${params[1]}`];
      return direct ? [{ ok: 1 }] : [];
    }
    // getInheritedWorkspaceRoles — roles held STRICTLY ABOVE the workspace.
    if (n.startsWith('with recursive chain as')) {
      const [workspaceId, userId] = params;
      const found = new Set();
      for (const ancestor of ancestorsOf(workspaceId)) {
        if (owners[ancestor] === userId) found.add('owner');
        const role = roles[`${ancestor}:${userId}`];
        if (role) found.add(role);
      }
      return [...found].map((role) => ({ role }));
    }
    // loadSubtreeEdges — the moving workspace drags its descendants along.
    if (n.startsWith('with recursive sub as')) {
      const rootId = String(params[0]);
      const inSubtree = Object.keys(parents).filter((id) => (
        id === rootId || ancestorsOf(id).includes(rootId)
      ));
      return inSubtree.map((id) => ({ id, parent_id: parents[id] ?? null }));
    }
    if (n.startsWith('select parent_id from workspaces where id = $1')) {
      return Object.prototype.hasOwnProperty.call(parents, params[0])
        ? [{ parent_id: parents[params[0]] ?? null }]
        : [];
    }
    if (n.startsWith('select id from workspaces where parent_id = $1')) {
      const child = Object.keys(parents).find((id) => parents[id] === params[0]);
      return child ? [{ id: child }] : [];
    }
    if (n.startsWith('select id from workspaces where id = $1')) {
      return Object.prototype.hasOwnProperty.call(parents, params[0]) ? [{ id: params[0] }] : [];
    }
    const m = n.match(/^select workspace_id from "?([a-z_]+)"? where id = \$1 limit 1/);
    if (m) {
      const ws = rowWorkspaces[m[1]]?.[params[0]];
      return ws ? [{ workspace_id: ws }] : [];
    }
    throw new Error(`Unexpected SQL in nesting test: ${sql}`);
  }
  return db;
}

const allowed = (fn) => assert.doesNotReject(fn);
const denied = (fn, status = 403) => assert.rejects(fn, (err) => err.status === status);

test('a member of the parent reaches every workspace beneath it', async () => {
  const db = makeDb({ roles: { 'work:agency-admin': 'admin' } });
  for (const workspaceId of ['work', 'clientA', 'clientA-team', 'clientB']) {
    for (const capability of ['read', 'write', 'comment', 'run_agents', 'manage']) {
      await allowed(() => core.assertWorkspaceRole({
        userId: 'agency-admin', workspaceId, capability, db,
      }));
    }
  }
});

test('the OWNER of the parent inherits ownership capabilities downward', async () => {
  const db = makeDb({ owners: { work: 'agency-owner' } });
  await allowed(() => core.assertWorkspaceRole({
    userId: 'agency-owner', workspaceId: 'clientA-team', capability: 'manage', db,
  }));
});

test('a member of client A CANNOT reach client B — the sibling leak', async () => {
  // The failure this whole feature has to not have. clientA and clientB share
  // an ancestor; sharing an ancestor is not membership.
  const db = makeDb({ owners: { clientA: 'client-a-user' } });
  for (const capability of ['read', 'write', 'comment', 'run_agents', 'manage']) {
    await denied(() => core.assertWorkspaceRole({
      userId: 'client-a-user', workspaceId: 'clientB', capability, db,
    }));
  }
  assert.equal(await core.userCanAccessWorkspace('client-a-user', 'clientB', db), false);
});

test('a member of a child CANNOT reach the parent — access never flows up', async () => {
  const db = makeDb({ owners: { clientA: 'client-a-user' } });
  await denied(() => core.assertWorkspaceRole({
    userId: 'client-a-user', workspaceId: 'work', capability: 'read', db,
  }));
  assert.equal(await core.userCanAccessWorkspace('client-a-user', 'work', db), false);
});

test('a member of a GRANDCHILD reaches neither the parent nor the grandparent', async () => {
  const db = makeDb({ owners: { 'clientA-team': 'team-user' } });
  for (const workspaceId of ['clientA', 'work']) {
    await denied(() => core.assertWorkspaceRole({
      userId: 'team-user', workspaceId, capability: 'read', db,
    }));
  }
  await allowed(() => core.assertWorkspaceRole({
    userId: 'team-user', workspaceId: 'clientA-team', capability: 'manage', db,
  }));
});

test('an unrelated top-level workspace is reachable by nobody in the tree', async () => {
  const db = makeDb({ owners: { work: 'agency-owner' } });
  await denied(() => core.assertWorkspaceRole({
    userId: 'agency-owner', workspaceId: 'solo', capability: 'read', db,
  }));
});

test('inherited capability is the union, not a ranking', async () => {
  // Viewer in the child, admin in the parent: reads AND manages, with no
  // seniority comparison anywhere.
  const db = makeDb({ roles: { 'work:person': 'admin', 'clientA:person': 'viewer' } });
  await allowed(() => core.assertWorkspaceRole({
    userId: 'person', workspaceId: 'clientA', capability: 'manage', db,
  }));

  // And the reverse: admin in the child, viewer in the parent. The child's
  // admin rights must not leak upward into the parent.
  const db2 = makeDb({ roles: { 'work:person': 'viewer', 'clientA:person': 'admin' } });
  await allowed(() => core.assertWorkspaceRole({
    userId: 'person', workspaceId: 'work', capability: 'read', db: db2,
  }));
  await denied(() => core.assertWorkspaceRole({
    userId: 'person', workspaceId: 'work', capability: 'manage', db: db2,
  }));
});

test('a viewer of the parent inherits read only', async () => {
  const db = makeDb({ roles: { 'work:watcher': 'viewer' } });
  await allowed(() => core.assertWorkspaceRole({
    userId: 'watcher', workspaceId: 'clientA', capability: 'read', db,
  }));
  await denied(() => core.assertWorkspaceRole({
    userId: 'watcher', workspaceId: 'clientA', capability: 'write', db,
  }));
});

test('a FLAT workspace behaves exactly as it does today', async () => {
  // Every workspace in production is a root right now. The direct-role fast
  // path must still grant, and a non-member must still be refused.
  const db = makeDb({ owners: { solo: 'solo-owner' }, parents: { solo: null } });
  await allowed(() => core.assertWorkspaceRole({
    userId: 'solo-owner', workspaceId: 'solo', capability: 'manage', db,
  }));
  await denied(() => core.assertWorkspaceRole({
    userId: 'stranger', workspaceId: 'solo', capability: 'read', db,
  }));
});

test('a direct role that already grants the capability skips the ancestor walk', async () => {
  // Not a micro-optimisation: the walk runs on EVERY authorized request
  // otherwise, and this is the hot path.
  const seen = [];
  const inner = makeDb({ owners: { clientA: 'client-a-user' } });
  const db = async (sql, params) => { seen.push(String(sql)); return inner(sql, params); };
  await core.assertWorkspaceRole({ userId: 'client-a-user', workspaceId: 'clientA', capability: 'read', db });
  assert.equal(seen.some((s) => s.includes('with recursive chain as')), false);
});

// ---------------------------------------------------------------------------
// 3. Content isolation through the generic /backend/db gate.
// ---------------------------------------------------------------------------

test('content stays isolated: an agency member reaches a client document, a sibling client does not', async () => {
  const db = makeDb({
    roles: { 'work:agency-admin': 'admin', 'clientB:client-b-user': 'editor' },
    rowWorkspaces: { documents: { 'doc-a': 'clientA' } },
  });
  const payload = { filters: [{ column: 'id', operator: 'eq', value: 'doc-a' }] };

  // Downward: the agency admin manages clientA, so they reach its documents.
  await allowed(() => core.enforceDbOperationAccess({
    userId: 'agency-admin', table: 'documents', op: 'select', filters: payload.filters, payload, db,
  }));
  // Sideways: clientB's editor must not.
  await denied(() => core.enforceDbOperationAccess({
    userId: 'client-b-user', table: 'documents', op: 'select', filters: payload.filters, payload, db,
  }));
});

test('a child member cannot read the parent workspace’s content', async () => {
  const db = makeDb({
    owners: { clientA: 'client-a-user' },
    rowWorkspaces: { tasks: { 'task-work': 'work' } },
  });
  const filters = [{ column: 'id', operator: 'eq', value: 'task-work' }];
  await denied(() => core.enforceDbOperationAccess({
    userId: 'client-a-user', table: 'tasks', op: 'select', filters, payload: { filters }, db,
  }));
});

// ---------------------------------------------------------------------------
// 4. Re-parenting.
// ---------------------------------------------------------------------------

test('a workspace cannot be made its own parent', async () => {
  const db = makeDb({ owners: { clientA: 'client-a-user' } });
  await denied(() => core.assertWorkspaceParentChange({
    userId: 'client-a-user', workspaceId: 'clientA', parentId: 'clientA', db,
  }), 400);
});

test('the two-node cycle A -> B -> A is rejected', async () => {
  // clientA is already under work. Making work a child of clientA closes it.
  const db = makeDb({ owners: { work: 'boss', clientA: 'boss' } });
  await denied(() => core.assertWorkspaceParentChange({
    userId: 'boss', workspaceId: 'work', parentId: 'clientA', db,
  }), 400);
});

test('a deeper cycle (grandparent under grandchild) is rejected', async () => {
  const db = makeDb({ owners: { work: 'boss', 'clientA-team': 'boss' } });
  await denied(() => core.assertWorkspaceParentChange({
    userId: 'boss', workspaceId: 'work', parentId: 'clientA-team', db,
  }), 400);
});

test('a legitimate move between groups is allowed', async () => {
  const db = makeDb({ owners: { solo: 'boss', work: 'boss' } });
  await allowed(() => core.assertWorkspaceParentChange({
    userId: 'boss', workspaceId: 'solo', parentId: 'work', db,
  }));
});

test('detaching to top level needs nothing beyond direct manage on the child', async () => {
  const db = makeDb({ owners: { clientA: 'client-a-user' } });
  await allowed(() => core.assertWorkspaceParentChange({
    userId: 'client-a-user', workspaceId: 'clientA', parentId: null, db,
  }));
});

test('attaching to a group you cannot manage is refused', async () => {
  // Otherwise anyone could graft their workspace into another org's group and
  // hand that group's members a view of their content.
  const db = makeDb({ owners: { solo: 'outsider' } });
  await denied(() => core.assertWorkspaceParentChange({
    userId: 'outsider', workspaceId: 'solo', parentId: 'work', db,
  }));
});

test('an INHERITED manager cannot detach the workspace they inherited it through', async () => {
  // The agency admin manages clientA by inheritance. Letting them re-parent it
  // would strip every inherited member's access — theirs included — in one
  // write. Re-parenting requires a DIRECT manage role.
  const db = makeDb({ roles: { 'work:agency-admin': 'admin' } });
  await allowed(() => core.assertWorkspaceRole({
    userId: 'agency-admin', workspaceId: 'clientA', capability: 'manage', db,
  }));
  await denied(() => core.assertWorkspaceParentChange({
    userId: 'agency-admin', workspaceId: 'clientA', parentId: null, db,
  }));
});

test('nesting deeper than the cap is refused', async () => {
  const parents = { w0: null };
  const owners = { w0: 'boss', deep: 'boss' };
  for (let i = 1; i <= tree.WORKSPACE_MAX_DEPTH; i += 1) {
    parents[`w${i}`] = `w${i - 1}`;
    owners[`w${i}`] = 'boss';
  }
  parents.deep = null;
  const db = makeDb({ owners, parents });

  // Landing exactly on the cap is fine; one deeper is not.
  await allowed(() => core.assertWorkspaceParentChange({
    userId: 'boss', workspaceId: 'deep', parentId: `w${tree.WORKSPACE_MAX_DEPTH - 1}`, db,
  }));
  await denied(() => core.assertWorkspaceParentChange({
    userId: 'boss', workspaceId: 'deep', parentId: `w${tree.WORKSPACE_MAX_DEPTH}`, db,
  }), 400);
});

// ---------------------------------------------------------------------------
// 5. The generic /backend/db route is the only writer that can reach parent_id.
// ---------------------------------------------------------------------------

test('POST /backend/db/update cannot smuggle a cycle through parent_id', async () => {
  const db = makeDb({ owners: { work: 'boss', clientA: 'boss' } });
  const filters = [{ column: 'id', operator: 'eq', value: 'work' }];
  await denied(() => core.enforceDbOperationAccess({
    userId: 'boss',
    table: 'workspaces',
    op: 'update',
    filters,
    payload: { filters, values: { parent_id: 'clientA' } },
    db,
  }), 400);
});

test('POST /backend/db/insert cannot create a workspace inside a group it cannot manage', async () => {
  const db = makeDb({ owners: { solo: 'outsider' } });
  await denied(() => core.enforceDbOperationAccess({
    userId: 'outsider',
    table: 'workspaces',
    op: 'insert',
    payload: { values: { name: 'Sneaky', user_id: 'outsider', parent_id: 'work' } },
    db,
  }));
});

test('a workspace UPDATE that does not mention parent_id is unaffected', async () => {
  const db = makeDb({ owners: { clientA: 'client-a-user' } });
  const filters = [{ column: 'id', operator: 'eq', value: 'clientA' }];
  await allowed(() => core.enforceDbOperationAccess({
    userId: 'client-a-user',
    table: 'workspaces',
    op: 'update',
    filters,
    payload: { filters, values: { name: 'Renamed' } },
    db,
  }));
});

test('deleting a workspace that still contains workspaces is refused with 409, not a raw FK error', async () => {
  const db = makeDb({ owners: { work: 'boss', solo: 'boss' } });
  const parentFilters = [{ column: 'id', operator: 'eq', value: 'work' }];
  await denied(() => core.enforceDbOperationAccess({
    userId: 'boss', table: 'workspaces', op: 'delete', filters: parentFilters, payload: { filters: parentFilters }, db,
  }), 409);

  // A childless workspace deletes as it always did.
  const leafFilters = [{ column: 'id', operator: 'eq', value: 'solo' }];
  await allowed(() => core.enforceDbOperationAccess({
    userId: 'boss', table: 'workspaces', op: 'delete', filters: leafFilters, payload: { filters: leafFilters }, db,
  }));
});
