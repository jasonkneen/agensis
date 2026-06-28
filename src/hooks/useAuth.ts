import { useState, useEffect, useCallback } from 'react';
import { AuthError, handleAuthCallback, MissingIdentityError, oauthLogin } from '@netlify/identity';
import { backendClient } from '../lib/backendClient';

type User = { id: string; email?: string | null };
type Session = { access_token: string; user: User };

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function initializeAuth() {
      try {
        const callbackResult = await handleAuthCallback();
        if (callbackResult?.type === 'oauth') {
          const { data, error } = await backendClient.auth.signInWithOAuthSession();
          if (!error && active) {
            if (data.user) {
              await seedWorkspaces(data.user.id);
            }
            setSession(data.session);
            setUser(data.user);
            return;
          }
        }
      } catch (error) {
        if (!(error instanceof MissingIdentityError) && !(error instanceof AuthError)) {
          throw error;
        }
      } finally {
        if (active) {
          const { data: { session: s } } = await backendClient.auth.getSession();
          setSession(s);
          setUser(s?.user ?? null);
          setLoading(false);
        }
      }
    }

    initializeAuth();
    const { data: { subscription } } = backendClient.auth.onAuthStateChange((_event: string, s: Session | null) => {
      setSession(s);
      setUser(s?.user ?? null);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    const { data, error } = await backendClient.auth.signUp({ email, password });
    if (error) return { error: error.message };
    if (data.user) {
      await seedWorkspaces(data.user.id);
    }
    return { error: null };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await backendClient.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return { error: null };
  }, []);

  const signOut = useCallback(async () => {
    await backendClient.auth.signOut();
  }, []);

  const signInWithOAuth = useCallback(async (provider: 'google' | 'github') => {
    try {
      oauthLogin(provider);
      return { error: null };
    } catch (error) {
      if (error instanceof MissingIdentityError) {
        return { error: 'Social login is not configured for this site.' };
      }
      if (error instanceof AuthError) {
        return { error: error.message };
      }
      return { error: error instanceof Error ? error.message : 'Unable to start social login.' };
    }
  }, []);

  return { user, session, loading, signUp, signIn, signOut, signInWithOAuth };
}

async function seedWorkspaces(userId: string) {
  const { data: existing } = await backendClient
    .from('workspaces')
    .select('id')
    .eq('user_id', userId)
    .limit(1);

  if (existing && existing.length > 0) return;

  await backendClient.from('workspaces').insert([
    { name: 'Personal', description: 'Your personal workspace', icon: '🌱', user_id: userId },
    { name: 'Work', description: 'Professional workspace', icon: '💼', user_id: userId },
  ]);
}
