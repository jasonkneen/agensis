import { describe, expect, it } from 'vitest';
import * as tree from '../../shared/workspace-tree.cjs';

// The workspace hierarchy, tested as pure data. Two things are load-bearing
// here and both are the kind of bug you only find by asserting the NEGATIVE:
//
//   1. Access flows DOWNWARD only. A member of a client workspace must not
//      reach its sibling (they merely share an ancestor) and must not reach its
//      parent. Getting the direction wrong leaks one client's data to another.
//   2. A workspace must never be its own ancestor. A cycle is not a cosmetic
//      problem: the ancestor walk sits in the authorization path, so a cycle is
//      a denial of service on every request touching that workspace.

const {
  WORKSPACE_MAX_DEPTH,
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
} = tree as {
  WORKSPACE_MAX_DEPTH: number;
  ancestorIds: (p: unknown, id: unknown, o?: unknown) => string[];
  selfAndAncestorIds: (p: unknown, id: unknown, o?: unknown) => string[];
  depthOf: (p: unknown, id: unknown, o?: unknown) => number;
  descendantIds: (p: unknown, id: unknown, o?: unknown) => string[];
  subtreeIds: (p: unknown, id: unknown, o?: unknown) => string[];
  wouldCreateCycle: (p: unknown, child: unknown, parent: unknown) => boolean;
  wouldExceedMaxDepth: (p: unknown, child: unknown, parent: unknown, max?: number) => boolean;
  effectiveRoles: (r: unknown, p: unknown, id: unknown) => string[];
  roleSetHasCapability: (roles: string[], cap: string, map: Record<string, Set<string>>) => boolean;
  canReachWorkspace: (args: Record<string, unknown>) => boolean;
};

// The capability table from shared/backend-core.cjs, passed in so the pure
// module stays free of the backend's tables.
const CAPS: Record<string, Set<string>> = {
  owner: new Set(['read', 'write', 'comment', 'run_agents', 'manage']),
  admin: new Set(['read', 'write', 'comment', 'run_agents', 'manage']),
  editor: new Set(['read', 'write', 'comment', 'run_agents']),
  commenter: new Set(['read', 'comment']),
  viewer: new Set(['read']),
};

// The shape the feature was designed around: an agency workspace holding two
// client workspaces, one of which has a sub-team beneath it.
//
//   work
//    +- clientA
//    |    +- clientA-team
//    +- clientB
//   solo            (unrelated top-level workspace)
const AGENCY = {
  work: null,
  clientA: 'work',
  'clientA-team': 'clientA',
  clientB: 'work',
  solo: null,
};

describe('ancestorIds', () => {
  it('walks upward, nearest first, and excludes the workspace itself', () => {
    expect(ancestorIds(AGENCY, 'clientA-team')).toEqual(['clientA', 'work']);
    expect(ancestorIds(AGENCY, 'clientA')).toEqual(['work']);
    expect(ancestorIds(AGENCY, 'work')).toEqual([]);
  });

  it('returns nothing for a root, an unknown id, or no id at all', () => {
    expect(ancestorIds(AGENCY, 'solo')).toEqual([]);
    expect(ancestorIds(AGENCY, 'never-existed')).toEqual([]);
    expect(ancestorIds(AGENCY, null)).toEqual([]);
    expect(ancestorIds(AGENCY, undefined)).toEqual([]);
  });

  it('accepts a Map as well as a plain object', () => {
    const map = new Map(Object.entries(AGENCY));
    expect(ancestorIds(map, 'clientA-team')).toEqual(['clientA', 'work']);
  });

  it('TERMINATES on a cyclic graph instead of looping forever', () => {
    // The state the DB trigger exists to prevent. If this ever hangs, every
    // request touching one of these workspaces hangs with it.
    expect(ancestorIds({ a: 'b', b: 'a' }, 'a')).toEqual(['b']);
    expect(ancestorIds({ a: 'b', b: 'c', c: 'a' }, 'a')).toEqual(['b', 'c']);
    // A workspace pointing at itself — rejected by a CHECK constraint, but the
    // reader must not depend on that.
    expect(ancestorIds({ a: 'a' }, 'a')).toEqual([]);
  });

  it('truncates a chain longer than the depth cap rather than following it', () => {
    const deep: Record<string, string | null> = { w0: null };
    for (let i = 1; i <= 30; i += 1) deep[`w${i}`] = `w${i - 1}`;
    expect(ancestorIds(deep, 'w30')).toHaveLength(WORKSPACE_MAX_DEPTH);
    expect(ancestorIds(deep, 'w30', { maxDepth: 3 })).toEqual(['w29', 'w28', 'w27']);
  });
});

