import type { ReactNode } from 'react';
import { WindowManagerProvider } from '../../providers/WindowManagerProvider';
import { HuddleDockProvider } from '../huddle/HuddleDockContext';

/** Keep provider-owned state inside the authenticated account boundary. */
export function AccountScopedProviders({ accountKey, children }: { accountKey: string; children: ReactNode }) {
  return (
    <WindowManagerProvider key={accountKey}>
      {/* Huddles survive ordinary view navigation but are reset on account
          changes so a new account cannot inherit the previous call. */}
      <HuddleDockProvider key={accountKey}>
        {children}
      </HuddleDockProvider>
    </WindowManagerProvider>
  );
}
