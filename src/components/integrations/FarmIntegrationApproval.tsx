import { useEffect, useState } from 'react';
import { Check, KeyRound, Tractor } from 'lucide-react';

import { apiAuthHeaders, apiUrl, backendClient } from '../../lib/backendClient';
import type { Workspace } from '../../types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';

const FARM_SCOPES = [
  'Read workspace identity and agent presence',
  'Enroll and manage Farm-created agents',
  'Dispatch coding jobs to connected agents',
  'List and invoke workspace-shared models',
];

export function FarmIntegrationApproval() {
  const code = new URLSearchParams(window.location.search).get('code')?.trim().toUpperCase() || '';
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [status, setStatus] = useState<'ready' | 'approved' | 'denied' | 'error'>('ready');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    void backendClient.auth.getSession().then(async ({ data }) => {
      if (cancelled) return;
      setSignedIn(Boolean(data.session));
      if (!data.session) { setLoading(false); return; }
      const result = await backendClient.from<Workspace[]>('workspaces').select('*').order('created_at', { ascending: true });
      if (cancelled) return;
      if (result.error) throw new Error(result.error.message || 'Workspaces could not be loaded');
      const rows = result.data || [];
      setWorkspaces(rows);
      setWorkspaceId(rows[0]?.id || '');
      if (rows.length === 0) setMessage('No workspace is available for this connection.');
      setLoading(false);
    }).catch(error => {
      if (cancelled) return;
      setMessage(error instanceof Error ? error.message : String(error));
      setStatus('error');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const decide = async (decision: 'approve' | 'deny') => {
    if (!code || (decision === 'approve' && !workspaceId)) return;
    setLoading(true);
    setMessage('');
    try {
      const response = await fetch(apiUrl(`/backend/integrations/farm/device/${decision}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...apiAuthHeaders() },
        body: JSON.stringify(decision === 'approve' ? { userCode: code, workspaceId } : { userCode: code }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || `Agensis returned HTTP ${response.status}`);
      setStatus(decision === 'approve' ? 'approved' : 'denied');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="grid min-h-svh place-items-center bg-background p-4 text-foreground">
      <Card className="w-full max-w-lg">
        <CardHeader className="gap-3">
          <div className="flex items-center justify-between gap-4">
            <div className="grid size-10 place-items-center rounded-lg bg-primary text-primary-foreground"><Tractor className="size-5" /></div>
            <Badge variant="outline">Agent Farm</Badge>
          </div>
          <div>
            <CardTitle>Connect Farm to Agensis</CardTitle>
            <CardDescription>Approve this device for one workspace. Provider credentials stay on each agent machine or managed sandbox.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex min-h-40 items-center justify-center"><Spinner /></div>
          ) : status === 'approved' ? (
            <div className="space-y-4 py-4 text-center">
              <div className="mx-auto grid size-10 place-items-center rounded-full bg-primary text-primary-foreground"><Check className="size-5" /></div>
              <div><h2 className="font-semibold">Farm is connected</h2><p className="mt-1 text-sm text-muted-foreground">Return to Farm to finish the pairing flow.</p></div>
            </div>
          ) : status === 'denied' ? (
            <div className="py-4 text-center"><h2 className="font-semibold">Request denied</h2><p className="mt-1 text-sm text-muted-foreground">You can close this page.</p></div>
          ) : !signedIn ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">Sign in to Agensis, then reopen this approval link.</p>
              <Button className="w-full" onClick={() => { window.location.href = '/'; }}>Sign in</Button>
            </div>
          ) : (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="farm-code">Device code</FieldLabel>
                <div id="farm-code" className="rounded-md border bg-muted/35 px-3 py-2 font-mono text-sm">{code || 'Missing code'}</div>
              </Field>
              <Field>
                <FieldLabel htmlFor="farm-workspace">Workspace</FieldLabel>
                <NativeSelect id="farm-workspace" value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}>
                  {workspaces.map(workspace => <NativeSelectOption key={workspace.id} value={workspace.id}>{workspace.name}</NativeSelectOption>)}
                </NativeSelect>
                <FieldDescription>Farm access is limited to the workspace you choose here.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Requested access</FieldLabel>
                <div className="space-y-2 rounded-md border bg-muted/25 p-3">
                  {FARM_SCOPES.map(scope => <div key={scope} className="flex gap-2 text-sm"><KeyRound className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /><span>{scope}</span></div>)}
                </div>
              </Field>
              {message && <p className="text-sm text-destructive">{message}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" disabled={!code} onClick={() => void decide('deny')}>Deny</Button>
                <Button disabled={!code || !workspaceId} onClick={() => void decide('approve')}>Approve connection</Button>
              </div>
            </FieldGroup>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
