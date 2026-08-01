import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const offlineDbSource = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/offlineDb.ts'), 'utf8');
const authSource = fs.readFileSync(path.resolve(process.cwd(), 'src/hooks/useAuth.ts'), 'utf8');
const networkSource = fs.readFileSync(path.resolve(process.cwd(), 'src/hooks/useNetworkStatus.ts'), 'utf8');
const appSource = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf8');

describe('offline account isolation', () => {
  it('clears both offline stores before changing the recorded owner', () => {
    const guard = offlineDbSource.slice(
      offlineDbSource.indexOf('export async function prepareOfflineDataForUser'),
      offlineDbSource.indexOf('/** Remove both cached reads'),
    );
    expect(guard).toContain('await clearOfflineData()');
    expect(guard.indexOf('await clearOfflineData()')).toBeLessThan(guard.indexOf('localStorage.setItem'));

    const clear = offlineDbSource.slice(
      offlineDbSource.indexOf('export async function clearOfflineData'),
      offlineDbSource.indexOf('export async function enqueue'),
    );
    expect(clear).toContain('QUEUE_STORE');
    expect(clear).toContain('CACHE_STORE');
  });

  it('establishes the owner before exposing a session and clears it on sign-out', () => {
    const applySession = authSource.slice(
      authSource.indexOf('async function applySession'),
      authSource.indexOf('async function initializeAuth'),
    );
    expect(applySession.indexOf('await prepareOfflineDataForUser')).toBeLessThan(
      applySession.indexOf('setSession(nextSession)'),
    );

    const signOut = authSource.slice(
      authSource.indexOf('const signOut = useCallback'),
      authSource.indexOf('const signInWithOAuth'),
    );
    expect(signOut).toContain('await prepareOfflineDataForUser(null)');
  });

  it('does not inspect or flush an offline queue while signed out', () => {
    expect(appSource).toContain('useNetworkStatus(user?.id ?? null)');
    expect(networkSource).toContain('if (!userId || syncingRef.current || !navigator.onLine) return');
    expect(networkSource).toContain('if (!online || !userId) return');
  });
});
