import { Store } from 'lucide-react';
import {
  normalizeAgentPurpose,
  normalizeResourceFacets,
  type AgentPurpose,
  type ResourceFacet,
} from './agentPurpose';
import {
  normalizeAgentRunMode,
  type AgentExecutionRuntime,
  type GalleryTemplate,
  type StoredAgentTemplate,
} from './agentTemplates';

// The agent marketplace, client side. Server validation is
// shared/marketplace.cjs; these types mirror publicMarketplaceListing.
//
// The one property to keep in view here: a 'hire' listing arrives with
// `template: null` — the server never sends the persona body for a hire, and
// nothing in this module invents one. A hire is capabilities-in-the-
// publisher's-words plus a roster entry the server authors; a template is the
// full body, shown before it is copied.

export type MarketplaceListingType = 'template' | 'hire';

export interface MarketplaceListingTemplate {
  slug: string;
  name: string;
  category: string;
  description: string;
  handleHint: string;
  systemPrompt: string;
  soul: string;
  instructions: string;
  tools: string[];
  skills: string[];
  purpose: AgentPurpose;
  resourceFacets: ResourceFacet[];
  model: string;
  runMode: string;
  runtime: string;
  avatar: string;
  accentColor: string;
}

export interface MarketplaceListing {
  id: string;
  slug: string;
  listingType: MarketplaceListingType;
  name: string;
  category: string;
  description: string;
  capabilities: string[];
  purpose: AgentPurpose;
  resourceFacets: ResourceFacet[];
  avatar: string;
  accentColor: string;
  status: string;
  publisher_workspace_id: string;
  installCount: number;
  hireCount: number;
  fingerprint: string;
  created_at?: string;
  updated_at?: string;
  /** Full persona body for a 'template' listing; ALWAYS null for 'hire'. */
  template: MarketplaceListingTemplate | null;
}

export interface MarketplaceHire {
  id: string;
  listing_id: string | null;
  hirer_workspace_id: string;
  hired_agent_id: string;
  host_workspace_id: string | null;
  listing_name: string;
  status: 'active' | 'ended';
  created_at?: string;
  updated_at?: string;
}

/**
 * A template listing as a gallery entry the existing create-flow can apply.
 *
 * The `stored` shape is synthesized so `applyTemplate` picks up soul,
 * instructions and model the same way it does for a workspace-authored
 * template — and, exactly like an authored template, carries NO metadata key:
 * the marketplace shape has no column for one, so there is nothing to spread
 * into the form.
 */
export function marketplaceListingToGalleryTemplate(listing: MarketplaceListing): GalleryTemplate | null {
  const body = listing.template;
  if (listing.listingType !== 'template' || !body) return null;
  const purpose = normalizeAgentPurpose(body.purpose);
  const stored: StoredAgentTemplate = {
    id: `marketplace:${listing.id}`,
    workspace_id: '',
    slug: body.slug || listing.slug,
    name: body.name || listing.name,
    category: body.category || listing.category,
    description: body.description || '',
    handleHint: body.handleHint || '',
    systemPrompt: body.systemPrompt || '',
    soul: body.soul || '',
    instructions: body.instructions || '',
    tools: Array.isArray(body.tools) ? body.tools : [],
    skills: Array.isArray(body.skills) ? body.skills : [],
    purpose,
    resourceFacets: purpose === 'resource' ? normalizeResourceFacets(body.resourceFacets) : [],
    model: body.model || 'auto',
    runMode: normalizeAgentRunMode(body.runMode),
    runtime: body.runtime || '',
    avatar: body.avatar || '',
    accentColor: body.accentColor || '',
    revision: 1,
    source: 'marketplace',
    origin: { marketplaceListingId: listing.id },
    created_by: null,
  };
  return {
    id: stored.id,
    name: stored.name,
    handle: stored.handleHint || stored.slug,
    category: stored.category,
    description: stored.description,
    systemPrompt: stored.systemPrompt,
    tools: [...stored.tools],
    skills: [...stored.skills],
    purpose,
    resourceFacets: [...stored.resourceFacets],
    runMode: stored.runMode,
    runtime: (stored.runtime || undefined) as AgentExecutionRuntime | undefined,
    icon: Store,
    avatar: stored.avatar || undefined,
    stored,
  };
}

/** Capabilities as typed in the share form (one per line) -> bounded list. */
export function parseCapabilityLines(value: string): string[] {
  return value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 12);
}
