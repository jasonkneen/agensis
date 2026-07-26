'use strict';

// ============================================================================
// shared/workspace-tree.cjs — the workspace hierarchy, as pure functions.
// ----------------------------------------------------------------------------
// A workspace is groupable: `workspaces.parent_id` is a nullable self-reference.
// There is no separate "folder" entity and no new tier — a workspace with
// children renders as a group, one without renders as a leaf.
//
// THE INHERITANCE RULE, which every function here encodes:
//
//   A child inherits AGENTS and MEMBERS from its ancestors.
//   CONTENT is ISOLATED — channels, documents, tasks and memory belong to
//   exactly one workspace and are never visible from a sibling or a parent.
//
// Access therefore flows strictly DOWNWARD. Membership of `Work` reaches every
// client workspace beneath it; membership of client A reaches neither client B
// (a sibling) nor `Work` (its parent). Getting the direction wrong leaks one
// client's data to another, so the direction is asserted in tests, not assumed.
//
// NO React, NO DOM, NO database. Every function takes the graph as data:
// `parentById`, a Map (or plain object) of workspace id -> parent id | null.
// The DB-touching wrappers live in shared/backend-core.cjs.
//
// Every traversal is CYCLE-SAFE and DEPTH-CAPPED. That is not paranoia about
// this module's own callers: a cycle reached by a `WITH RECURSIVE` ancestor walk
// in the authorization path would spin until statement_timeout on every request
// touching the workspace — a denial of service reachable by one bad UPDATE. The
// cycle is prevented at write time (see wouldCreateCycle, plus the DB trigger),
// and every read is written so that a cycle which somehow exists anyway
// terminates instead of hanging.
// ============================================================================

// Maximum ancestor-chain length. Bounds every recursive walk, in SQL and here.
// A chain deeper than this is refused at write time; a chain that is deeper
// anyway (hand-written SQL, restored backup) is TRUNCATED by the readers rather
// than followed forever.
const WORKSPACE_MAX_DEPTH = 10;

