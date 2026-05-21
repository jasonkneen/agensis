import { useState, useEffect, useCallback } from 'react';
import { backendClient } from '../lib/backendClient';

type User = { id: string; email?: string | null };
type Session = { access_token: string; user: User };

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    backendClient.auth.getSession().then(({ data: { session: s } }: any) => {
      setSession(s);
      setUser(s?.user ?? null);
      setLoading(false);
    });

    const { data: { subscription } } = backendClient.auth.onAuthStateChange((_event: any, s: any) => {
      setSession(s);
      setUser(s?.user ?? null);
    });

    return () => subscription.unsubscribe();
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

  return { user, session, loading, signUp, signIn, signOut };
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
