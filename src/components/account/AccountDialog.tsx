import { useEffect, useState } from 'react';
import { CreditCard, Sparkles } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { useUserProfile } from '../../hooks/useUserProfile';
import { evaluatePassword, PASSWORD_MIN_CLASSES, PASSWORD_MIN_LENGTH } from '../../lib/passwordPolicy';

const ACCOUNT_ACCENT_CHOICES = ['#00a95c', '#38bdf8', '#a78bfa', '#f59e0b', '#f472b6', '#ef4444', '#64748b'];

interface AccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId?: string | null;
  userEmail: string;
  defaultTab?: 'profile' | 'billing';
}

export function AccountDialog({ open, onOpenChange, userId, userEmail, defaultTab = 'profile' }: AccountDialogProps) {
  const { profile, updateProfile, changePassword } = useUserProfile(open ? userId : null);
  const [tab, setTab] = useState(defaultTab);
  const [displayName, setDisplayName] = useState('');
  const [accentColor, setAccentColor] = useState(ACCOUNT_ACCENT_CHOICES[0]);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileMessage, setProfileMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (open) setTab(defaultTab);
  }, [open, defaultTab]);

  useEffect(() => {
    setDisplayName(profile?.display_name || '');
    setAccentColor(profile?.accent_color || ACCOUNT_ACCENT_CHOICES[0]);
  }, [profile]);

  const initial = (displayName || userEmail || 'U').trim().charAt(0).toUpperCase();
  const newPasswordPolicy = evaluatePassword(newPassword);

  const saveProfile = async () => {
    setSavingProfile(true);
    setProfileMessage(null);
    const { error } = await updateProfile({ display_name: displayName.trim(), accent_color: accentColor });
    setSavingProfile(false);
    setProfileMessage(error ? { type: 'error', text: error } : { type: 'ok', text: 'Profile updated.' });
  };

  const submitPasswordChange = async () => {
    const policy = evaluatePassword(newPassword);
    if (!policy.valid) {
      setPasswordMessage({
        type: 'error',
        text:
          policy.message ||
          `Password must be at least ${PASSWORD_MIN_LENGTH} characters and include ${PASSWORD_MIN_CLASSES} of: lowercase, uppercase, number, symbol.`,
      });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordMessage({ type: 'error', text: 'New password and confirmation do not match.' });
      return;
    }
    setChangingPassword(true);
    setPasswordMessage(null);
    const { error } = await changePassword(currentPassword, newPassword);
    setChangingPassword(false);
    if (error) {
      setPasswordMessage({ type: 'error', text: error });
      return;
    }
    setPasswordMessage({ type: 'ok', text: 'Password changed.' });
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Account</DialogTitle>
          <DialogDescription>Manage your profile and billing.</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={value => setTab(value as 'profile' | 'billing')}>
          <TabsList className="w-full">
            <TabsTrigger value="profile" className="flex-1">Profile</TabsTrigger>
            <TabsTrigger value="billing" className="flex-1">Billing</TabsTrigger>
          </TabsList>

          <TabsContent value="profile" className="flex flex-col gap-5 pt-1">
            <div className="flex items-center gap-3">
              <Avatar size="lg">
                <AvatarFallback style={{ backgroundColor: accentColor, color: '#fff' }}>{initial}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{displayName || 'No display name set'}</div>
                <div className="truncate text-xs text-muted-foreground">{userEmail}</div>
              </div>
            </div>

            <Field>
              <FieldLabel htmlFor="account-display-name">Display name</FieldLabel>
              <Input
                id="account-display-name"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="How should we show your name?"
                maxLength={80}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="account-accent-color">Accent color</FieldLabel>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {ACCOUNT_ACCENT_CHOICES.map(choice => (
                  <button
                    key={choice}
                    type="button"
                    className={cn(
                      'size-8 rounded-lg border transition',
                      accentColor === choice && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
                    )}
                    style={{ backgroundColor: choice }}
                    onClick={() => setAccentColor(choice)}
                    aria-label={`Use accent ${choice}`}
                    title={choice}
                  />
                ))}
              </div>
            </Field>

            {profileMessage && (
              <p className={cn('text-xs', profileMessage.type === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                {profileMessage.text}
              </p>
            )}
            <Button type="button" onClick={saveProfile} disabled={savingProfile} className="self-start">
              {savingProfile ? 'Saving…' : 'Save profile'}
            </Button>

            <div className="flex flex-col gap-3 border-t border-border pt-4">
              <FieldLabel>Change password</FieldLabel>
              <Input
                type="password"
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                placeholder="Current password"
                autoComplete="current-password"
              />
              <Input
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="New password"
                autoComplete="new-password"
              />
              {newPassword.length > 0 && (
                <p className="text-xs text-muted-foreground" aria-live="polite">
                  Password strength:{' '}
                  <span
                    className={
                      newPasswordPolicy.valid
                        ? 'font-medium text-green-600 dark:text-green-500'
                        : 'font-medium text-amber-600 dark:text-amber-500'
                    }
                  >
                    {newPasswordPolicy.label}
                  </span>
                  {!newPasswordPolicy.valid && (
                    <>
                      {' '}
                      — need {PASSWORD_MIN_LENGTH}+ chars and {PASSWORD_MIN_CLASSES} of:
                      lowercase, uppercase, number, symbol.
                    </>
                  )}
                </p>
              )}
              <Input
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="Confirm new password"
                autoComplete="new-password"
              />
              {passwordMessage && (
                <p className={cn('text-xs', passwordMessage.type === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                  {passwordMessage.text}
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={submitPasswordChange}
                disabled={changingPassword || !currentPassword || !newPassword}
                className="self-start"
              >
                {changingPassword ? 'Changing…' : 'Change password'}
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="billing" className="pt-1">
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-muted/30 px-6 py-10 text-center">
              <span className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
                <CreditCard className="size-5" />
              </span>
              <div className="space-y-1">
                <p className="text-sm font-medium">Billing isn't set up yet</p>
                <FieldDescription>
                  Subscription management (Stripe) is coming soon. You're on the free plan in the meantime — nothing to do here.
                </FieldDescription>
              </div>
              <Button type="button" variant="outline" size="sm" disabled className="gap-1.5">
                <Sparkles className="size-3.5" />
                Upgrade — coming soon
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
