import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, GitBranch, Loader2, Lock, Mail, Sparkles } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldGroup } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Spinner } from '@/components/ui/spinner';

interface AuthPageProps {
  onSignIn: (email: string, password: string) => Promise<{ error: string | null }>;
  onSignUp: (email: string, password: string) => Promise<{ error: string | null }>;
  onOAuthSignIn: (provider: 'google' | 'github') => Promise<{ error: string | null }>;
}

/*
 * SECURITY NOTE — these are CLIENT-SIDE UX guards only and are trivially
 * bypassable (devtools, direct API calls, disabling JS). They reduce casual
 * misuse and guide users toward strong credentials, but the real enforcement
 * MUST live on the server:
 *   - Password complexity must be re-validated server-side on signup.
 *   - Failed-login rate limiting / lockout must be enforced server-side
 *     (per-account and per-IP); the back-off below only throttles this client.
 *   - Password reset and email verification are NOT implemented server-side,
 *     so they are intentionally absent here (we do not fake a reset flow).
 */

// --- Signup password policy -------------------------------------------------
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MIN_CLASSES = 3; // at least 3 of: lowercase, uppercase, digit, symbol

interface PasswordPolicyResult {
  valid: boolean;
  classesMet: number;
  longEnough: boolean;
  /** Human-readable label for the strength hint. */
  label: 'Too short' | 'Weak' | 'Fair' | 'Strong';
  /** Inline error to show when invalid (empty when valid or password blank). */
  message: string;
}

