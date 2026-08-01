import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  Braces,
  ChevronRight,
  Database,
  Plus,
  RefreshCw,
  Send,
  Wrench,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { WorkspaceAgent } from '@/types';
import {
  RESOURCE_FACETS,
  RESOURCE_OPERATION_KINDS,
  RESOURCE_OPERATION_LABELS,
  RESOURCE_OPERATION_STATUS_LABELS,
  isLiveResourceOperation,
  newResourceOperationKey,
  operationsForResource,
  parseResourceJsonObject,
  resourceAgentFacetSummary,
  resourceFacetLabel,
  resourceOperationToolName,
  resourceStewardCandidates,
  useWorkspaceResources,
  type ResourceFacet,
  type WorkspaceResourceOperation,
  type WorkspaceResourceOperationKind,
} from '@/features/workspace-resources';

interface ResourcesWindowContentProps {
  workspaceId: string;
  agents: WorkspaceAgent[];
}

function timestampLabel(value: string | null): string {
  if (!value) return 'Not recorded';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'Not recorded';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

function jsonPreview(value: Record<string, unknown> | undefined): string {
  if (!value || Object.keys(value).length === 0) return 'No artifact returned.';
  return JSON.stringify(value, null, 2);
}

function OperationRow({
  operation,
  selected,
  onSelect,
}: {
  operation: WorkspaceResourceOperation;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'control-outer-ring flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors',
        selected ? 'border-primary/55 bg-primary/8' : 'border-border/70 bg-card/45 hover:bg-muted/50',
      )}
    >
      <span className={cn(
        'size-2 shrink-0 rounded-full',
        operation.status === 'completed' && 'bg-emerald-500',
        (operation.status === 'pending' || operation.status === 'claimed') && 'bg-amber-500',
        (operation.status === 'failed' || operation.status === 'rejected') && 'bg-destructive',
        operation.status === 'cancelled' && 'bg-muted-foreground/60',
      )} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{RESOURCE_OPERATION_LABELS[operation.operation]}</span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
          {RESOURCE_OPERATION_STATUS_LABELS[operation.status]} · resource v{operation.resource_version}
        </span>
      </span>
      <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
    </button>
  );
}

