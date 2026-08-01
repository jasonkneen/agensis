import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@/components/ui/field';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  RESOURCE_FACETS,
  RESOURCE_FACET_LABELS,
  type AgentPurpose,
  type ResourceFacet,
} from '../../lib/agentPurpose';

interface AgentPurposeFieldsProps {
  purpose: AgentPurpose;
  resourceFacets: ResourceFacet[];
  onPurposeChange: (purpose: AgentPurpose) => void;
  onResourceFacetsChange: (facets: ResourceFacet[]) => void;
}

export function AgentPurposeFields({
  purpose,
  resourceFacets,
  onPurposeChange,
  onResourceFacetsChange,
}: AgentPurposeFieldsProps) {
  const toggleFacet = (facet: ResourceFacet, checked: boolean) => {
    const selected = new Set(resourceFacets);
    if (checked) selected.add(facet);
    else selected.delete(facet);
    onResourceFacetsChange(RESOURCE_FACETS.filter(item => selected.has(item)));
  };

  return (
    <div className="grid gap-3 rounded-lg border bg-muted/20 p-3">
      <Field>
        <FieldLabel htmlFor="agent-purpose">Purpose</FieldLabel>
        <NativeSelect
          id="agent-purpose"
          value={purpose}
          onChange={event => {
            const next = event.target.value === 'resource' ? 'resource' : 'collaborator';
            onPurposeChange(next);
            if (next === 'collaborator') onResourceFacetsChange([]);
          }}
          aria-label="Agent purpose"
        >
          <NativeSelectOption value="collaborator">Collaborator</NativeSelectOption>
          <NativeSelectOption value="resource">Shared resource</NativeSelectOption>
        </NativeSelect>
        <FieldDescription>
          Describes how this agent is used. It does not grant tools, permissions, folders, or placement.
        </FieldDescription>
      </Field>

      {purpose === 'resource' && (
        <Field>
          <FieldLabel>Resource facets</FieldLabel>
          <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Resource facets">
            {RESOURCE_FACETS.map(facet => (
              <label
                key={facet}
                className="flex cursor-pointer items-center gap-2 rounded-md border bg-card/60 px-3 py-2 text-sm"
              >
                <Checkbox
                  checked={resourceFacets.includes(facet)}
                  onCheckedChange={checked => toggleFacet(facet, checked === true)}
                />
                {RESOURCE_FACET_LABELS[facet]}
              </label>
            ))}
          </div>
          <FieldDescription>
            Choose one or more. These labels describe the resource; they are not capabilities.
          </FieldDescription>
        </Field>
      )}
    </div>
  );
}