describe('selfAndAncestorIds / depthOf', () => {
  it('selfAndAncestorIds is the set whose membership grants access', () => {
    expect(selfAndAncestorIds(AGENCY, 'clientA-team')).toEqual(['clientA-team', 'clientA', 'work']);
    expect(selfAndAncestorIds(AGENCY, 'work')).toEqual(['work']);
  });

  it('depthOf counts a root as 0', () => {
    expect(depthOf(AGENCY, 'work')).toBe(0);
    expect(depthOf(AGENCY, 'clientA')).toBe(1);
    expect(depthOf(AGENCY, 'clientA-team')).toBe(2);
  });
});

describe('descendantIds / subtreeIds', () => {
  it('collects the whole subtree, breadth-first, excluding the root', () => {
    expect(descendantIds(AGENCY, 'work').sort()).toEqual(['clientA', 'clientA-team', 'clientB']);
    expect(descendantIds(AGENCY, 'clientA')).toEqual(['clientA-team']);
    expect(descendantIds(AGENCY, 'clientB')).toEqual([]);
  });

  it('subtreeIds includes the root — the set a subtree-scoped query would use', () => {
    expect(subtreeIds(AGENCY, 'clientA').sort()).toEqual(['clientA', 'clientA-team']);
    expect(subtreeIds(AGENCY, 'solo')).toEqual(['solo']);
  });

  it('terminates on a cyclic graph', () => {
    expect(descendantIds({ a: 'b', b: 'a' }, 'a')).toEqual(['b']);
  });
});

describe('wouldCreateCycle', () => {
  it('rejects a workspace becoming its own parent (the 1-cycle)', () => {
    expect(wouldCreateCycle(AGENCY, 'work', 'work')).toBe(true);
    expect(wouldCreateCycle({}, 'x', 'x')).toBe(true);
  });

  it('rejects the two-node A -> B -> A case', () => {
    // B is already a child of A. Making A a child of B closes the loop.
    const graph = { A: null, B: 'A' };
    expect(wouldCreateCycle(graph, 'A', 'B')).toBe(true);
    // The direction that does NOT close a loop is still fine.
    expect(wouldCreateCycle(graph, 'B', 'A')).toBe(false);
  });

  it('rejects longer chains — A -> B -> C -> A and deeper', () => {
    const three = { A: null, B: 'A', C: 'B' };
    expect(wouldCreateCycle(three, 'A', 'C')).toBe(true);

    const deep: Record<string, string | null> = { w0: null };
    for (let i = 1; i <= 8; i += 1) deep[`w${i}`] = `w${i - 1}`;
    expect(wouldCreateCycle(deep, 'w0', 'w8')).toBe(true);
    expect(wouldCreateCycle(deep, 'w3', 'w8')).toBe(true);
    // A cousin move that stays acyclic.
    expect(wouldCreateCycle(deep, 'w8', 'w0')).toBe(false);
  });

  it('reports a cycle even when it sits deeper than the depth cap', () => {
    // Depth truncation must not turn a cycle into an "allowed" move.
    const deep: Record<string, string | null> = { w0: null };
    for (let i = 1; i <= 40; i += 1) deep[`w${i}`] = `w${i - 1}`;
    expect(wouldCreateCycle(deep, 'w0', 'w40')).toBe(true);
  });

  it('refuses to graft onto a parent that is already inside a cycle', () => {
    expect(wouldCreateCycle({ a: 'b', b: 'a' }, 'newChild', 'a')).toBe(true);
  });

  it('allows every legitimate move, and always allows detaching', () => {
    expect(wouldCreateCycle(AGENCY, 'solo', 'work')).toBe(false);
    expect(wouldCreateCycle(AGENCY, 'clientB', 'clientA')).toBe(false);
    expect(wouldCreateCycle(AGENCY, 'clientA', null)).toBe(false);
    expect(wouldCreateCycle(AGENCY, null, 'work')).toBe(false);
  });
});

describe('wouldExceedMaxDepth', () => {
  const chain = (n: number) => {
    const g: Record<string, string | null> = { c0: null };
    for (let i = 1; i <= n; i += 1) g[`c${i}`] = `c${i - 1}`;
    return g;
  };

  it('allows a move that lands exactly on the cap', () => {
    // c9 is at depth 9; a leaf moved under it lands at 10 === WORKSPACE_MAX_DEPTH.
    const g = { ...chain(9), leaf: null };
    expect(wouldExceedMaxDepth(g, 'leaf', 'c9')).toBe(false);
  });

  it('rejects the move one level past the cap', () => {
    const g = { ...chain(10), leaf: null };
    expect(wouldExceedMaxDepth(g, 'leaf', 'c10')).toBe(true);
  });

  it('counts the moving workspace SUBTREE, not just the workspace', () => {
    // `sub` is only 1 deep itself, but it drags two levels along with it.
    const g = { ...chain(8), sub: null, subKid: 'sub', subGrandkid: 'subKid' };
    expect(wouldExceedMaxDepth(g, 'sub', 'c7')).toBe(false); // 8 + 2 = 10
    expect(wouldExceedMaxDepth(g, 'sub', 'c8')).toBe(true);  // 9 + 2 = 11
  });
});

