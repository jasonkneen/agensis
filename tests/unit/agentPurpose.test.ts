import { describe, expect, it } from 'vitest';
import {
  defaultAmbientRepliesForPurpose,
  normalizeAgentPurpose,
  normalizeResourceFacets,
  resourceFacetSummary,
} from '../../src/lib/agentPurpose';

describe('agent purpose', () => {
  it('defaults every legacy or unknown value to collaborator', () => {
    expect(normalizeAgentPurpose(undefined)).toBe('collaborator');
    expect(normalizeAgentPurpose('future-kind')).toBe('collaborator');
    expect(normalizeAgentPurpose('resource')).toBe('resource');
  });

  it('normalizes resource facets to the closed canonical set', () => {
    expect(normalizeResourceFacets(['code', 'unknown', 'context', 'code'])).toEqual(['context', 'code']);
    expect(resourceFacetSummary(['code', 'tooling'])).toBe('Tooling + Code');
  });

  it('makes new resources opt out of ambient replies without changing collaborator defaults', () => {
    expect(defaultAmbientRepliesForPurpose('resource')).toBe(false);
    expect(defaultAmbientRepliesForPurpose('collaborator')).toBe(true);
    expect(defaultAmbientRepliesForPurpose(undefined)).toBe(true);
  });
});
