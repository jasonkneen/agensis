import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useLinkPreviews, __resetLinkPreviewStoreForTests } from '../../src/hooks/useLinkPreviews';

let root: Root;
let host: HTMLDivElement;
function Probe({ urls }: { urls: string[] }) {
  return createElement('div', null, useLinkPreviews(urls).map(entry =>
    createElement('span', { key: entry.url }, `${entry.url}:${entry.state}`)));
}
function answer(urls: string[]) {
  return new Response(JSON.stringify({ data: { previews: urls.map(url => ({
    url, finalUrl: url, status: 'ok', title: url, description: '', siteName: '',
    imagePath: '', detail: '', fetchedAt: null,
  })) } }), { headers: { 'Content-Type': 'application/json' } });
}
async function render(urls: string[]) {
  await act(async () => root.render(createElement(Probe, { urls })));
}
async function tick(ms = 60) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  __resetLinkPreviewStoreForTests();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  __resetLinkPreviewStoreForTests();
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('does not fetch links whose last card unmounted before the batch starts', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await render(['https://example.com/abandoned']);
  await render([]);
  await tick();
  expect(fetch).not.toHaveBeenCalled();
});
it('limits concurrency to one batch and gives hung requests a terminal state', async () => {
  const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')));
  }));
  vi.stubGlobal('fetch', fetch);
  const urls = Array.from({ length: 9 }, (_, i) => `https://example.com/${i}`);
  await render(urls);
  await tick(120);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetch.mock.calls[0][1].body)).urls).toHaveLength(8);
  await tick(29_940);
  expect(host.textContent).toContain(`${urls[0]}:ready`);
  await tick();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(fetch.mock.calls[1][1].body)).urls).toEqual([urls[8]]);
});
it('caps retained offscreen previews while keeping mounted answers stable', async () => {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => answer(JSON.parse(String(init.body)).urls));
  vi.stubGlobal('fetch', fetch);
  const urls = Array.from({ length: 258 }, (_, i) => `https://example.com/${i}`);
  await render(urls);
  await tick(2_040);
  expect(host.textContent).not.toContain(':pending');
  await render([urls[0]]);
  await tick();
  expect(host.textContent).toBe(`${urls[0]}:ready`);
  const calls = fetch.mock.calls.length;
  await render([urls[0], urls[1]]);
  await tick();
  expect(fetch).toHaveBeenCalledTimes(calls + 1);
  expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1].body)).urls).toEqual([urls[1]]);
});
it('ignores a late response from a reset store', async () => {
  let finish: (value: Response) => void = () => {};
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  const url = 'https://example.com/late';
  await render([url]);
  await tick();
  await render([]);
  __resetLinkPreviewStoreForTests();
  await act(async () => finish(answer([url])));
  await render([url]);
  expect(host.textContent).toBe(`${url}:pending`);
});
