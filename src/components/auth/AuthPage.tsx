import { useState, type FormEvent } from 'react';
import { ArrowRight, Lock, Mail, Sparkles } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldGroup } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Spinner } from '@/components/ui/spinner';

interface AuthPageProps {
  onSignIn: (email: string, password: string) => Promise<{ error: string | null }>;
  onSignUp: (email: string, password: string) => Promise<{ error: string | null }>;
}

export function AuthPage({ onSignIn, onSignUp }: AuthPageProps) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (!email.trim() || !password.trim()) {
      setError('Please fill in all fields.');
      return;
    }

    if (mode === 'signup' && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    setSubmitting(true);

    const result = mode === 'signin'
      ? await onSignIn(email.trim(), password)
      : await onSignUp(email.trim(), password);

    setSubmitting(false);

    if (result.error) {
      setError(result.error);
    }
  };

  const toggleMode = () => {
    setMode(m => m === 'signin' ? 'signup' : 'signin');
    setError('');
    setConfirmPassword('');
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
              ? 'Sign in to your Hatch workspace'
              : 'Get started with your intelligent workspace'}
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{mode === 'signin' ? 'Sign in' : 'Sign up'}</CardTitle>
          </CardHeader>
          <CardContent>
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
                      onChange={e => setEmail(e.target.value)}
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
                      onChange={e => setPassword(e.target.value)}
                    />
                  </InputGroup>
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
                        onChange={e => setConfirmPassword(e.target.value)}
                      />
                    </InputGroup>
                  </Field>
                )}

                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <Button type="submit" disabled={submitting} className="w-full">
                  {submitting ? (
                    <Spinner className="size-4" />
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
