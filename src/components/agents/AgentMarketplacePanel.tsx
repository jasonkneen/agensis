import { useMemo, useState } from 'react';
import { BriefcaseBusiness, Check, Copy, Search, Store } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useMarketplace } from '../../hooks/useMarketplace';
import {
  marketplaceListingToGalleryTemplate,
  parseCapabilityLines,
  type MarketplaceListing,
  type MarketplaceListingType,
} from '../../lib/marketplace';
import type { GalleryTemplate } from '../../lib/agentTemplates';

// The marketplace surfaces inside the Agents window.
//
// Two honest sentences this UI must keep saying, mirroring the validator
// (shared/marketplace.cjs):
//   - A TEMPLATE listing shares the full definition, and copying it is
//     review-before-instantiate: "Use" prefills the existing create form and
//     nothing exists until a person submits it.
//   - A HIRE listing shares capabilities only. The definition stays with the
//     publisher; the hired roster entry is a Connector the host serves, and
//     turns queue with an explicit waiting notice while the host is offline.

const TYPE_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'template', label: 'Templates' },
  { id: 'hire', label: 'For hire' },
] as const;

type TypeFilter = (typeof TYPE_FILTERS)[number]['id'];

interface MarketplaceMessage {
  ok: boolean;
  text: string;
}

