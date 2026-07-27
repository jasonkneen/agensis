import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import { AuthError, handleAuthCallback, MissingIdentityError, oauthLogin } from '@netlify/identity';
import { backendClient } from '../lib/backendClient';
import { clearAuthNotice, getAuthNotice, setAuthNotice, subscribeAuthNotice } from '../lib/authNotice';

type User = { id: string; email?: string | null };
type Session = { access_token: string; user: User };

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // The message the sign-in screen must show (expired session, failed social
  // login). Lives outside React because backendClient writes it from a 401.
  const authNotice = useSyncExternalStore(subscribeAuthNotice, getAuthNotice, getAuthNotice);

  useEffect(() => {
    let active = true;

    async function initializeAuth() {
      // Set when the OAuth exchange comes back with an error. Held rather than
      // published immediately so it is only shown if the failure actually left
      // the user signed out — publishing it while a valid session survives
      // would leave a stale "social login failed" banner waiting to ambush the
      // next sign-out.
      let oauthFailure: string | null = null;
      try {
        if (!consumeOAuthRedirectStatus()) {
          const callbackResult = await handleAuthCallback();
          if (callbackResult?.type === 'oauth') {
            const { data, error } = await backendClient.auth.signInWithOAuthSession();
            if (!error && active) {
              setSession(data.session);
              setUser(data.user);
              return;
            }
            // A failed exchange used to fall straight through to `finally`,
            // which loaded localStorage and rendered — the user was returned to
            // the app with no message whatsoever. Keep the server's reason
            // (e.g. "Social login was not completed") so the sign-in screen
            // can show it.
            if (error) {
              oauthFailure = error.message || 'Social login could not be completed. Please try again.';
            }
          }
        }
      } catch (error) {
        if (error instanceof MissingIdentityError || error instanceof AuthError) {
          clearAuthCallbackHash();
        } else {
          throw error;
        }
      } finally {
        if (active) {
          const { data: { session: s } } = await backendClient.auth.getSession();
          if (oauthFailure && !s) setAuthNotice(oauthFailure);
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

  // Deliberately does NOT seed the starter workspaces. Storing the session is
  // what renders the app, so seeding here ran concurrently with useWorkspaces'
  // first fetch: the fetch returned the empty list, cached it, and never
  // refetched — the account then had no workspace id for the whole session and
  // the onboarding tour's "Add" buttons failed on every click. useWorkspaces
  // seeds instead, once its own fetch has settled and come back empty, which
  // also covers sign-in and OAuth (neither of which ever seeded).
  const signUp = useCallback(async (email: string, password: string) => {
    const { error } = await backendClient.auth.signUp({ email, password });
    if (error) return { error: error.message };
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

  const dismissAuthNotice = useCallback(() => {
    clearAuthNotice();
  }, []);

  return { user, session, loading, signUp, signIn, signOut, signInWithOAuth, authNotice, dismissAuthNotice };
}

function consumeOAuthRedirectStatus() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const hasOAuthStatus = params.has('error') || params.has('error_description') || params.has('error_code');
  if (hasOAuthStatus) {
    clearAuthCallbackHash();
  }
  return hasOAuthStatus;
}

function clearAuthCallbackHash() {
  if (typeof window === 'undefined' || !hasAuthCallbackHash()) return;
  window.history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}`);
}

function hasAuthCallbackHash() {
  if (typeof window === 'undefined' || !window.location.hash) return false;
  const params = new URLSearchParams(window.location.hash.slice(1));
  return params.has('access_token')
    || params.has('confirmation_token')
    || params.has('recovery_token')
    || params.has('invite_token')
    || params.has('email_change_token')
    || params.has('error')
    || params.has('error_description')
    || params.has('error_code');
}