function normalizeId(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

// Read a parent id out of either a Map or a plain object, normalized to
// string-or-null so a uuid string and a uuid-ish object never miscompare.
function parentOf(parentById, id) {
  const key = normalizeId(id);
  if (key === null) return null;
  if (parentById instanceof Map) return normalizeId(parentById.get(key));
  if (parentById && typeof parentById === 'object') {
    return Object.prototype.hasOwnProperty.call(parentById, key)
      ? normalizeId(parentById[key])
      : null;
  }
  return null;
}

/**
 * The ancestor chain of `id`, NEAREST FIRST: [parent, grandparent, ...].
 * Excludes `id` itself. Stops at the root, at `maxDepth` entries, or the moment
 * it revisits an id (which is what makes it safe on a corrupt cyclic graph).
 */
function ancestorIds(parentById, id, { maxDepth = WORKSPACE_MAX_DEPTH } = {}) {
  const start = normalizeId(id);
  if (start === null) return [];
  const chain = [];
  const seen = new Set([start]);
  let current = parentOf(parentById, start);
  while (current !== null && chain.length < maxDepth) {
    if (seen.has(current)) break; // cycle — stop, do not loop
    seen.add(current);
    chain.push(current);
    current = parentOf(parentById, current);
  }
  return chain;
}

/**
 * `id` plus its ancestors, nearest first. The set of workspaces whose
 * membership grants access TO `id`.
 */
function selfAndAncestorIds(parentById, id, options) {
  const start = normalizeId(id);
  if (start === null) return [];
  return [start, ...ancestorIds(parentById, start, options)];
}

/**
 * How deep `id` sits. A root is 0. A cyclic or over-deep chain reports the
 * capped length, so callers comparing against WORKSPACE_MAX_DEPTH still refuse.
 */
function depthOf(parentById, id, options) {
  return ancestorIds(parentById, id, options).length;
}

/**
 * Every descendant of `id`, breadth-first, excluding `id`. Needs the whole
 * graph (the child -> parent direction is the only one stored), so the caller
 * must pass a `parentById` covering the candidate rows.
 */
function descendantIds(parentById, id, { maxDepth = WORKSPACE_MAX_DEPTH } = {}) {
  const root = normalizeId(id);
  if (root === null) return [];

  const childrenByParent = new Map();
  const entries = parentById instanceof Map
    ? [...parentById.entries()]
    : Object.entries(parentById || {});
  for (const [rawChild, rawParent] of entries) {
    const child = normalizeId(rawChild);
    const parent = normalizeId(rawParent);
    if (child === null || parent === null) continue;
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(child);
  }

  const out = [];
  const seen = new Set([root]);
  let frontier = childrenByParent.get(root) || [];
  let level = 0;
  while (frontier.length > 0 && level < maxDepth) {
    const next = [];
    for (const child of frontier) {
      if (seen.has(child)) continue; // cycle guard
      seen.add(child);
      out.push(child);
      for (const grandchild of childrenByParent.get(child) || []) next.push(grandchild);
    }
    frontier = next;
    level += 1;
  }
  return out;
}

/**
 * `id` plus every descendant — the SUBTREE. This is the set the audit document
 * (docs/nested-workspaces-subtree-audit.md) is about: the call sites that must
 * one day read `workspace_id = ANY(subtree)` instead of `workspace_id = $1`.
 */
function subtreeIds(parentById, id, options) {
  const root = normalizeId(id);
  if (root === null) return [];
  return [root, ...descendantIds(parentById, root, options)];
}

/**
 * Would setting `childId`.parent_id = `proposedParentId` make a workspace its
 * own ancestor?
 *
 * True when the proposed parent IS the child (the 1-cycle), when the child
 * already sits above the proposed parent anywhere in its chain (A -> B -> A and
 * every longer version), or when the proposed parent is already stuck in a
 * cycle of its own — grafting onto a broken chain inherits the breakage.
 *
 * Clearing the parent (`null`) is always safe.
 */
function wouldCreateCycle(parentById, childId, proposedParentId) {
  const child = normalizeId(childId);
  const parent = normalizeId(proposedParentId);
  if (child === null || parent === null) return false;
  if (child === parent) return true;

  // Walk up from the proposed parent. Deliberately NOT bounded by
  // WORKSPACE_MAX_DEPTH: depth is a separate rule with a separate message, and
  // a cycle above the cap must still be reported as a cycle. The `seen` set is
  // what guarantees termination.
  const seen = new Set([parent]);
  let current = parentOf(parentById, parent);
  while (current !== null) {
    if (current === child) return true;   // child is above the proposed parent
    if (seen.has(current)) return true;   // proposed parent sits in a cycle
    seen.add(current);
    current = parentOf(parentById, current);
  }
  return false;
}

/**
 * Would the move push any workspace past WORKSPACE_MAX_DEPTH? The child's whole
 * SUBTREE moves with it, so the deepest leaf under the child is what counts,
 * not the child itself. Callers must check wouldCreateCycle FIRST — this
 * assumes an acyclic result.
 */
function wouldExceedMaxDepth(parentById, childId, proposedParentId, maxDepth = WORKSPACE_MAX_DEPTH) {
  const child = normalizeId(childId);
  const parent = normalizeId(proposedParentId);
  if (child === null || parent === null) return false;

  const parentDepth = depthOf(parentById, parent, { maxDepth: maxDepth + 1 });
  const newChildDepth = parentDepth + 1;

  // Tallest branch under the child, relative to the child (0 when it is a leaf).
  let subtreeHeight = 0;
  for (const descendant of descendantIds(parentById, child, { maxDepth: maxDepth + 1 })) {
    const relative = depthOf(parentById, descendant, { maxDepth: maxDepth + 1 })
      - depthOf(parentById, child, { maxDepth: maxDepth + 1 });
    if (relative > subtreeHeight) subtreeHeight = relative;
  }
  return newChildDepth + subtreeHeight > maxDepth;
}

/**
 * Every role `userId` effectively holds in `workspaceId`: the role held there
 * directly, plus every role held in an ANCESTOR. Ancestors only — this is the
 * one-way valve. `rolesByWorkspace` maps workspace id -> role held directly.
 *
 * Returns a de-duplicated array; order is nearest-first (direct role, then up
 * the chain) so a caller that wants "the closest role" can take [0].
 */
function effectiveRoles(rolesByWorkspace, parentById, workspaceId, options) {
  const source = rolesByWorkspace instanceof Map
    ? rolesByWorkspace
    : new Map(Object.entries(rolesByWorkspace || {}));
  const roles = [];
  for (const id of selfAndAncestorIds(parentById, workspaceId, options)) {
    const role = source.get(id);
    if (role && !roles.includes(role)) roles.push(role);
  }
  return roles;
}

/**
 * Does ANY role in the set carry `capability`?
 *
 * The union, not a ranking. This repo's model is capability membership, not
 * role seniority (see WORKSPACE_ROLE_CAPABILITIES) — so "owner of the parent,
 * viewer of the child" needs no tie-break: the user simply has every capability
 * either role grants. `capabilityMap` is role -> Set<capability>, passed in so
 * this module stays free of the backend's tables.
 */
function roleSetHasCapability(roles, capability, capabilityMap) {
  if (!capability || !capabilityMap) return false;
  for (const role of roles || []) {
    const caps = capabilityMap[role];
    if (caps && typeof caps.has === 'function' && caps.has(capability)) return true;
  }
  return false;
}

/**
 * "Can this user, holding these direct roles, reach this workspace with this
 * capability?" — the whole authorization question in one pure call, for tests
 * and for any caller that already has the graph in memory.
 */
function canReachWorkspace({ rolesByWorkspace, parentById, workspaceId, capability, capabilityMap }) {
  const roles = effectiveRoles(rolesByWorkspace, parentById, workspaceId);
  return roleSetHasCapability(roles, capability, capabilityMap);
}

module.exports = {
  WORKSPACE_MAX_DEPTH,
  parentOf,
  ancestorIds,
  selfAndAncestorIds,
  depthOf,
  descendantIds,
  subtreeIds,
  wouldCreateCycle,
  wouldExceedMaxDepth,
  effectiveRoles,
  roleSetHasCapability,
  canReachWorkspace,
};