export function AgentMarketplaceSection({
  workspaceId,
  onUseTemplate,
}: {
  workspaceId: string | null;
  onUseTemplate: (tpl: GalleryTemplate) => void;
}) {
  const { listings, loading, unavailable, copyListing, hireListing } = useMarketplace(workspaceId);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [message, setMessage] = useState<MarketplaceMessage | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return listings.filter(listing =>
      (typeFilter === 'all' || listing.listingType === typeFilter) &&
      (q === '' || `${listing.name} ${listing.description} ${listing.category} ${listing.capabilities.join(' ')}`.toLowerCase().includes(q)));
  }, [listings, query, typeFilter]);

  // The section disappears entirely when the server has no marketplace routes
  // (or nothing is published) — the create flow reads exactly as it did before
  // the feature, which is also the rollback story.
  if (unavailable || (!loading && listings.length === 0)) return null;

  const handleCopy = async (listing: MarketplaceListing) => {
    setBusyId(listing.id);
    setMessage(null);
    const failure = await copyListing(listing.id);
    setBusyId(null);
    setMessage(failure
      ? { ok: false, text: failure }
      : { ok: true, text: `Saved ${listing.name} to this workspace's templates.` });
  };

  const handleHire = async (listing: MarketplaceListing) => {
    setBusyId(listing.id);
    setMessage(null);
    const failure = await hireListing(listing.id);
    setBusyId(null);
    setMessage(failure
      ? { ok: false, text: failure }
      : { ok: true, text: `Hired ${listing.name} — it is in your roster. Turns wait for the host while it is offline.` });
  };

  return (
    <div className="mt-6">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Store className="size-3.5" />
          Marketplace
        </span>
        <div className="flex flex-wrap gap-1.5">
          {TYPE_FILTERS.map(filter => (
            <button
              key={filter.id}
              type="button"
              onClick={() => setTypeFilter(filter.id)}
              className={cn(
                'control-outer-ring rounded-lg border px-2.5 py-1 text-xs font-medium transition',
                typeFilter === filter.id
                  ? 'border-primary/60 bg-primary/15 text-foreground'
                  : 'border-border bg-card/40 text-muted-foreground hover:bg-muted/50 hover:text-foreground',
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>
      {/* Said up front, like the template-import note: what each action lets
          in. A template is prose you will read in the form before creating
          anything; a hired agent brings NO prose at all — and answers with
          whatever its host runs, so hire from publishers you trust. */}
      <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
        Templates shared by other workspaces — “Use” shows the full definition in the create form before anything is saved.
        Agents offered for hire keep their definition with their host; you get a roster entry with the capabilities listed,
        served by the publisher’s own runtime.
      </p>
      {message && (
        <div className={cn(
          'mb-2 rounded-lg border px-2.5 py-1.5 text-xs',
          message.ok
            ? 'border-border bg-card/40 text-muted-foreground'
            : 'border-destructive/40 bg-destructive/10 text-destructive',
        )}>
          {message.text}
        </div>
      )}
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search the marketplace"
          className="h-8 pl-8 text-sm"
        />
      </div>
      {filtered.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">No marketplace listings match.</div>
      ) : (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
          {filtered.map(listing => {
            const isHire = listing.listingType === 'hire';
            const gallery = isHire ? null : marketplaceListingToGalleryTemplate(listing);
            return (
              <div
                key={listing.id}
                className="flex min-h-[150px] flex-col items-start gap-2 rounded-xl border border-border bg-card/40 p-4 text-left"
              >
                <div className="flex w-full items-start justify-between gap-2">
                  <span className="grid size-9 place-items-center rounded-lg bg-muted">
                    {isHire ? <BriefcaseBusiness className="size-5" /> : <Store className="size-5" />}
                  </span>
                  <span className={cn(
                    'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                    isHire
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                      : 'border-primary/40 bg-primary/10 text-primary',
                  )}>
                    {isHire ? 'For hire' : 'Template'}
                  </span>
                </div>
                <span className="text-sm font-semibold">{listing.name}</span>
                {listing.description && (
                  <span className="line-clamp-2 text-xs text-muted-foreground">{listing.description}</span>
                )}
                {listing.capabilities.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {listing.capabilities.slice(0, 4).map(capability => (
                      <span key={capability} className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {capability}
                      </span>
                    ))}
                    {listing.capabilities.length > 4 && (
                      <span className="px-1 text-[10px] text-muted-foreground">+{listing.capabilities.length - 4}</span>
                    )}
                  </div>
                )}
                <div className="mt-auto flex w-full items-center justify-between gap-2 pt-1">
                  <span className="text-[11px] text-muted-foreground opacity-70">
                    {listing.category}
                    {isHire
                      ? (listing.hireCount > 0 ? ` · hired ${listing.hireCount}×` : '')
                      : (listing.installCount > 0 ? ` · copied ${listing.installCount}×` : '')}
                  </span>
                  <div className="flex gap-1.5">
                    {gallery && (
                      <>
                        <Button type="button" size="xs" variant="outline" onClick={() => onUseTemplate(gallery)}>
                          Use
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          title="Save a copy into this workspace's templates (needs manage)"
                          disabled={busyId === listing.id}
                          onClick={() => { void handleCopy(listing); }}
                        >
                          <Copy data-icon="inline-start" />
                          Save
                        </Button>
                      </>
                    )}
                    {isHire && (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={busyId === listing.id}
                        onClick={() => { void handleHire(listing); }}
                      >
                        {busyId === listing.id ? 'Hiring…' : 'Hire'}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ShareAgentToMarketplaceDialog({
  workspaceId,
  agent,
  open,
  onClose,
}: {
  workspaceId: string | null;
  agent: { id: string; name: string; description?: string } | null;
  open: boolean;
  onClose: () => void;
}) {
  const { publishListing } = useMarketplace(open ? workspaceId : null);
  const [listingType, setListingType] = useState<MarketplaceListingType>('template');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [capabilitiesText, setCapabilitiesText] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [message, setMessage] = useState<MarketplaceMessage | null>(null);

  const submit = async () => {
    if (!agent) return;
    setPublishing(true);
    setMessage(null);
    const failure = await publishListing(agent.id, {
      listingType,
      name: name.trim() || agent.name,
      description: description.trim() || agent.description || '',
      capabilities: parseCapabilityLines(capabilitiesText),
    });
    setPublishing(false);
    setMessage(failure
      ? { ok: false, text: failure }
      : { ok: true, text: listingType === 'hire'
        ? 'Published for hire. Other workspaces see the capabilities you listed — never the prompt or skills.'
        : 'Published. Other workspaces can now read and copy this agent’s full definition.' });
  };

  return (
    <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Share {agent?.name || 'agent'} to the marketplace</DialogTitle>
          <DialogDescription>
            {listingType === 'hire'
              ? 'Offer this agent for hire. Its prompt, soul, instructions and skills stay in this workspace — hirers see only the name, description and capabilities below, and its permissions and folder access are never shared.'
              : 'Share this agent’s prose as a copyable template: prompt, soul, instructions and skill names. Its permissions, folder access, connect token and other authority are never part of a listing.'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            How is it shared?
            <NativeSelect value={listingType} onChange={e => setListingType(e.target.value as MarketplaceListingType)}>
              <NativeSelectOption value="template">As a template — the full definition is copyable</NativeSelectOption>
              <NativeSelectOption value="hire">For hire — capabilities only, served by this workspace</NativeSelectOption>
            </NativeSelect>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Listing name
            <Input value={name} onChange={e => setName(e.target.value)} placeholder={agent?.name || 'Name'} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Description
            <Textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={2}
              placeholder={agent?.description || 'What is this agent for?'}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Capabilities (one per line{listingType === 'hire' ? ', required — this is all a hirer sees' : ''})
            <Textarea
              value={capabilitiesText}
              onChange={e => setCapabilitiesText(e.target.value)}
              rows={3}
              placeholder={'Reviews pull requests\nSummarizes long threads'}
            />
          </label>
          {message && (
            <div className={cn(
              'rounded-lg border px-2.5 py-1.5 text-xs',
              message.ok
                ? 'border-border bg-card/40 text-muted-foreground'
                : 'border-destructive/40 bg-destructive/10 text-destructive',
            )}>
              {message.ok && <Check className="mr-1 inline size-3.5" />}
              {message.text}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
            <Button type="button" disabled={publishing || !agent} onClick={() => { void submit(); }}>
              {publishing ? 'Publishing…' : 'Publish'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
