import { memo, useState } from 'react';
import {
  Check,
  Crown,
  Link2,
  Mail,
  Plus,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react';
import type { WorkspaceUser, WorkspaceInvite, InviteRole } from '../../hooks/useWorkspaceUsers';
import { inviteUrl } from '../../hooks/useWorkspaceUsers';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';

interface UsersWindowContentProps {
  workspaceName: string;
  currentUserId?: string;
  currentUserEmail?: string;
  inviteOrigin: string;
  members: WorkspaceUser[];
  invites: WorkspaceInvite[];
  loading?: boolean;
  onCreateInvite: (role: InviteRole, email?: string) => Promise<WorkspaceInvite | null>;
  onRevokeInvite: (inviteId: string) => Promise<void>;
  onRemoveMember: (memberId: string) => Promise<void>;
  onChangeMemberRole: (memberId: string, role: 'editor' | 'viewer') => Promise<void>;
}

export const UsersWindowContent = memo(function UsersWindowContent({
  workspaceName,
  currentUserId,
  currentUserEmail,
  inviteOrigin,
  members,
  invites,
  loading = false,
  onCreateInvite,
  onRevokeInvite,
  onRemoveMember,
  onChangeMemberRole,
}: UsersWindowContentProps) {
  const [newRole, setNewRole] = useState<InviteRole>('editor');
  const [newEmail, setNewEmail] = useState('');
  const [creating, setCreating] = useState(false);
  const [copiedCreate, setCopiedCreate] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const handleCreateInvite = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const email = newEmail.trim();
      const invite = await onCreateInvite(newRole, email ? email : undefined);
      if (invite) {
        await navigator.clipboard?.writeText(inviteUrl(inviteOrigin, invite.token));
        setNewEmail('');
        setCopiedCreate(true);
        window.setTimeout(() => setCopiedCreate(false), 1600);
      }
    } finally {
      setCreating(false);
    }
  };

  const handleRemove = (memberId: string) => {
    if (confirmRemoveId === memberId) {
      void onRemoveMember(memberId);
      setConfirmRemoveId(null);
      return;
    }
    setConfirmRemoveId(memberId);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent text-foreground">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card/65 px-3 backdrop-blur-md">
        <Users className="size-4 text-primary" />
        <span className="text-sm font-semibold">Users</span>
        <Badge variant="secondary">{members.length}</Badge>
        {loading && <Spinner className="size-3.5 text-muted-foreground" />}
        <div className="flex-1" />
        <span className="max-w-[40%] truncate text-xs text-muted-foreground" title={workspaceName}>
          {workspaceName}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
            Loading…
          </div>
        )}

        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Users className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">Members</h2>
            <Badge variant="secondary">{members.length}</Badge>
          </div>

          {members.length === 0 ? (
            <Empty className="border-0 py-6">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Users />
                </EmptyMedia>
                <EmptyTitle>No members yet</EmptyTitle>
                <EmptyDescription>Invite people below to start collaborating in {workspaceName}.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup className="gap-1">
              {members.map((member) => {
                const memberId = member.id;
                const isYou = member.user_id === currentUserId;
                // The backend leaves email blank when a participant has no
                // app_users row; for the current user we know it from the session.
                const displayEmail = member.email || (isYou ? currentUserEmail ?? '' : '');
                const canManage = memberId !== null && member.role !== 'owner' && !isYou;
                return (
                  <Item key={memberId ?? member.user_id} variant="outline">
                    <ItemMedia className="size-9 items-center justify-center rounded-full bg-muted text-sm font-semibold uppercase text-muted-foreground">
                      {displayEmail ? displayEmail.charAt(0).toUpperCase() : <UserRound className="size-4" />}
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="truncate font-semibold">
                        {displayEmail || (member.role === 'owner' ? 'Workspace owner' : 'Unknown user')}
                        {isYou ? ' (you)' : ''}
                      </ItemTitle>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant={roleBadgeVariant(member.role)}>
                          {member.role === 'owner' && <Crown data-icon="inline-start" />}
                          {member.role}
                        </Badge>
                      </div>
                    </ItemContent>
                    {canManage && memberId !== null && (
                      <ItemActions>
                        <NativeSelect
                          size="sm"
                          aria-label={`Change role for ${member.email}`}
                          value={member.role === 'viewer' ? 'viewer' : 'editor'}
                          onChange={(e) => {
                            const v = e.target.value;
                            void onChangeMemberRole(memberId, v === 'viewer' ? 'viewer' : 'editor');
                          }}
                        >
                          <NativeSelectOption value="editor">Editor</NativeSelectOption>
                          <NativeSelectOption value="viewer">Viewer</NativeSelectOption>
                        </NativeSelect>
                        <Button
                          type="button"
                          variant={confirmRemoveId === memberId ? 'destructive' : 'ghost'}
                          size="icon-xs"
                          aria-label={confirmRemoveId === memberId ? `Confirm remove ${member.email}` : `Remove ${member.email}`}
                          title={confirmRemoveId === memberId ? 'Click again to remove' : 'Remove member'}
                          onClick={() => handleRemove(memberId)}
                        >
                          <Trash2 />
                        </Button>
                      </ItemActions>
                    )}
                  </Item>
                );
              })}
            </ItemGroup>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Link2 className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">Invite links</h2>
            <Badge variant="secondary">{invites.length}</Badge>
          </div>

          <div className="rounded-lg border bg-card/55 p-3 backdrop-blur-md">
            <div className="flex flex-wrap items-end gap-2">
              <Field className="w-auto">
                <FieldLabel htmlFor="invite-role">Role</FieldLabel>
                <NativeSelect
                  id="invite-role"
                  size="sm"
                  value={newRole}
                  onChange={(e) => {
                    const v = e.target.value;
                    setNewRole(v === 'admin' || v === 'commenter' || v === 'viewer' ? v : 'editor');
                  }}
                >
                  <NativeSelectOption value="admin">Admin</NativeSelectOption>
                  <NativeSelectOption value="editor">Editor</NativeSelectOption>
                  <NativeSelectOption value="commenter">Commenter</NativeSelectOption>
                  <NativeSelectOption value="viewer">Viewer</NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field className="min-w-48 flex-1">
                <FieldLabel htmlFor="invite-email">Email</FieldLabel>
                <Input
                  id="invite-email"
                  type="email"
                  placeholder="name@email.com (optional)"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                />
              </Field>
              <Button type="button" size="sm" onClick={() => void handleCreateInvite()} disabled={creating}>
                {creating ? (
                  <Spinner data-icon="inline-start" />
                ) : copiedCreate ? (
                  <Check data-icon="inline-start" />
                ) : (
                  <Plus data-icon="inline-start" />
                )}
                {copiedCreate ? 'Link copied' : 'Create invite link'}
              </Button>
            </div>
          </div>

          {invites.length === 0 ? (
            <Empty className="border-0 py-5">
              <EmptyHeader>
                <EmptyMedia variant="icon" className="size-9">
                  <Link2 className="size-4" />
                </EmptyMedia>
                <EmptyTitle className="text-sm">No invite links yet</EmptyTitle>
                <EmptyDescription>Links you create will appear here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup className="gap-1">
              {invites.map((invite) => (
                <Item key={invite.id} variant="outline">
                  <ItemMedia className="size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    {invite.email ? <Mail className="size-4" /> : <Link2 className="size-4" />}
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="truncate">{invite.email || 'Anyone with the link'}</ItemTitle>
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge variant={roleBadgeVariant(invite.role)}>{invite.role}</Badge>
                      <InviteStatusBadge status={invite.status} />
                      {invite.created_at && (
                        <span className="text-xs text-muted-foreground">{formatInviteDate(invite.created_at)}</span>
                      )}
                    </div>
                    {invite.status === 'accepted' && invite.accepted_by_email && (
                      <ItemDescription>Accepted by {invite.accepted_by_email}</ItemDescription>
                    )}
                  </ItemContent>
                  {invite.status === 'pending' && (
                    <ItemActions>
                      {/* The invite link is shown once at creation and stored
                          only as a hash, so it can't be re-copied here (L4).
                          Revoke and create a new one if the link was lost. */}
                      <span className="text-xs text-muted-foreground">Link shown once</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void onRevokeInvite(invite.id)}
                        aria-label={`Revoke invite for ${invite.email || 'anyone with the link'}`}
                      >
                        Revoke
                      </Button>
                    </ItemActions>
                  )}
                </Item>
              ))}
            </ItemGroup>
          )}
        </section>
      </div>
    </div>
  );
});

function roleBadgeVariant(role: string): 'default' | 'secondary' | 'outline' {
  if (role === 'owner') return 'default';
  if (role === 'admin') return 'secondary';
  return 'outline';
}

function InviteStatusBadge({ status }: { status: WorkspaceInvite['status'] }) {
  if (status === 'accepted') {
    return (
      <Badge variant="default" className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
        accepted
      </Badge>
    );
  }
  if (status === 'revoked') {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        revoked
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="bg-amber-500/15 text-amber-700 dark:text-amber-400">
      pending
    </Badge>
  );
}

function formatInviteDate(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleDateString();
}

export default UsersWindowContent;
