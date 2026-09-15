import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FloatingWindowShell } from '../../src/components/windows/FloatingWindowShell';
import type { FloatingWindow } from '../../src/types';

vi.mock('../../src/providers/PickerProvider', () => ({ GlobalPickerTitlebarControl: () => null }));
vi.mock('../../src/hooks/useWindows', () => ({ canSplitContainer: () => false }));
let root: Root | undefined;
let viewport: HTMLDivElement | undefined;
afterEach(() => { act(() => root?.unmount()); viewport?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('reuses viewport geometry on content updates and refreshes it when resized', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const observers: ResizeObserverCallback[] = [];
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { observers.push(callback); }
    observe() {} unobserve() {} disconnect() {}
  });
  viewport = document.createElement('div');
  viewport.dataset.workspaceViewport = 'true';
  document.body.append(viewport);
  let width = 1000;
  const measure = vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => ({
    x: 0, y: 0, left: 0, top: 0, right: width, bottom: 800, width, height: 800, toJSON() {},
  }));
  const win = { id: 'window', title: 'Agents', type: 'agents', x: 0, y: 0, width: 900, height: 600, zIndex: 1 } as FloatingWindow;
  const callbacks = { onClose: vi.fn(), onFocus: vi.fn(), onUpdate: vi.fn(), onMinimize: vi.fn() };
  root = createRoot(viewport);
  const render = (label: string) => act(() => root!.render(React.createElement(FloatingWindowShell, {
    ...callbacks, window: { ...win }, children: label,
  })));
  render('First content');
  measure.mockClear();
  render('Realtime update');
  render('Another update');
  expect(measure).not.toHaveBeenCalled();
  width = 600;
  act(() => observers.forEach(callback => callback([], {} as ResizeObserver)));
  const shell = viewport.querySelector<HTMLElement>('[data-floating-window-id]')!;
  expect(parseFloat(shell.style.width)).toBeLessThanOrEqual(600);
  expect(shell.textContent).toContain('Another update');
});