describe('effectiveRoles — the inheritance rule', () => {
  it('a member of the parent holds their role in every descendant', () => {
    const roles = { work: 'admin' };
    expect(effectiveRoles(roles, AGENCY, 'work')).toEqual(['admin']);
    expect(effectiveRoles(roles, AGENCY, 'clientA')).toEqual(['admin']);
    expect(effectiveRoles(roles, AGENCY, 'clientA-team')).toEqual(['admin']);
    expect(effectiveRoles(roles, AGENCY, 'clientB')).toEqual(['admin']);
  });

  it('a member of a CHILD gains nothing in the parent — access never flows up', () => {
    const roles = { clientA: 'owner' };
    expect(effectiveRoles(roles, AGENCY, 'clientA')).toEqual(['owner']);
    expect(effectiveRoles(roles, AGENCY, 'work')).toEqual([]);
  });

  it('a member of one client gains nothing in a SIBLING client', () => {
    const roles = { clientA: 'owner' };
    expect(effectiveRoles(roles, AGENCY, 'clientB')).toEqual([]);
    expect(effectiveRoles(roles, AGENCY, 'solo')).toEqual([]);
  });

  it('unions the direct role with the inherited one, nearest first', () => {
    const roles = { work: 'admin', clientA: 'viewer' };
    expect(effectiveRoles(roles, AGENCY, 'clientA')).toEqual(['viewer', 'admin']);
  });

  it('de-duplicates the same role held at several levels', () => {
    const roles = { work: 'editor', clientA: 'editor' };
    expect(effectiveRoles(roles, AGENCY, 'clientA-team')).toEqual(['editor']);
  });
});

describe('roleSetHasCapability / canReachWorkspace', () => {
  it('takes the UNION of capabilities rather than ranking roles', () => {
    // Viewer here, admin above: 'read' from either, 'manage' from the ancestor.
    // No seniority comparison is needed or made.
    expect(roleSetHasCapability(['viewer', 'admin'], 'manage', CAPS)).toBe(true);
    expect(roleSetHasCapability(['viewer'], 'manage', CAPS)).toBe(false);
    expect(roleSetHasCapability([], 'read', CAPS)).toBe(false);
    expect(roleSetHasCapability(['not-a-role'], 'read', CAPS)).toBe(false);
  });

  it('an agency admin can manage a client workspace beneath it', () => {
    expect(canReachWorkspace({
      rolesByWorkspace: { work: 'admin' },
      parentById: AGENCY,
      workspaceId: 'clientA-team',
      capability: 'manage',
      capabilityMap: CAPS,
    })).toBe(true);
  });

  it("a client's owner cannot read the sibling client, at any capability", () => {
    for (const capability of ['read', 'write', 'comment', 'run_agents', 'manage']) {
      expect(canReachWorkspace({
        rolesByWorkspace: { clientA: 'owner' },
        parentById: AGENCY,
        workspaceId: 'clientB',
        capability,
        capabilityMap: CAPS,
      })).toBe(false);
    }
  });

  it("a client's owner cannot read the PARENT agency workspace", () => {
    expect(canReachWorkspace({
      rolesByWorkspace: { clientA: 'owner' },
      parentById: AGENCY,
      workspaceId: 'work',
      capability: 'read',
      capabilityMap: CAPS,
    })).toBe(false);
  });

  it('a viewer of the parent inherits read, but not write, downward', () => {
    const args = {
      rolesByWorkspace: { work: 'viewer' },
      parentById: AGENCY,
      workspaceId: 'clientA',
      capabilityMap: CAPS,
    };
    expect(canReachWorkspace({ ...args, capability: 'read' })).toBe(true);
    expect(canReachWorkspace({ ...args, capability: 'write' })).toBe(false);
    expect(canReachWorkspace({ ...args, capability: 'manage' })).toBe(false);
  });

  it('a cyclic graph cannot be used to manufacture access', () => {
    // Even if a cycle somehow existed, the walk terminates and only the roles
    // actually held on the (capped) chain apply.
    expect(canReachWorkspace({
      rolesByWorkspace: { b: 'owner' },
      parentById: { a: 'b', b: 'a' },
      workspaceId: 'c',
      capability: 'read',
      capabilityMap: CAPS,
    })).toBe(false);
  });
});
