export const AGENT_PURPOSES = ['collaborator', 'resource'] as const;
export type AgentPurpose = (typeof AGENT_PURPOSES)[number];

export const RESOURCE_FACETS = ['context', 'knowledge', 'tooling', 'code'] as const;
export type ResourceFacet = (typeof RESOURCE_FACETS)[number];

export const RESOURCE_FACET_LABELS: Record<ResourceFacet, string> = {
  context: 'Context',
  knowledge: 'Knowledge',
  tooling: 'Tooling',
  code: 'Code',
};

export function normalizeAgentPurpose(value: unknown): AgentPurpose {
  return value === 'resource' ? 'resource' : 'collaborator';
}

export function normalizeResourceFacets(value: unknown): ResourceFacet[] {
  if (!Array.isArray(value)) return [];
  const selected = new Set(value.filter((item): item is ResourceFacet =>
    typeof item === 'string' && (RESOURCE_FACETS as readonly string[]).includes(item)));
  return RESOURCE_FACETS.filter(facet => selected.has(facet));
}

export function resourceFacetSummary(value: unknown): string {
  const facets = normalizeResourceFacets(value);
  return facets.map(facet => RESOURCE_FACET_LABELS[facet]).join(' + ');
}

/** Creation default only. Reclassifying an existing row never calls this. */
export function defaultAmbientRepliesForPurpose(value: unknown): boolean {
  return normalizeAgentPurpose(value) !== 'resource';
}