function evaluatePassword(password: string): PasswordPolicyResult {
  const classesMet =
    (/[a-z]/.test(password) ? 1 : 0) +
    (/[A-Z]/.test(password) ? 1 : 0) +
    (/[0-9]/.test(password) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(password) ? 1 : 0);
  const longEnough = password.length >= PASSWORD_MIN_LENGTH;
  const valid = longEnough && classesMet >= PASSWORD_MIN_CLASSES;

  let label: PasswordPolicyResult['label'];
  if (!longEnough) label = 'Too short';
  else if (classesMet >= 4) label = 'Strong';
  else if (classesMet >= PASSWORD_MIN_CLASSES) label = 'Fair';
  else label = 'Weak';

  let message = '';
  if (password.length > 0 && !valid) {
    if (!longEnough) {
      message = `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
    } else {
      message = `Password must include at least ${PASSWORD_MIN_CLASSES} of: lowercase, uppercase, number, symbol.`;
    }
  }

  return { valid, classesMet, longEnough, label, message };
}

// --- Sign-in lockout (client-side exponential back-off) ---------------------
const LOCKOUT_THRESHOLD = 5; // back-off kicks in after this many failures
const LOCKOUT_MAX_SECONDS = 300; // cap a single back-off at 5 minutes
const LOCKOUT_KEY_PREFIX = 'agensis.auth.lockout.';

interface LockoutRecord {
  attempts: number;
  lockUntil: number; // epoch ms; 0 = not locked
}

function lockoutKey(email: string) {
  return `${LOCKOUT_KEY_PREFIX}${email.trim().toLowerCase()}`;
}

function readLockout(email: string): LockoutRecord {
  if (!email.trim()) return { attempts: 0, lockUntil: 0 };
  try {
    const raw = localStorage.getItem(lockoutKey(email));
    if (!raw) return { attempts: 0, lockUntil: 0 };
    const parsed = JSON.parse(raw) as Partial<LockoutRecord>;
    return {
      attempts: typeof parsed.attempts === 'number' ? parsed.attempts : 0,
      lockUntil: typeof parsed.lockUntil === 'number' ? parsed.lockUntil : 0,
    };
  } catch {
    // localStorage can throw (private mode / disabled storage); fail open.
    return { attempts: 0, lockUntil: 0 };
  }
}

function writeLockout(email: string, record: LockoutRecord) {
  if (!email.trim()) return;
  try {
    localStorage.setItem(lockoutKey(email), JSON.stringify(record));
  } catch {
    // Ignore storage failures — lockout still holds in component state for this session.
  }
}

function clearLockout(email: string) {
  if (!email.trim()) return;
  try {
    localStorage.removeItem(lockoutKey(email));
  } catch {
    // Ignore.
  }
}

/** Next lock-until timestamp given the new failure count (monotonic, capped). */
function nextLockUntil(attempts: number): number {
  if (attempts < LOCKOUT_THRESHOLD) return 0;
  const seconds = Math.min(LOCKOUT_MAX_SECONDS, 2 ** (attempts - LOCKOUT_THRESHOLD));
  return Date.now() + seconds * 1000;
}

export function AuthPage({ onSignIn, onSignUp, onOAuthSignIn }: AuthPageProps) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [oauthProvider, setOauthProvider] = useState<'google' | 'github' | null>(null);
  // Lockout state, hydrated from localStorage keyed by the current email.
  const [lockUntil, setLockUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const passwordPolicy = evaluatePassword(password);
  const lockRemainingMs = Math.max(0, lockUntil - now);
  const locked = lockRemainingMs > 0;
  const lockRemainingSeconds = Math.ceil(lockRemainingMs / 1000);

  // Hydrate lockout for the entered email (sign-in only) whenever it changes.
  useEffect(() => {
    if (mode !== 'signin') {
      setLockUntil(0);
      return;
    }
    setLockUntil(readLockout(email).lockUntil);
  }, [email, mode]);

  // Tick once per second while locked so the countdown updates and re-enables.
  useEffect(() => {
    if (lockUntil <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [lockUntil]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const emailText = normalizeTextInput(email).trim();
    const passwordText = normalizeTextInput(password);
    const confirmPasswordText = normalizeTextInput(confirmPassword);

    if (!emailText || !passwordText.trim()) {
      setError('Please fill in all fields.');
      return;
    }

    // Sign-in: enforce the client-side back-off before doing anything else.
    if (mode === 'signin') {
      const record = readLockout(emailText);
      if (record.lockUntil > Date.now()) {
        setLockUntil(record.lockUntil);
        setNow(Date.now());
        setError(`Too many failed attempts. Try again in ${Math.ceil((record.lockUntil - Date.now()) / 1000)}s.`);
        return;
      }
    }

    if (mode === 'signup' && passwordText !== confirmPasswordText) {
      setError('Passwords do not match.');
      return;
    }

    if (mode === 'signup') {
      // Enforce the strong policy on NEW accounts only (existing users keep
      // their current passwords and are validated server-side at sign-in).
      const policy = evaluatePassword(passwordText);
      if (!policy.valid) {
        setError(
          policy.message ||
            `Password must be at least ${PASSWORD_MIN_LENGTH} characters and include ${PASSWORD_MIN_CLASSES} of: lowercase, uppercase, number, symbol.`,
        );
        return;
      }
    } else if (passwordText.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    setSubmitting(true);

    const result = mode === 'signin'
      ? await onSignIn(emailText, passwordText)
      : await onSignUp(emailText, passwordText);

    setSubmitting(false);

    if (result.error) {
      setError(result.error);
      // Count failed sign-in attempts and apply exponential back-off.
      if (mode === 'signin') {
        const attempts = readLockout(emailText).attempts + 1;
        const newLockUntil = nextLockUntil(attempts);
        writeLockout(emailText, { attempts, lockUntil: newLockUntil });
        setLockUntil(newLockUntil);
        setNow(Date.now());
        if (newLockUntil > Date.now()) {
          setError(
            `Too many failed attempts. Try again in ${Math.ceil((newLockUntil - Date.now()) / 1000)}s.`,
          );
        }
      }
    } else if (mode === 'signin') {
      // Successful sign-in clears the back-off record for this email.
      clearLockout(emailText);
      setLockUntil(0);
    }
  };

  const toggleMode = () => {
    setMode(m => m === 'signin' ? 'signup' : 'signin');
    setError('');
    setConfirmPassword('');
  };

  const handleOAuth = async (provider: 'google' | 'github') => {
    setError('');
    setOauthProvider(provider);
    const result = await onOAuthSignIn(provider);
    if (result.error) {
      setOauthProvider(null);
      setError(result.error);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-md flex-col gap-6">
        <div className="text-center">
          <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
            <Sparkles data-icon="inline-start" className="size-7" />
          </div>
          <h1 className="text-3xl font-bold tracking-normal text-foreground">
            {mode === 'signin' ? 'Welcome back' : 'Create your account'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {mode === 'signin'
              ? 'Sign in to your agensis workspace'
              : 'Get started with your intelligent workspace'}
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{mode === 'signin' ? 'Sign in' : 'Sign up'}</CardTitle>
          </CardHeader>
          <CardContent>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <button
                type="button"
                onClick={() => handleOAuth('google')}
                disabled={submitting || oauthProvider !== null}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  minHeight: '42px',
                  padding: '10px 12px',
                  background: 'var(--canvas-elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: submitting || oauthProvider !== null ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {oauthProvider === 'google' ? (
                  <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
                ) : (
                  <span style={{ fontWeight: 700, fontSize: '16px', lineHeight: 1 }}>G</span>
                )}
                Google
              </button>
              <button
                type="button"
                onClick={() => handleOAuth('github')}
                disabled={submitting || oauthProvider !== null}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  minHeight: '42px',
                  padding: '10px 12px',
                  background: 'var(--canvas-elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: submitting || oauthProvider !== null ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {oauthProvider === 'github' ? (
                  <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
                ) : (
                  <GitBranch size={16} />
                )}
                GitHub
              </button>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto 1fr',
                alignItems: 'center',
                gap: '12px',
                color: 'var(--text-muted)',
                fontSize: '12px',
              }}
            >
              <span style={{ height: '1px', background: 'var(--border)' }} />
              <span>or</span>
              <span style={{ height: '1px', background: 'var(--border)' }} />
            </div>

            <form onSubmit={handleSubmit}>
              <FieldGroup>
                <Field>
                  <InputGroup>
                    <InputGroupAddon align="inline-start">
                      <Mail data-icon="inline-start" className="size-4" />
                    </InputGroupAddon>
                    <InputGroupInput
                      type="email"
                      placeholder="Email address"
                      value={email}
                      onChange={e => setEmail(normalizeTextInput(e.target.value))}
                      autoFocus
                    />
                  </InputGroup>
                </Field>

                <Field>
                  <InputGroup>
                    <InputGroupAddon align="inline-start">
                      <Lock data-icon="inline-start" className="size-4" />
                    </InputGroupAddon>
                    <InputGroupInput
                      type="password"
                      placeholder="Password"
                      value={password}
                      onChange={e => setPassword(normalizeTextInput(e.target.value))}
                    />
                  </InputGroup>
                  {mode === 'signup' && password.length > 0 && (
                    <p
                      className="mt-1.5 text-xs text-muted-foreground"
                      aria-live="polite"
                    >
                      Password strength:{' '}
                      <span
                        className={
                          passwordPolicy.valid
                            ? 'font-medium text-green-600 dark:text-green-500'
                            : 'font-medium text-amber-600 dark:text-amber-500'
                        }
                      >
                        {passwordPolicy.label}
                      </span>
                      {!passwordPolicy.valid && (
                        <>
                          {' '}
                          — need {PASSWORD_MIN_LENGTH}+ chars and {PASSWORD_MIN_CLASSES} of:
                          lowercase, uppercase, number, symbol.
                        </>
                      )}
                    </p>
                  )}
                </Field>

                {mode === 'signup' && (
                  <Field>
                    <InputGroup>
                      <InputGroupAddon align="inline-start">
                        <Lock data-icon="inline-start" className="size-4" />
                      </InputGroupAddon>
                      <InputGroupInput
                        type="password"
                        placeholder="Confirm password"
                        value={confirmPassword}
                        onChange={e => setConfirmPassword(normalizeTextInput(e.target.value))}
                      />
                    </InputGroup>
                  </Field>
                )}

                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                {/* Lockout disables only this email/password submit — OAuth stays available. */}
                <Button type="submit" disabled={submitting || (mode === 'signin' && locked)} className="w-full">
                  {submitting ? (
                    <Spinner className="size-4" />
                  ) : mode === 'signin' && locked ? (
                    <>Locked — retry in {lockRemainingSeconds}s</>
                  ) : (
                    <>
                      {mode === 'signin' ? 'Sign in' : 'Create account'}
                      <ArrowRight data-icon="inline-end" className="size-4" />
                    </>
                  )}
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>

        <div className="text-center text-sm text-muted-foreground">
          {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
          <Button type="button" variant="link" className="h-auto px-0" onClick={toggleMode}>
            {mode === 'signin' ? 'Sign up' : 'Sign in'}
          </Button>
        </div>
      </div>
    </main>
  );
}

function normalizeTextInput(value: unknown) {
  return typeof value === 'string' ? value : '';
}
