import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DrawingLayer } from '../../src/components/canvas/DrawingLayer';
import type { CanvasObject } from '../../src/types';

vi.mock('../../src/components/canvas/CanvasToolbar', () => ({ CanvasToolbar: () => null }));
vi.mock('../../src/components/canvas/CanvasObjectRenderer', () => ({
  CanvasObjectRenderer: ({ canvasWidth, canvasHeight }: { canvasWidth: number; canvasHeight: number }) =>
    React.createElement('output', null, `${canvasWidth}x${canvasHeight}`),
}));
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('updates canvas coordinates on resize without measuring every unrelated render', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let resized: ResizeObserverCallback | undefined;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resized = callback; }
    observe() {} unobserve() {} disconnect() {}
  });
  let width = 1000;
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    x: 0, y: 0, left: 0, top: 0, right: width, bottom: 800, width, height: 800, toJSON() {},
  }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const object = { id: 'object', type: 'rectangle', x: 10, y: 10, width: 20, height: 20, z_index: 1 } as CanvasObject;
  const props = {
    objects: [object], groups: [], drawingActive: false,
    onToggleDrawing: vi.fn(), onAddObject: vi.fn(), onUpdateObject: vi.fn(), onDeleteObject: vi.fn(),
    onBringToFront: vi.fn(), onCreateGroup: vi.fn(), onDeleteGroup: vi.fn(),
  };
  const render = () => act(() => root!.render(React.createElement(DrawingLayer, { ...props })));
  render();
  expect(host.textContent).toContain('1000x800');
  measure.mockClear(); render(); render();
  expect(measure).not.toHaveBeenCalled();
  width = 600;
  act(() => resized?.([], {} as ResizeObserver));
  expect(host.textContent).toContain('600x800');
});
