import { useMemo, useState } from 'react';
import { ArrowLeft, Globe2, Link2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  connectNostrCommunity,
  importableNostrChannels,
  mapNostrChannels,
  previewNostrInvite,
  type NostrChannel,
  type NostrConnectResult,
  type NostrInvitePreview,
} from '@/lib/nostrCommunities';
import type { ConversationMode } from '@/lib/channelMentions';

type ChannelDraft = {
  title: string;
  icon: string;
  description: string;
  intent: string;
  conversation_mode: ConversationMode;
};

interface Props {
  workspaceId: string | null;
  onBack: () => void;
  onClose: () => void;
  onCreate: (draft: ChannelDraft) => Promise<{ id?: string } | null | undefined> | { id?: string } | null | undefined;
}

export function NostrCommunitySetup({ workspaceId, onBack, onClose, onCreate }: Props) {
  const [inviteUrl, setInviteUrl] = useState('');
  const [preview, setPreview] = useState<NostrInvitePreview | null>(null);
  const [connected, setConnected] = useState<NostrConnectResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'connect' | 'import' | null>(null);
  const [error, setError] = useState('');

  const resetConsent = () => {
    setTermsAccepted(false);
    setPrivacyAccepted(false);
    setAgeConfirmed(false);
  };

  const policyReady = useMemo(() => {
    if (!preview?.policy) return true;
    if (preview.policy.termsMarkdown && !termsAccepted) return false;
    if (preview.policy.privacyMarkdown && !privacyAccepted) return false;
    if (preview.policy.ageAttestationRequired && !ageConfirmed) return false;
    return true;
  }, [ageConfirmed, preview?.policy, privacyAccepted, termsAccepted]);

  const inspect = async () => {
    setBusy('preview');
    setError('');
    resetConsent();
    try {
      const next = await previewNostrInvite(inviteUrl.trim());
      setPreview(next);
      setConnected(null);
      setSelected(new Set());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    if (!workspaceId || !preview) return;
    setBusy('connect');
    setError('');
    try {
      const result = await connectNostrCommunity({
        workspaceId,
        inviteUrl: inviteUrl.trim(),
        policyVersion: preview.policy?.version,
        termsAccepted,
        privacyAccepted,
        ageConfirmed,
      });
      setConnected(result);
      setSelected(new Set(importableNostrChannels(result.channels).map(channel => channel.id)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const toggleChannel = (channel: NostrChannel) => {
    if (channel.archived || channel.visibility === 'private') return;
    setSelected(current => {
      const next = new Set(current);
      if (next.has(channel.id)) next.delete(channel.id);
      else next.add(channel.id);
      return next;
    });
  };

  const importChannels = async () => {
    if (!connected || selected.size === 0) return;
    setBusy('import');
    setError('');
    try {
      for (const channel of connected.channels.filter(item => selected.has(item.id))) {
        const session = await onCreate({
          title: channel.name,
          icon: 'globe',
          description: channel.description
            ? `${channel.description} Bridged from ${connected.connection.name} on Nostr.`
            : `Bridged from ${connected.connection.name} on Nostr.`,
          intent:
            'This channel is mirrored with Nostr. Messages cross both ways. Preserve the remote author, keep replies self-contained, and use @mentions when addressing a specific Nostr agent.',
          conversation_mode: 'mention',
        });
        if (!session?.id) throw new Error(`Could not create the Agensis channel for #${channel.name}.`);
        await mapNostrChannels(connected.connection.id, [{ channelId: channel.id, sessionId: session.id }]);
        setSelected(current => {
          const next = new Set(current);
          next.delete(channel.id);
          return next;
        });
      }
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="icon-xs" onClick={onBack} aria-label="Back to templates">
            <ArrowLeft />
          </Button>
          <span className="grid size-7 place-items-center rounded-lg bg-muted">
            <Globe2 className="size-4" />
          </span>
          <DialogTitle>Nostr community</DialogTitle>
        </div>
        <DialogDescription>
          Join a Nostr community and mirror its channels here with live two-way messages and semantic agent mentions.
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
        {!connected && (
          <div className="space-y-2">
            <label className="text-xs font-medium" htmlFor="nostr-invite-url">Nostr invite URL</label>
            <div className="flex gap-2">
              <Input
                id="nostr-invite-url"
                value={inviteUrl}
                onChange={event => {
                  setInviteUrl(event.target.value);
                  if (preview) {
                    setPreview(null);
                    resetConsent();
                  }
                }}
                placeholder="https://community.example/invite/v2.…"
                autoComplete="off"
                spellCheck={false}
              />
              <Button type="button" variant="outline" onClick={() => void inspect()} disabled={!inviteUrl.trim() || busy !== null}>
                <Link2 data-icon="inline-start" />
                {busy === 'preview' ? 'Checking…' : 'Check'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Checking does not consume the invite. The invite code is discarded after a successful join.
            </p>
          </div>
        )}

        {preview && !connected && (
          <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
            <div>
              <div className="font-medium">{preview.name}</div>
              <div className="text-xs text-muted-foreground">{preview.host}</div>
              {preview.description && <p className="mt-1 text-sm text-muted-foreground">{preview.description}</p>}
            </div>

            {preview.policy ? (
              <div className="space-y-3 border-t border-border pt-3">
                <p className="text-sm font-medium">Review this community’s join policy</p>
                {preview.policy.termsMarkdown && (
                  <PolicyCheck
                    checked={termsAccepted}
                    onCheckedChange={setTermsAccepted}
                    label="I accept the community terms"
                    content={preview.policy.termsMarkdown}
                  />
                )}
                {preview.policy.privacyMarkdown && (
                  <PolicyCheck
                    checked={privacyAccepted}
                    onCheckedChange={setPrivacyAccepted}
                    label="I accept the community privacy policy"
                    content={preview.policy.privacyMarkdown}
                  />
                )}
                {preview.policy.ageAttestationRequired && (
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox checked={ageConfirmed} onCheckedChange={value => setAgeConfirmed(value === true)} />
                    <span>I confirm that I meet this community’s age requirement.</span>
                  </label>
                )}
              </div>
            ) : (
              <p className="border-t border-border pt-3 text-xs text-muted-foreground">
                This relay does not publish an additional join policy.
              </p>
            )}

            <div className="flex justify-end">
              <Button type="button" onClick={() => void connect()} disabled={!workspaceId || !policyReady || busy !== null}>
                {busy === 'connect' ? 'Joining…' : 'Join community'}
              </Button>
            </div>
          </div>
        )}

        {connected && (
          <div className="space-y-3">
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
              <div className="font-medium">Connected to {connected.connection.name}</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Choose which accessible Nostr channels become Agensis channels. Agents are not added automatically.
              </p>
            </div>

            <div className="space-y-1">
              {connected.channels.length === 0 && (
                <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
                  This identity cannot currently see any Nostr channels.
                </p>
              )}
              {connected.channels.map(channel => {
                const unavailable = channel.archived || channel.visibility === 'private';
                return (
                  <label key={channel.id} className="flex items-start gap-3 rounded-lg border border-border p-3">
                    <Checkbox
                      checked={selected.has(channel.id)}
                      disabled={unavailable}
                      onCheckedChange={() => toggleChannel(channel)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">#{channel.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {channel.archived
                          ? 'Archived in Nostr'
                          : channel.visibility === 'private'
                            ? 'Private channels stay unavailable until Agensis can preserve equivalent access'
                            : channel.description || (channel.joined ? 'Joined channel' : 'Accessible public channel')}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <div className="flex justify-end gap-2 border-t pt-3">
        <Button type="button" variant="outline" size="sm" onClick={onBack} disabled={busy !== null}>Back</Button>
        {connected && (
          <Button type="button" size="sm" onClick={() => void importChannels()} disabled={selected.size === 0 || busy !== null}>
            <Plus data-icon="inline-start" />
            {busy === 'import' ? 'Importing…' : `Import ${selected.size} channel${selected.size === 1 ? '' : 's'}`}
          </Button>
        )}
      </div>
    </>
  );
}

function PolicyCheck({
  checked, onCheckedChange, label, content,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  content: string;
}) {
  return (
    <div className="space-y-2">
      <div className="max-h-36 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-background p-2 text-xs text-muted-foreground">
        {content}
      </div>
      <label className="flex items-start gap-2 text-sm">
        <Checkbox checked={checked} onCheckedChange={value => onCheckedChange(value === true)} />
        <span>{label}</span>
      </label>
    </div>
  );
}
