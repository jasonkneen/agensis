import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useHistoryScrollAnchor } from '../../src/hooks/useHistoryScrollAnchor';

let root: Root;
let host: HTMLDivElement;
let viewport: HTMLDivElement;
const onLoad = vi.fn();
function Harness({ ids, loading = false, scope = 'session-a', inset = 60 }: { ids: string[]; loading?: boolean; scope?: string; inset?: number }) {
  const history = useHistoryScrollAnchor({ scopeKey: scope, firstMessageId: ids[0], loadingEarlier: loading, onLoadEarlier: onLoad });
  return createElement('div', {
    ref: (node: HTMLDivElement | null) => {
      history.viewportRef.current = node;
      if (node) {
        viewport = node;
        node.getBoundingClientRect = () => new DOMRect(0, 100, 500, 600);
      }
    },
  }, createElement('button', { onClick: history.loadEarlier }, 'Load'), ...ids.map((id, index) => createElement('div', {
    key: id, 'data-slot': 'message-scroller-item', 'data-id': id,
    ref: (node: HTMLDivElement | null) => {
      if (node) node.getBoundingClientRect = () => new DOMRect(0, 100 + inset + index * 100 - viewport.scrollTop, 500, 100);
    },
  }, id)));
}
function render(props: Parameters<typeof Harness>[0]) {
  act(() => root.render(createElement(Harness, props)));
}
function load() { act(() => host.querySelector('button')?.click()); }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  onLoad.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it('keeps the visible row at the same offset after prepending history', () => {
  render({ ids: ['old', 'latest'] });
  load();
  render({ ids: ['old', 'latest'], loading: true });
  expect(viewport.scrollTop).toBe(0);
  render({ ids: ['earlier-1', 'earlier-2', 'old', 'latest'] });
  expect(viewport.scrollTop).toBe(200);
  expect(host.querySelector('[data-id="old"]')?.getBoundingClientRect().top).toBe(160);
  expect(onLoad).toHaveBeenCalledOnce();
});
it('does not adjust ordinary realtime appends or repeated renders', () => {
  render({ ids: ['old', 'latest'] });
  viewport.scrollTop = 40;
  render({ ids: ['old', 'latest', 'incoming'] });
  expect(viewport.scrollTop).toBe(40);
});
it('never restores an anchor into another conversation', () => {
  render({ ids: ['old', 'latest'] });
  load();
  render({ ids: ['earlier', 'old', 'latest'], scope: 'session-b' });
  expect(viewport.scrollTop).toBe(0);
});
it('settles a failed or empty page without leaving an anchor for future updates', () => {
  render({ ids: ['old'] });
  load();
  render({ ids: ['old'], loading: true });
  render({ ids: ['old'], inset: 50 });
  expect(viewport.scrollTop).toBe(-10);
  render({ ids: ['unrelated', 'old'], inset: 50 });
  expect(viewport.scrollTop).toBe(-10);
});
