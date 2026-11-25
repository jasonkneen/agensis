import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@agensis/ui/components/badge';
import { Spinner } from '@agensis/ui/components/spinner';
import { apiUrl } from '../../lib/backendClient';
import {
  PublicWorkspaceNotFound,
  applyPublicAgent,
  fetchPublicEvents,
  fetchPublicSummary,
  mergePublicEvents,
  publicAgentConnections,
  publicAgentToWorkspaceAgent,
  publicWorkspaceUrls,
  type PublicAgent,
  type PublicEvent,
  type PublicWorkspaceSummary,
} from '../../lib/publicWorkspace';
import { AgentNetworkDiagram } from '../windows/AgentNetworkDiagram';

// The public network map: /p/<workspace id>, no sign-in.
//
// It renders the SAME AgentNetworkDiagram the Agents window uses, fed only
// from the public summary and stream (shared/public-workspace.cjs is the only
// thing that decides what is in them). No sessions and no tasks are passed, so
// the map has nothing to drill into below the agents.
//
// Live updates come from the SSE stream on the long-running backend. Where the
// stream is unavailable (the Netlify mirror answers 501), the page polls the
// summary and the events instead.

const POLL_MS = 10_000;

export function PublicWorkspacePage({ workspaceId }: { workspaceId: string }) {
  const [summary, setSummary] = useState<PublicWorkspaceSummary | null>(null);
  const [events, setEvents] = useState<PublicEvent[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'not_found' | 'error'>('loading');
  const cursor = useRef<string>('');

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      try {
        const [nextSummary, page] = await Promise.all([
          fetchPublicSummary(apiUrl, workspaceId),
          fetchPublicEvents(apiUrl, workspaceId, cursor.current || undefined),
        ]);
        if (cancelled) return;
        cursor.current = page.next;
        setSummary(nextSummary);
        setEvents(current => mergePublicEvents(current, page.events));
      } catch (error) {
        if (cancelled) return;
        if (error instanceof PublicWorkspaceNotFound) {
          setState('not_found');
          if (pollTimer) clearInterval(pollTimer);
        }
      }
    };

    const startPolling = () => {
      if (pollTimer || cancelled) return;
      pollTimer = setInterval(() => { void poll(); }, POLL_MS);
    };

    void (async () => {
      try {
        const [first, page] = await Promise.all([
          fetchPublicSummary(apiUrl, workspaceId),
          fetchPublicEvents(apiUrl, workspaceId),
        ]);
        if (cancelled) return;
        cursor.current = page.next;
        setSummary(first);
        setEvents(page.events);
        setState('ready');
      } catch (error) {
        if (!cancelled) setState(error instanceof PublicWorkspaceNotFound ? 'not_found' : 'error');
        return;
      }
      if (typeof EventSource === 'undefined') {
        startPolling();
        return;
      }
      source = new EventSource(publicWorkspaceUrls(apiUrl, workspaceId).stream);
      source.addEventListener('snapshot', (message) => {
        setSummary(JSON.parse((message as MessageEvent<string>).data) as PublicWorkspaceSummary);
      });
      source.addEventListener('agent', (message) => {
        const agent = JSON.parse((message as MessageEvent<string>).data) as PublicAgent;
        setSummary(current => (current ? applyPublicAgent(current, agent) : current));
      });
      source.addEventListener('event', (message) => {
        const event = JSON.parse((message as MessageEvent<string>).data) as PublicEvent;
        cursor.current = event.at;
        setEvents(current => mergePublicEvents(current, [event]));
      });
      // A refused stream (501 on the mirror, 429, or the workspace going
      // private) closes here; polling takes over and reports a 404 if any.
      source.onerror = () => {
        source?.close();
        source = null;
        startPolling();
      };
    })();

    return () => {
      cancelled = true;
      source?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [workspaceId]);

  const agents = useMemo(
    () => (summary ? summary.agents.map(agent => publicAgentToWorkspaceAgent(agent, summary.id)) : []),
    [summary],
  );
  const connections = useMemo(
    () => (summary ? publicAgentConnections(summary.agents, summary.id) : []),
    [summary],
  );

  if (state === 'loading') {
    return <main className="grid min-h-svh place-items-center bg-background text-foreground"><Spinner /></main>;
  }
  if (state === 'not_found' || !summary) {
    return (
      <main className="grid min-h-svh place-items-center bg-background p-6 text-center text-foreground">
        <div>
          <h1 className="text-lg font-semibold">{state === 'error' ? 'This page could not be loaded' : 'Nothing to see here'}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {state === 'error' ? 'Try again in a moment.' : 'This workspace is not public, or it does not exist.'}
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-svh flex-col bg-background text-foreground" data-public-workspace={summary.id}>
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        {summary.icon && <span className="text-xl" aria-hidden>{summary.icon}</span>}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">{summary.name}</h1>
          {summary.description && <p className="truncate text-sm text-muted-foreground">{summary.description}</p>}
        </div>
        <div className="flex gap-1.5">
          <Badge variant="outline">{summary.counts.agents} agents</Badge>
          <Badge variant="outline">{summary.counts.busy} busy</Badge>
          <Badge variant="outline">{summary.counts.idle} idle</Badge>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_20rem]">
        <section className="min-h-[28rem] overflow-hidden" aria-label="Agent network">
          <AgentNetworkDiagram agents={agents} connections={connections} workspaceName={summary.name} />
        </section>
        <aside className="min-h-0 overflow-y-auto border-t border-border p-3 lg:border-l lg:border-t-0" aria-label="Recent activity">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent activity</h2>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing public yet.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {[...events].reverse().map(event => (
                <li key={event.id} className="rounded-md border border-border px-2.5 py-2 text-sm">
                  <div className="flex items-center gap-2 text-2xs text-muted-foreground">
                    <span className="uppercase tracking-wide">{event.category}</span>
                    <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time>
                  </div>
                  <div className="mt-0.5">{event.title || event.type.replace(/_/g, ' ')}</div>
                  {event.actor && <div className="text-2xs text-muted-foreground">{event.actor.name}</div>}
                  {event.detail && <p className="mt-1 text-2xs text-muted-foreground">{event.detail}</p>}
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>
    </main>
  );
}
