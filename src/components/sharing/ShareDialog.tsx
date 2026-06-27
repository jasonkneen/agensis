import { useState } from 'react';
import { Crown, Trash2 } from 'lucide-react';
import type { WorkspaceMember } from '../../hooks/useSharing';
import {
  Avatar,
  AvatarFallback,
} from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';

interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  workspaceName: string;
  currentUserEmail: string;
  members: WorkspaceMember[];
  autoShare: boolean;
  onToggleAutoShare: () => void;
  onInvite: (email: string) => Promise<{ error: string | null }>;
  onRemoveMember: (memberId: string) => void;
  onUpdateRole: (memberId: string, role: 'editor' | 'viewer') => void;
}

export function ShareDialog({
  open,
  onClose,
  title,
  workspaceName,
  currentUserEmail,
  members,
  autoShare,
  onToggleAutoShare,
  onInvite,
  onRemoveMember,
  onUpdateRole,
}: ShareDialogProps) {
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [inviting, setInviting] = useState(false);

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviteError('');
    setInviting(true);
    const result = await onInvite(inviteEmail.trim());
    setInviting(false);
    if (result.error) {
      setInviteError(result.error);
    } else {
      setInviteEmail('');
    }
  };

  return (
    <Dialog open={open} onOpenChange={nextOpen => { if (!nextOpen) onClose(); }}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader className="pr-8">
          <DialogTitle>Share {title}</DialogTitle>
          <DialogDescription>
            Manage access for this item in {workspaceName}.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Item variant="outline">
            <ItemContent>
              <ItemTitle>Auto-sharing</ItemTitle>
              <ItemDescription>
                Share with everyone in workspace {workspaceName}, including anyone who joins later.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch checked={autoShare} onCheckedChange={() => onToggleAutoShare()} aria-label="Toggle auto-sharing" />
            </ItemActions>
          </Item>

          <Field>
            <FieldLabel htmlFor="invite-email">Invite anyone</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="invite-email"
                type="email"
                placeholder="Enter email address..."
                value={inviteEmail}
                onChange={e => {
                  setInviteEmail(e.target.value);
                  setInviteError('');
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleInvite();
                  }
                }}
                aria-invalid={Boolean(inviteError)}
              />
              <Button type="button" onClick={handleInvite} disabled={inviting || !inviteEmail.trim()}>
                {inviting ? <Spinner data-icon="inline-start" /> : null}
                Add
              </Button>
            </div>
            {inviteError ? (
              <FieldDescription className="text-destructive">{inviteError}</FieldDescription>
            ) : members.length > 0 ? (
              <FieldDescription>Everyone in the workspace already has access.</FieldDescription>
            ) : null}
          </Field>

          <section className="flex flex-col gap-2">
            <div className="text-sm font-medium">People with access</div>
            <ItemGroup className="gap-2">
              <PersonRow
                email={currentUserEmail}
                role="owner"
                isCurrentUser
                onRemove={() => {}}
                onChangeRole={() => {}}
              />

              {members.map(member => (
                <PersonRow
                  key={member.id}
                  email={member.email || member.user_id.slice(0, 8)}
                  role={member.role}
                  isCurrentUser={false}
                  onRemove={() => onRemoveMember(member.id)}
                  onChangeRole={role => onUpdateRole(member.id, role)}
                />
              ))}
            </ItemGroup>
          </section>
        </FieldGroup>
      </DialogContent>
    </Dialog>
  );
}

function PersonRow({
  email,
  role,
  isCurrentUser,
  onRemove,
  onChangeRole,
}: {
  email: string;
  role: string;
  isCurrentUser: boolean;
  onRemove: () => void;
  onChangeRole: (role: 'editor' | 'viewer') => void;
}) {
  const initial = (email[0] || 'U').toUpperCase();
  const displayRole = role === 'owner' ? 'Owner' : role === 'editor' ? 'Editor' : 'Viewer';

  return (
    <Item variant="default" size="sm">
      <Avatar>
        <AvatarFallback>{initial}</AvatarFallback>
      </Avatar>
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full truncate">
          {email}
          {isCurrentUser && <span className="font-normal text-muted-foreground">(you)</span>}
        </ItemTitle>
      </ItemContent>
      <ItemActions>
        {isCurrentUser ? (
          <Badge variant="secondary">
            <Crown />
            {displayRole}
          </Badge>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                {displayRole}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={() => onChangeRole('editor')}>
                  Editor
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onChangeRole('viewer')}>
                  Viewer
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                  <Trash2 />
                  Remove
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </ItemActions>
    </Item>
  );
}
