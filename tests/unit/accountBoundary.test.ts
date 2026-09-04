import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountScopedProviders } from '../../src/components/auth/AccountScopedProviders';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let mountCount = 0;
let root: Root | null = null;
let container: HTMLDivElement;

function MountProbe() {
  const [mountId] = useState(() => ++mountCount);
  return createElement('output', { 'data-mount-id': String(mountId) }, String(mountId));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
});

describe('account provider boundary', () => {
  it('remounts provider-owned children across sign-out and the next account', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(createElement(
        AccountScopedProviders,
        { accountKey: 'account-a' },
        createElement(MountProbe),
      ));
    });
    expect(container.querySelector('output')?.textContent).toBe('1');

    act(() => {
      root?.render(createElement(
        AccountScopedProviders,
        { accountKey: 'signed-out' },
        createElement(MountProbe),
      ));
    });
    expect(container.querySelector('output')?.textContent).toBe('2');

    act(() => {
      root?.render(createElement(
        AccountScopedProviders,
        { accountKey: 'account-b' },
        createElement(MountProbe),
      ));
    });
    expect(container.querySelector('output')?.textContent).toBe('3');
  });
});
