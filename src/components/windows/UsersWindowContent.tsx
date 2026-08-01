import { memo, useEffect, useState } from 'react';
import {
  Bot,
  Check,
  Crown,
  Link2,
  LockKeyhole,
  Plus,
  ServerCog,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react';
import {
  joinLinkAudienceLabel,
  joinLinkLifecycleState,
  joinLinkRedeemedAsLabel,
  WORKSPACE_CONTROLLER_SCOPES,
  type CreatedWorkspaceJoinLink,
  type CreateWorkspaceJoinLinkInput,
  type JoinLinkAudience,
  type JoinLinkLifecycleState,
  type WorkspaceConnectionRole,
  type WorkspaceJoinLink,
  type WorkspaceMember,
  type WorkspaceController,
  type WorkspaceControllerScope,
} from '@/features/workspace-connections';
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
  members: WorkspaceMember[];
  joinLinks: WorkspaceJoinLink[];
  /**
   * Older callers (and the lightweight onboarding/smoke surface) do not have
   * controller data yet. Treat that as an empty collection rather than letting
   * the expiry effect crash the whole Members window before it can render the
   * members it already has.
   */
  controllers?: WorkspaceController[];
  canManage: boolean;
  canIssueWorkspaceControl?: boolean;
  loading?: boolean;
  controllersLoading?: boolean;
  error?: string;
  onCreateJoinLink: (input: CreateWorkspaceJoinLinkInput) => Promise<CreatedWorkspaceJoinLink>;
  onRevokeJoinLink: (linkId: string) => Promise<void>;
  onRevokeController?: (controllerId: string) => Promise<void>;
  onRemoveMember: (memberId: string) => Promise<void>;
  onChangeMemberRole: (memberId: string, role: WorkspaceConnectionRole) => Promise<void>;
}

