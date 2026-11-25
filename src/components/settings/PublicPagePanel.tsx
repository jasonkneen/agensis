import { useCallback, useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { Button } from '@agensis/ui/components/button';
import { FieldDescription, FieldGroup } from '@agensis/ui/components/field';
import { NativeSelect, NativeSelectOption } from '@agensis/ui/components/native-select';
import { Spinner } from '@agensis/ui/components/spinner';
import { Switch } from '@agensis/ui/components/switch';
import { apiAuthHeaders, apiUrl } from '../../lib/backendClient';

// The owner's controls for the public page (/p/<workspace id>): whether the
// workspace is public at all, and, per event type, whether it leaves and how
// much of it. Every change is manage-gated and written to the audit log by the
// server (server/public-workspace-routes.cjs); a non-manager sees the 403.
//
// The server decides what each level means and caps each type (a memory event
// never shows more than its category); this panel only shows those caps.

type Level = 'public' | 'members' | 'private';
type Detail = 'category' | 'title' | 'full';

interface PolicyState {
  visibility: 'private' | 'public';
  policies: Array<{ eventType: string; level: Level; detail: Detail }>;
  eventTypes: Array<{ eventType: string; category: string; ceiling: Detail }>;
}

const DETAIL_RANK: Record<Detail, number> = { category: 0, title: 1, full: 2 };
const DETAIL_LABEL: Record<Detail, string> = { category: 'Category only', title: 'Title', full: 'Title and detail' };

async function send(path: string, method: string, body?: unknown): Promise<PolicyState> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: { ...apiAuthHeaders(), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(response.status === 403
      ? 'Only someone who can manage this workspace can change its public page.'
      : json?.error?.message || `Request failed (${response.status})`);
  }
  return json.data as PolicyState;
}

export function PublicPagePanel({ workspaceId }: { workspaceId: string | null }) {
  const [state, setState] = useState<PolicyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (task: () => Promise<PolicyState>) => {
    setBusy(true);
    try {
      setState(await task());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    void run(() => send(`/backend/workspaces/${workspaceId}/public-policy`, 'GET'));
  }, [workspaceId, run]);

  if (!workspaceId) return <FieldDescription>Open a workspace to manage its public page.</FieldDescription>;
  if (!state) {
    return error
      ? <FieldDescription className="text-destructive">{error}</FieldDescription>
      : <div className="flex min-h-24 items-center justify-center"><Spinner /></div>;
  }

  const isPublic = state.visibility === 'public';
  const byType = new Map(state.policies.map(row => [row.eventType, row]));
  const pageUrl = `${window.location.origin}/p/${workspaceId}`;

  return (
    <FieldGroup>
      <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-medium"><Globe className="size-4" />Public page</div>
          <FieldDescription>
            When on, anyone with the link sees this workspace&apos;s agents and their status, with no sign-in.
            Activity appears only for the event types you publish below.
          </FieldDescription>
          {isPublic && <a className="mt-1 block truncate text-sm underline" href={pageUrl} target="_blank" rel="noreferrer">{pageUrl}</a>}
        </div>
        <Switch
          aria-label="Make this workspace public"
          checked={isPublic}
          disabled={busy}
          onCheckedChange={checked => void run(() => send(`/backend/workspaces/${workspaceId}/visibility`, 'PATCH', { visibility: checked ? 'public' : 'private' }))}
        />
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-2xs uppercase tracking-wide text-muted-foreground">
            <th className="py-1 font-medium">Event</th>
            <th className="py-1 font-medium">Who sees it</th>
            <th className="py-1 font-medium">How much</th>
          </tr>
        </thead>
        <tbody>
          {state.eventTypes.map(({ eventType, ceiling }) => {
            const row = byType.get(eventType);
            const level: Level = row?.level ?? 'private';
            const detail: Detail = row?.detail ?? 'category';
            const save = (next: { level: Level; detail: Detail }) => void run(() => (
              next.level === 'private'
                ? send(`/backend/workspaces/${workspaceId}/public-policy/${eventType}`, 'DELETE')
                : send(`/backend/workspaces/${workspaceId}/public-policy`, 'PUT', { eventType, ...next })
            ));
            return (
              <tr key={eventType} className="border-t border-border">
                <td className="py-1.5 font-mono text-2xs">{eventType}</td>
                <td className="py-1.5">
                  <NativeSelect
                    aria-label={`Who sees ${eventType}`}
                    value={level}
                    disabled={busy}
                    onChange={event => save({ level: event.target.value as Level, detail })}
                  >
                    <NativeSelectOption value="private">Nobody outside</NativeSelectOption>
                    <NativeSelectOption value="members">Members only</NativeSelectOption>
                    <NativeSelectOption value="public">Public</NativeSelectOption>
                  </NativeSelect>
                </td>
                <td className="py-1.5">
                  <NativeSelect
                    aria-label={`How much of ${eventType}`}
                    value={detail}
                    disabled={busy || level !== 'public'}
                    onChange={event => save({ level, detail: event.target.value as Detail })}
                  >
                    {(Object.keys(DETAIL_RANK) as Detail[])
                      .filter(option => DETAIL_RANK[option] <= DETAIL_RANK[ceiling])
                      .map(option => <NativeSelectOption key={option} value={option}>{DETAIL_LABEL[option]}</NativeSelectOption>)}
                  </NativeSelect>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <FieldDescription>
        Private conversations, direct messages, private projects, prompts, tool arguments, file paths, links, tokens,
        email addresses and memory content never appear on the public page, whatever is chosen here.
      </FieldDescription>
      {error && <FieldDescription className="text-destructive">{error}</FieldDescription>}
      {busy && <Button type="button" variant="ghost" size="sm" disabled><Spinner /> Saving</Button>}
    </FieldGroup>
  );
}