export function ResourcesWindowContent({ workspaceId, agents }: ResourcesWindowContentProps) {
  const {
    resources,
    operations,
    operationDetails,
    loading,
    error,
    refresh,
    createResource,
    updateResource,
    requestOperation,
    loadOperation,
  } = useWorkspaceResources(workspaceId || null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [facet, setFacet] = useState<ResourceFacet>('context');
  const [stewardAgentId, setStewardAgentId] = useState('');
  const [visibility, setVisibility] = useState<'workspace' | 'restricted'>('workspace');
  const [descriptorJson, setDescriptorJson] = useState('');
  const [operationKind, setOperationKind] = useState<WorkspaceResourceOperationKind>('read');
  const [operationJson, setOperationJson] = useState('');
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const selected = useMemo(
    () => resources.find(resource => resource.id === selectedId) ?? null,
    [resources, selectedId],
  );
  const selectedOperations = useMemo(
    () => operationsForResource(operations, selected?.id ?? null),
    [operations, selected?.id],
  );
  const activeOperation = activeOperationId
    ? operationDetails[activeOperationId]
      ?? operations.find(operation => operation.id === activeOperationId)
      ?? null
    : null;
  const allResourceAgents = useMemo(() => resourceStewardCandidates(agents), [agents]);
  const eligibleStewards = useMemo(
    () => resourceStewardCandidates(agents, facet),
    [agents, facet],
  );
  const stewardById = useMemo(
    () => new Map(agents.map(agent => [agent.id, agent])),
    [agents],
  );

  useEffect(() => {
    if (selectedId && !resources.some(resource => resource.id === selectedId)) setSelectedId(null);
  }, [resources, selectedId]);

  useEffect(() => {
    if (eligibleStewards.some(agent => agent.id === stewardAgentId)) return;
    setStewardAgentId(eligibleStewards[0]?.id ?? '');
  }, [eligibleStewards, stewardAgentId]);

  const resetCreate = () => {
    setName('');
    setDescription('');
    setFacet('context');
    setVisibility('workspace');
    setDescriptorJson('');
    setFormError(null);
  };

  const handleCreate = async () => {
    setFormError(null);
    if (!name.trim()) { setFormError('Give the resource a name.'); return; }
    if (!stewardAgentId) {
      setFormError(`No enabled resource agent supports ${resourceFacetLabel(facet)}.`);
      return;
    }
    let descriptor: Record<string, unknown>;
    try {
      descriptor = parseResourceJsonObject(descriptorJson);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'Descriptor must be valid JSON.');
      return;
    }
    setBusy(true);
    const result = await createResource({
      stewardAgentId,
      name: name.trim(),
      description: description.trim(),
      facet,
      visibility,
      descriptor,
    });
    setBusy(false);
    if (result.error || !result.resource) {
      setFormError(result.error || 'Could not create the resource.');
      return;
    }
    setSelectedId(result.resource.id);
    resetCreate();
    setCreating(false);
  };

  const handleArchiveToggle = async () => {
    if (!selected) return;
    setBusy(true);
    setFormError(null);
    const failure = await updateResource(selected.id, {
      status: selected.status === 'active' ? 'archived' : 'active',
    });
    setBusy(false);
    if (failure) setFormError(failure);
  };

  const handleRequest = async () => {
    if (!selected) return;
    setFormError(null);
    let inputArtifact: Record<string, unknown>;
    try {
      inputArtifact = parseResourceJsonObject(operationJson);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'Operation input must be valid JSON.');
      return;
    }
    setBusy(true);
    const result = await requestOperation(selected.id, {
      operation: operationKind,
      inputArtifact,
      idempotencyKey: newResourceOperationKey(selected.id),
    });
    setBusy(false);
    if (result.error || !result.operation) {
      setFormError(result.error || 'Could not request the operation.');
      return;
    }
    setOperationJson('');
    setActiveOperationId(result.operation.id);
  };

  const handleSelectOperation = async (operation: WorkspaceResourceOperation) => {
    setActiveOperationId(operation.id);
    setFormError(null);
    if (!operationDetails[operation.id]) {
      const failure = await loadOperation(operation.id);
      if (failure) setFormError(failure);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-border p-4">
        <div className="max-w-2xl">
          <div className="text-sm font-semibold">Shared resources</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            A resource agent is the gatekeeper for each context, knowledge, tooling, or code resource.
            People and collaborator agents request work; only its steward reads or changes the underlying resource.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => { void refresh(); }} disabled={loading}>
            <RefreshCw data-icon="inline-start" />
            Refresh
          </Button>
          <Button type="button" size="sm" onClick={() => { resetCreate(); setCreating(value => !value); }}>
            <Plus data-icon="inline-start" />
            New resource
          </Button>
        </div>
      </div>

      {formError && (
        <div role="alert" className="mx-4 mt-3 rounded-lg border border-destructive/35 bg-destructive/8 px-3 py-2 text-xs text-destructive">
          {formError}
        </div>
      )}
      {error && !formError && (
        <div role="alert" className="mx-4 mt-3 rounded-lg border border-destructive/35 bg-destructive/8 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {creating && (
        <div className="mx-4 mt-3 grid shrink-0 gap-3 rounded-xl border border-border bg-muted/20 p-3 sm:grid-cols-2">
          <label className="grid gap-1 text-xs font-medium">
            Name
            <Input value={name} onChange={event => setName(event.target.value)} placeholder="Repository index" />
          </label>
          <label className="grid gap-1 text-xs font-medium">
            Category
            <NativeSelect value={facet} onChange={event => setFacet(event.target.value as ResourceFacet)}>
              {RESOURCE_FACETS.map(value => (
                <NativeSelectOption key={value} value={value}>{resourceFacetLabel(value)}</NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <label className="grid gap-1 text-xs font-medium sm:col-span-2">
            Description
            <Textarea
              value={description}
              onChange={event => setDescription(event.target.value)}
              placeholder="What this resource contains and when teammates should request it"
              rows={2}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium">
            Steward agent
            <NativeSelect value={stewardAgentId} onChange={event => setStewardAgentId(event.target.value)} disabled={eligibleStewards.length === 0}>
              {eligibleStewards.length === 0 && <NativeSelectOption value="">No matching resource agent</NativeSelectOption>}
              {eligibleStewards.map(agent => (
                <NativeSelectOption key={agent.id} value={agent.id}>
                  {agent.name} · {resourceAgentFacetSummary(agent)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <label className="grid gap-1 text-xs font-medium">
            Agent visibility
            <NativeSelect value={visibility} onChange={event => setVisibility(event.target.value === 'restricted' ? 'restricted' : 'workspace')}>
              <NativeSelectOption value="workspace">Workspace agents</NativeSelectOption>
              <NativeSelectOption value="restricted">Steward only</NativeSelectOption>
            </NativeSelect>
          </label>
          <label className="grid gap-1 text-xs font-medium sm:col-span-2">
            Descriptor JSON <span className="font-normal text-muted-foreground">Optional metadata, never credentials</span>
            <Textarea
              value={descriptorJson}
              onChange={event => setDescriptorJson(event.target.value)}
              placeholder={'{\n  "repository": "acme/product"\n}'}
              rows={3}
              className="font-mono text-xs"
            />
          </label>
          {allResourceAgents.length === 0 && (
            <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2">
              Create an agent with purpose “Shared resource” in the Agents window first, then select the facets it can steward.
            </p>
          )}
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setCreating(false)} disabled={busy}>Cancel</Button>
            <Button type="button" size="sm" onClick={() => { void handleCreate(); }} disabled={busy || !stewardAgentId}>
              {busy && <Spinner />}
              Create resource
            </Button>
          </div>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[minmax(220px,0.38fr)_minmax(0,1fr)]">
        <div className="min-h-0 overflow-y-auto border-b border-border p-3 md:border-b-0 md:border-r">
          {loading && resources.length === 0 ? (
            <div className="flex h-40 items-center justify-center"><Spinner /></div>
          ) : resources.length === 0 ? (
            <Empty className="min-h-48 border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon"><Database /></EmptyMedia>
                <EmptyTitle>No shared resources yet</EmptyTitle>
                <EmptyDescription>Add a resource agent, then give it stewardship of context, knowledge, tooling, or code.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="space-y-2">
              {resources.map(resource => {
                const steward = stewardById.get(resource.steward_agent_id);
                return (
                  <button
                    key={resource.id}
                    type="button"
                    onClick={() => { setSelectedId(resource.id); setActiveOperationId(null); setFormError(null); }}
                    className={cn(
                      'control-outer-ring w-full rounded-xl border p-3 text-left transition-colors',
                      selectedId === resource.id
                        ? 'border-primary/60 bg-primary/8'
                        : 'border-border/70 bg-card/45 hover:bg-muted/50',
                      resource.status === 'archived' && 'opacity-65',
                    )}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{resource.name}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                          {steward?.name || 'Missing steward'} · v{resource.version}
                        </span>
                      </span>
                      <Badge variant="outline" className="shrink-0">{resourceFacetLabel(resource.facet)}</Badge>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="min-h-0 overflow-y-auto p-4">
          {!selected ? (
            <Empty className="min-h-64 border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon"><BookOpen /></EmptyMedia>
                <EmptyTitle>Select a resource</EmptyTitle>
                <EmptyDescription>Inspect its steward, request work, and follow the resulting operation here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="mx-auto max-w-3xl space-y-5">
              <section>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-lg font-semibold">{selected.name}</h2>
                      <Badge variant={selected.status === 'active' ? 'default' : 'outline'}>{selected.status}</Badge>
                      <Badge variant="outline">{resourceFacetLabel(selected.facet)}</Badge>
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      {selected.description || 'No description has been added.'}
                    </p>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => { void handleArchiveToggle(); }} disabled={busy}>
                    {selected.status === 'active'
                      ? <><Archive data-icon="inline-start" />Archive</>
                      : <><ArchiveRestore data-icon="inline-start" />Restore</>}
                  </Button>
                </div>
                <dl className="mt-4 grid gap-3 rounded-xl border border-border bg-muted/15 p-3 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">Steward</dt>
                    <dd className="mt-0.5 font-medium">{stewardById.get(selected.steward_agent_id)?.name || 'Agent unavailable'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Resource version</dt>
                    <dd className="mt-0.5 font-medium">{selected.version}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Agent visibility</dt>
                    <dd className="mt-0.5 font-medium">{selected.visibility === 'workspace' ? 'Workspace agents' : 'Steward only'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Last changed</dt>
                    <dd className="mt-0.5 font-medium">{timestampLabel(selected.updated_at)}</dd>
                  </div>
                </dl>
              </section>

              <section className="rounded-xl border border-border bg-card/35 p-4">
                <div className="flex items-center gap-2">
                  <Wrench size={15} />
                  <h3 className="text-sm font-semibold">Operation tool names</h3>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Every agent's calls to this resource still route through the steward below — direct-call
                  permissions aren't wired up yet, so these are the names a future grant would unlock.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {RESOURCE_OPERATION_KINDS.map(kind => (
                    <Badge key={kind} variant="outline" className="font-mono text-[11px] font-normal">
                      {resourceOperationToolName(selected.name, kind)}
                    </Badge>
                  ))}
                </div>
              </section>

              <section className="rounded-xl border border-border bg-card/35 p-4">
                <div className="flex items-center gap-2">
                  <Send size={15} />
                  <h3 className="text-sm font-semibold">Request steward work</h3>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  This queues a request. It does not mutate the resource directly and cannot bypass the steward agent.
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
                  <label className="grid content-start gap-1 text-xs font-medium">
                    Operation
                    <NativeSelect value={operationKind} onChange={event => setOperationKind(event.target.value as WorkspaceResourceOperationKind)}>
                      {(Object.keys(RESOURCE_OPERATION_LABELS) as WorkspaceResourceOperationKind[]).map(value => (
                        <NativeSelectOption key={value} value={value}>{RESOURCE_OPERATION_LABELS[value]}</NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </label>
                  <label className="grid gap-1 text-xs font-medium">
                    Input artifact JSON <span className="font-normal text-muted-foreground">Optional instructions or proposed data</span>
                    <Textarea
                      value={operationJson}
                      onChange={event => setOperationJson(event.target.value)}
                      placeholder={'{\n  "request": "Summarise the current API boundaries"\n}'}
                      rows={4}
                      className="font-mono text-xs"
                    />
                  </label>
                </div>
                <div className="mt-3 flex justify-end">
                  <Button type="button" size="sm" onClick={() => { void handleRequest(); }} disabled={busy || selected.status !== 'active'}>
                    {busy && <Spinner />}
                    Queue request
                  </Button>
                </div>
              </section>

              <section>
                <div className="flex items-center gap-2">
                  <Braces size={15} />
                  <h3 className="text-sm font-semibold">Operation history</h3>
                  {selectedOperations.some(isLiveResourceOperation) && <Badge variant="outline">Live</Badge>}
                </div>
                {selectedOperations.length === 0 ? (
                  <p className="mt-3 rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">
                    No work has been requested from this steward yet.
                  </p>
                ) : (
                  <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(180px,0.7fr)_minmax(0,1fr)]">
                    <div className="space-y-2">
                      {selectedOperations.map(operation => (
                        <OperationRow
                          key={operation.id}
                          operation={operation}
                          selected={activeOperationId === operation.id}
                          onSelect={() => { void handleSelectOperation(operation); }}
                        />
                      ))}
                    </div>
                    <div className="min-h-40 rounded-xl border border-border bg-muted/15 p-3">
                      {!activeOperation ? (
                        <p className="text-xs text-muted-foreground">Select an operation to inspect its request and result.</p>
                      ) : (
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <div className="text-xs font-semibold">{RESOURCE_OPERATION_LABELS[activeOperation.operation]}</div>
                              <div className="mt-0.5 text-[11px] text-muted-foreground">{timestampLabel(activeOperation.created_at)}</div>
                            </div>
                            <Badge variant="outline">{RESOURCE_OPERATION_STATUS_LABELS[activeOperation.status]}</Badge>
                          </div>
                          {activeOperation.error && (
                            <div className="rounded-lg border border-destructive/30 bg-destructive/8 p-2 text-xs text-destructive">
                              {activeOperation.error}
                            </div>
                          )}
                          <div>
                            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Input</div>
                            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-background/70 p-2 text-[11px] leading-relaxed">
                              {jsonPreview(activeOperation.input_artifact)}
                            </pre>
                          </div>
                          <div>
                            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Result</div>
                            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-background/70 p-2 text-[11px] leading-relaxed">
                              {isLiveResourceOperation(activeOperation)
                                ? 'Waiting for the steward agent.'
                                : jsonPreview(activeOperation.output_artifact)}
                            </pre>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ResourcesWindowContent;