export const UsersWindowContent = memo(function UsersWindowContent({
  workspaceName,
  currentUserId,
  currentUserEmail,
  members,
  joinLinks,
  controllers = [],
  canManage,
  canIssueWorkspaceControl = false,
  loading = false,
  controllersLoading = false,
  error = '',
  onCreateJoinLink,
  onRevokeJoinLink,
  onRevokeController,
  onRemoveMember,
  onChangeMemberRole,
}: UsersWindowContentProps) {
  const [newRole, setNewRole] = useState<WorkspaceConnectionRole>('editor');
  const [newAudience, setNewAudience] = useState<JoinLinkAudience>('both');
  const [newLabel, setNewLabel] = useState('');
  const [controllerName, setControllerName] = useState('');
  const [controllerScopes, setControllerScopes] = useState<WorkspaceControllerScope[]>([
    'agents:register',
    'agents:manage_own',
    'resources:create',
    'resources:manage_own',
  ]);
  const [creating, setCreating] = useState(false);
  const [copiedCreate, setCopiedCreate] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokingControllerId, setRevokingControllerId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [expiryVersion, setExpiryVersion] = useState(0);

  useEffect(() => {
    if (!canIssueWorkspaceControl && newAudience === 'controller') setNewAudience('both');
  }, [canIssueWorkspaceControl, newAudience]);

  // The status is derived from expires_at, so make the next live row re-render
  // when it crosses that boundary. No polling and no permanently stale
  // "pending" badge if the window stays open for the whole 15-minute lifetime.
  useEffect(() => {
    const now = Date.now();
    const nextExpiry = [
      ...joinLinks
        .filter(link => link.status === 'pending')
        .map(link => link.expires_at ? new Date(link.expires_at).getTime() : Number.NaN),
      ...controllers
        .filter(controller => controller.status === 'active')
        .map(controller => controller.expires_at
          ? new Date(controller.expires_at).getTime()
          : Number.NaN),
    ]
      .filter(value => Number.isFinite(value) && value > now)
      .reduce((earliest, value) => Math.min(earliest, value), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(nextExpiry)) return;
    const timeout = window.setTimeout(
      () => setExpiryVersion(version => version + 1),
      Math.min(Math.max(nextExpiry - now + 25, 25), 2_147_483_647),
    );
    return () => window.clearTimeout(timeout);
  }, [controllers, expiryVersion, joinLinks]);

  const handleCreateJoinLink = async () => {
    if (creating || !canManage) return;
    setCreating(true);
    setCopiedCreate(false);
    setActionError('');
    try {
      const created = await onCreateJoinLink({
        role: newRole,
        audience: newAudience,
        label: newLabel.trim() || undefined,
        grantKind: newAudience === 'controller' ? 'workspace_control' : 'individual',
        controllerName: newAudience === 'controller' ? controllerName.trim() : undefined,
        scopes: newAudience === 'controller' ? controllerScopes : undefined,
      });
      await copyJoinUrl(created.url);
      setNewLabel('');
      if (newAudience === 'controller') setControllerName('');
      setCopiedCreate(true);
    } catch (createError) {
      setActionError(
        createError instanceof Error
          ? createError.message
          : 'The join link could not be created and copied',
      );
    } finally {
      setCreating(false);
    }
  };

  const handleRevokeController = async (controllerId: string) => {
    if (revokingControllerId || !canIssueWorkspaceControl) return;
    setRevokingControllerId(controllerId);
    setActionError('');
    try {
      await onRevokeController?.(controllerId);
    } catch (revokeError) {
      setActionError(revokeError instanceof Error ? revokeError.message : 'Failed to revoke workspace controller');
    } finally {
      setRevokingControllerId(null);
    }
  };

  const handleRevoke = async (linkId: string) => {
    if (revokingId || !canManage) return;
    setRevokingId(linkId);
    setActionError('');
    try {
      await onRevokeJoinLink(linkId);
    } catch (revokeError) {
      setActionError(revokeError instanceof Error ? revokeError.message : 'Failed to revoke join link');
    } finally {
      setRevokingId(null);
    }
  };

  const handleRemove = async (memberId: string) => {
    if (!canManage) return;
    if (confirmRemoveId !== memberId) {
      setConfirmRemoveId(memberId);
      return;
    }
    setActionError('');
    try {
      await onRemoveMember(memberId);
      setConfirmRemoveId(null);
    } catch (removeError) {
      setActionError(removeError instanceof Error ? removeError.message : 'Failed to remove workspace member');
    }
  };

  const handleRoleChange = async (memberId: string, role: WorkspaceConnectionRole) => {
    setActionError('');
    try {
      await onChangeMemberRole(memberId, role);
    } catch (roleError) {
      setActionError(roleError instanceof Error ? roleError.message : 'Failed to update workspace member role');
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent text-foreground">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card/65 px-3 backdrop-blur-md">
        <Users className="size-4 text-primary" />
        <span className="text-sm font-semibold">People & connections</span>
        <Badge variant="secondary">{members.length}</Badge>
        {loading && <Spinner className="size-3.5 text-muted-foreground" />}
        <div className="flex-1" />
        <span className="max-w-[40%] truncate text-xs text-muted-foreground" title={workspaceName}>
          {workspaceName}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        {(error || actionError) && (
          <div role="alert" className="rounded-md border border-destructive/35 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {actionError || error}
          </div>
        )}

        {loading && members.length === 0 && (
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

          {members.length === 0 && !loading ? (
            <Empty className="border-0 py-6">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Users />
                </EmptyMedia>
                <EmptyTitle>No members yet</EmptyTitle>
                <EmptyDescription>
                  {canManage
                    ? `Create a join link below to bring someone into ${workspaceName}.`
                    : `There are no visible members in ${workspaceName}.`}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup className="gap-1">
              {members.map((member) => {
                const memberId = member.id;
                const isYou = member.user_id === currentUserId;
                const displayEmail = member.email || (isYou ? currentUserEmail ?? '' : '');
                const canEditMember = canManage
                  && memberId !== null
                  && member.role !== 'owner'
                  && !isYou;
                const memberLabel = displayEmail || (member.role === 'owner' ? 'Workspace owner' : 'Unknown user');
                return (
                  <Item key={memberId ?? member.user_id} variant="outline">
                    <ItemMedia className="size-9 items-center justify-center rounded-full bg-muted text-sm font-semibold uppercase text-muted-foreground">
                      {displayEmail ? displayEmail.charAt(0).toUpperCase() : <UserRound className="size-4" />}
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="truncate font-semibold">
                        {memberLabel}
                        {isYou ? ' (you)' : ''}
                      </ItemTitle>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant={roleBadgeVariant(member.role)}>
                          {member.role === 'owner' && <Crown data-icon="inline-start" />}
                          {member.role}
                        </Badge>
                      </div>
                    </ItemContent>
                    {canEditMember && memberId !== null && (
                      <ItemActions>
                        <NativeSelect
                          size="sm"
                          aria-label={`Change role for ${memberLabel}`}
                          value={member.role}
                          onChange={(event) => {
                            const value = event.target.value;
                            const role: WorkspaceConnectionRole =
                              value === 'admin' || value === 'commenter' || value === 'viewer'
                                ? value
                                : 'editor';
                            void handleRoleChange(memberId, role);
                          }}
                        >
                          <NativeSelectOption value="admin">Admin</NativeSelectOption>
                          <NativeSelectOption value="editor">Editor</NativeSelectOption>
                          <NativeSelectOption value="commenter">Commenter</NativeSelectOption>
                          <NativeSelectOption value="viewer">Viewer</NativeSelectOption>
                        </NativeSelect>
                        <Button
                          type="button"
                          variant={confirmRemoveId === memberId ? 'destructive' : 'ghost'}
                          size="icon-xs"
                          aria-label={confirmRemoveId === memberId
                            ? `Confirm remove ${memberLabel}`
                            : `Remove ${memberLabel}`}
                          title={confirmRemoveId === memberId ? 'Click again to remove' : 'Remove member'}
                          onClick={() => void handleRemove(memberId)}
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
          <div className="flex flex-wrap items-center gap-2">
            <Link2 className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">Join links</h2>
            {canManage && <Badge variant="secondary">{joinLinks.length}</Badge>}
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            One URL works for people and agents. Individual links last 15 minutes; owner-only controller
            enrollments last five. Every link can be used once.
          </p>

          {!canManage && loading && members.length === 0 ? null : !canManage ? (
            <div className="flex items-start gap-2 rounded-lg border bg-card/55 p-3 text-xs text-muted-foreground">
              <LockKeyhole className="mt-0.5 size-4 shrink-0" />
              <span>
                Join links are private to workspace owners and admins. You can view members, but you cannot create,
                list or revoke connection links.
              </span>
            </div>
          ) : (
            <>
              <div className="rounded-lg border bg-card/55 p-3 backdrop-blur-md">
                <div className="flex flex-wrap items-end gap-2">
                  <Field className="w-auto">
                    <FieldLabel htmlFor="join-audience">For</FieldLabel>
                    <NativeSelect
                      id="join-audience"
                      size="sm"
                      value={newAudience}
                      onChange={(event) => {
                        const value = event.target.value;
                        setNewAudience(
                          value === 'human' || value === 'agent' || (value === 'controller' && canIssueWorkspaceControl)
                            ? value
                            : 'both',
                        );
                        setCopiedCreate(false);
                      }}
                    >
                      <NativeSelectOption value="both">Person or agent</NativeSelectOption>
                      <NativeSelectOption value="human">Person only</NativeSelectOption>
                      <NativeSelectOption value="agent">Agent only</NativeSelectOption>
                      {canIssueWorkspaceControl && (
                        <NativeSelectOption value="controller">Workspace controller</NativeSelectOption>
                      )}
                    </NativeSelect>
                  </Field>
                  {newAudience !== 'controller' && (
                    <Field className="w-auto">
                      <FieldLabel htmlFor="join-role">Role</FieldLabel>
                      <NativeSelect
                        id="join-role"
                        size="sm"
                        value={newRole}
                        onChange={(event) => {
                          const value = event.target.value;
                          setNewRole(
                            value === 'admin' || value === 'commenter' || value === 'viewer'
                              ? value
                              : 'editor',
                          );
                          setCopiedCreate(false);
                        }}
                      >
                        <NativeSelectOption value="admin">Admin</NativeSelectOption>
                        <NativeSelectOption value="editor">Editor</NativeSelectOption>
                        <NativeSelectOption value="commenter">Commenter</NativeSelectOption>
                        <NativeSelectOption value="viewer">Viewer</NativeSelectOption>
                      </NativeSelect>
                    </Field>
                  )}
                  {newAudience === 'controller' && (
                    <Field className="min-w-52 flex-1">
                      <FieldLabel htmlFor="controller-name">Controller name</FieldLabel>
                      <Input
                        id="controller-name"
                        placeholder="Required, e.g. Local build farm"
                        maxLength={120}
                        value={controllerName}
                        onChange={(event) => {
                          setControllerName(event.target.value);
                          setCopiedCreate(false);
                        }}
                      />
                    </Field>
                  )}
                  <Field className="min-w-48 flex-1">
                    <FieldLabel htmlFor="join-label">Label</FieldLabel>
                    <Input
                      id="join-label"
                      placeholder="Optional, e.g. build agent"
                      maxLength={120}
                      value={newLabel}
                      onChange={(event) => {
                        setNewLabel(event.target.value);
                        setCopiedCreate(false);
                      }}
                    />
                  </Field>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void handleCreateJoinLink()}
                    disabled={
                      creating
                      || (newAudience === 'controller' && (!controllerName.trim() || controllerScopes.length === 0))
                    }
                  >
                    {creating ? (
                      <Spinner data-icon="inline-start" />
                    ) : copiedCreate ? (
                      <Check data-icon="inline-start" />
                    ) : (
                      <Plus data-icon="inline-start" />
                    )}
                    {copiedCreate ? 'Link copied' : 'Create & copy link'}
                  </Button>
                </div>
                {newAudience === 'controller' && (
                  <div className="mt-3 space-y-3 border-t pt-3">
                    <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs leading-relaxed">
                      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
                      <span>
                        Owner-only control enrollment. The link lasts five minutes and returns one named,
                        expiring credential. It cannot read private chats, grant roles, read raw vault values,
                        or post arbitrary messages.
                      </span>
                    </div>
                    <fieldset>
                      <legend className="mb-1.5 text-xs font-medium">Controller scopes</legend>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {WORKSPACE_CONTROLLER_SCOPES.map(scope => (
                          <label key={scope} className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={controllerScopes.includes(scope)}
                              onChange={(event) => {
                                setControllerScopes(previous => event.target.checked
                                  ? [...previous, scope]
                                  : previous.filter(value => value !== scope));
                                setCopiedCreate(false);
                              }}
                            />
                            <code>{scope}</code>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  </div>
                )}
              </div>

              {joinLinks.length === 0 && !loading ? (
                <Empty className="border-0 py-5">
                  <EmptyHeader>
                    <EmptyMedia variant="icon" className="size-9">
                      <Link2 className="size-4" />
                    </EmptyMedia>
                    <EmptyTitle className="text-sm">No join links yet</EmptyTitle>
                    <EmptyDescription>Links you create will appear here without their secret URL.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <ItemGroup className="gap-1">
                  {joinLinks.map((link) => {
                    const state = joinLinkLifecycleState(link);
                    return (
                      <Item key={link.id} variant="outline">
                        <ItemMedia className="size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
                          <JoinAudienceIcon audience={link.audience} />
                        </ItemMedia>
                        <ItemContent className="min-w-0">
                          <ItemTitle className="truncate">
                            {link.label || link.controller_name || defaultJoinLinkTitle(link.audience)}
                          </ItemTitle>
                          <div className="flex flex-wrap items-center gap-1">
                            {link.grant_kind === 'individual' && (
                              <Badge variant={roleBadgeVariant(link.role)}>{link.role}</Badge>
                            )}
                            <Badge variant="outline">{joinLinkAudienceLabel(link.audience)}</Badge>
                            {link.grant_kind === 'workspace_control' && link.controller_scopes.map(scope => (
                              <Badge key={scope} variant="outline">{scope}</Badge>
                            ))}
                            <JoinLinkStateBadge state={state} />
                            {state === 'redeemed' && (
                              <Badge variant="outline">{joinLinkRedeemedAsLabel(link)}</Badge>
                            )}
                          </div>
                          <ItemDescription>
                            {joinLinkDescription(link, state)}
                          </ItemDescription>
                        </ItemContent>
                        {state === 'pending' && (
                          <ItemActions>
                            <span className="text-xs text-muted-foreground">URL shown once</span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={revokingId === link.id}
                              onClick={() => void handleRevoke(link.id)}
                              aria-label={`Revoke join link ${link.label || link.id}`}
                            >
                              {revokingId === link.id && <Spinner data-icon="inline-start" />}
                              Revoke
                            </Button>
                          </ItemActions>
                        )}
                      </Item>
                    );
                  })}
                </ItemGroup>
              )}
            </>
          )}
        </section>

        {canIssueWorkspaceControl && (
          <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <ServerCog className="size-4 text-primary" />
              <h2 className="text-sm font-semibold">Workspace controllers</h2>
              <Badge variant="secondary">{controllers.length}</Badge>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Named control credentials can register their own agents and stewarded resources. Revocation is
              independent; child records stay attributed for audit.
            </p>
            {controllersLoading ? (
              <div className="flex items-center gap-2 rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">
                <Spinner className="size-3.5" />
                Loading enrolled controllers…
              </div>
            ) : controllers.length === 0 ? (
              <Empty className="border-0 py-5">
                <EmptyHeader>
                  <EmptyMedia variant="icon" className="size-9">
                    <ServerCog className="size-4" />
                  </EmptyMedia>
                  <EmptyTitle className="text-sm">No enrolled controllers</EmptyTitle>
                  <EmptyDescription>
                    Choose Workspace controller above to create a five-minute enrollment link.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ItemGroup className="gap-1">
                {controllers.map(controller => {
                  const expired = controller.expires_at
                    ? new Date(controller.expires_at).getTime() <= Date.now()
                    : false;
                  const active = controller.status === 'active' && !expired;
                  return (
                    <Item key={controller.id} variant="outline">
                      <ItemMedia className="size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <ServerCog className="size-4" />
                      </ItemMedia>
                      <ItemContent className="min-w-0">
                        <ItemTitle className="truncate">{controller.name}</ItemTitle>
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge variant={active ? 'default' : 'outline'}>
                            {expired ? 'expired' : controller.status}
                          </Badge>
                          {controller.scopes.map(scope => (
                            <Badge key={scope} variant="outline">{scope}</Badge>
                          ))}
                        </div>
                        <ItemDescription>
                          {controller.last_used_at
                            ? `Last used ${formatJoinLinkDate(controller.last_used_at)}.`
                            : 'Not used since enrollment.'}
                          {' '}
                          {controller.expires_at
                            ? `Expires ${formatJoinLinkDate(controller.expires_at)}.`
                            : ''}
                        </ItemDescription>
                      </ItemContent>
                      {controller.status === 'active' && (
                        <ItemActions>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={revokingControllerId === controller.id}
                            onClick={() => void handleRevokeController(controller.id)}
                            aria-label={`Revoke workspace controller ${controller.name}`}
                          >
                            {revokingControllerId === controller.id && <Spinner data-icon="inline-start" />}
                            Revoke
                          </Button>
                        </ItemActions>
                      )}
                    </Item>
                  );
                })}
              </ItemGroup>
            )}
          </section>
        )}
      </div>
    </div>
  );
});

async function copyJoinUrl(url: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
    return;
  }

  const input = document.createElement('textarea');
  input.value = url;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand?.('copy') ?? false;
  input.remove();
  if (!copied) {
    throw new Error(
      'The link was created, but clipboard access was blocked. Revoke it and create another after allowing clipboard access.',
    );
  }
}

function JoinAudienceIcon({ audience }: { audience: JoinLinkAudience }) {
  if (audience === 'controller') return <ServerCog className="size-4" />;
  if (audience === 'agent') return <Bot className="size-4" />;
  if (audience === 'human') return <UserRound className="size-4" />;
  return <Link2 className="size-4" />;
}

function defaultJoinLinkTitle(audience: JoinLinkAudience): string {
  if (audience === 'controller') return 'Workspace controller enrollment';
  if (audience === 'human') return 'Person invitation';
  if (audience === 'agent') return 'Agent connection';
  return 'Person or agent connection';
}

function roleBadgeVariant(role: string): 'default' | 'secondary' | 'outline' {
  if (role === 'owner') return 'default';
  if (role === 'admin') return 'secondary';
  return 'outline';
}

function JoinLinkStateBadge({ state }: { state: JoinLinkLifecycleState }) {
  if (state === 'redeemed') {
    return (
      <Badge variant="default" className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
        redeemed
      </Badge>
    );
  }
  if (state === 'revoked' || state === 'expired') {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {state}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="bg-amber-500/15 text-amber-700 dark:text-amber-400">
      pending
    </Badge>
  );
}

function joinLinkDescription(link: WorkspaceJoinLink, state: JoinLinkLifecycleState): string {
  if (state === 'redeemed') {
    const when = formatJoinLinkDate(link.redeemed_at);
    return `${joinLinkRedeemedAsLabel(link)}${when ? ` on ${when}` : ''}.`;
  }
  if (state === 'expired') return `Expired${formatJoinLinkDate(link.expires_at) ? ` on ${formatJoinLinkDate(link.expires_at)}` : ''}.`;
  if (state === 'revoked') return 'Revoked. This URL can no longer be used.';
  const expiry = formatJoinLinkDate(link.expires_at);
  const creator = link.created_by_email ? ` Created by ${link.created_by_email}.` : '';
  const fallback = link.grant_kind === 'workspace_control'
    ? 'Expires five minutes after creation.'
    : 'Expires 15 minutes after creation.';
  const credential = link.grant_kind === 'workspace_control' && link.controller_expires_at
    ? ` Enrolled credential expires ${formatJoinLinkDate(link.controller_expires_at)}.`
    : '';
  return `${expiry ? `Expires ${expiry}.` : fallback}${credential}${creator}`;
}

function formatJoinLinkDate(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export default UsersWindowContent;
