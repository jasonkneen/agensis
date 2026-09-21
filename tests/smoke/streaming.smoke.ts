import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import StreamingPanel from '../../src/components/settings/StreamingPanel';
import { BroadcastIndicator } from '../../src/components/BroadcastIndicator';
import { broadcastMonitor } from '../../src/lib/broadcast';
let container: HTMLDivElement;
let root: Root;
const previous = window.electronAPI;
const stopped = { id: '', state: 'stopped' as const, error: null };
const live = { id: 'one', state: 'running' as const, error: null };
beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  window.electronAPI = { pickFolder: vi.fn(), broadcast: {
    capabilities: vi.fn().mockResolvedValue({ available: true }),
    sources: vi.fn().mockResolvedValue(Array.from({ length: 8 }, (_, n) => ({ id: `window:${n}`, name: `BroadcastWindow${n}` }))),
    config: vi.fn().mockResolvedValue({ url: 'rtmp://127.0.0.1/live', service: 'custom', hasKey: true, sourceId: 'window:1', audio: false }),
    save: vi.fn(), start: vi.fn().mockResolvedValue({ ...live, state: 'starting' }),
    stop: vi.fn().mockResolvedValue(stopped), status: vi.fn().mockResolvedValue(stopped),
  } };
  await broadcastMonitor.refresh();
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); window.electronAPI = previous; vi.restoreAllMocks();
});
const button = (text: string) => Array.from(document.querySelectorAll('button')).find(node => node.textContent === text)!;
async function render() { await act(async () => root.render(createElement(StreamingPanel))); }
it('shows all sources, secure saved key and requires explicit confirmation', async () => {
  await render();
  for (let n = 0; n < 8; n++) expect(container.textContent).toContain(`BroadcastWindow${n}`);
  expect(button('Start Broadcast').disabled).toBe(true); expect(window.electronAPI!.broadcast!.start).not.toHaveBeenCalled();
  expect(container.querySelector('input[name="broadcast-key"]')?.getAttribute('type')).toBe('password');
  expect(container.textContent).toContain('does NOT stop'); expect(container.textContent).toContain('saved securely');
});
function Surface() {
  const [open, setOpen] = useState(true);
  return createElement('div', null, open ? createElement(StreamingPanel, { onStarted: () => setOpen(false) }) : null, createElement(BroadcastIndicator));
}
it('closes settings only after encoded output; global indicator survives and can reopen/stop', async () => {
  await act(async () => root.render(createElement(Surface)));
  await act(async () => (container.querySelectorAll('input[type="checkbox"]')[1] as HTMLInputElement).click());
  await act(async () => button('Start Broadcast').click());
  expect(window.electronAPI!.broadcast!.start).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'window:1', key: '' }));
  expect(container.querySelector('section')).not.toBeNull();
  vi.mocked(window.electronAPI!.broadcast!.status).mockResolvedValue(live);
  await act(async () => broadcastMonitor.refresh());
  expect(container.querySelector('section')).toBeNull();
  expect(container.querySelector('aside')?.textContent).toContain('Broadcasting');
  expect(window.electronAPI!.broadcast!.stop).not.toHaveBeenCalled();
  await act(async () => button('Streaming Settings').click());
  // React.lazy resolves the same module through an async import.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Stream From This Computer');
  await act(async () => button('Stop Broadcast').click());
  expect(window.electronAPI!.broadcast!.stop).toHaveBeenCalledWith('one');
  expect(container.querySelector('aside')).toBeNull();
});
it('reconnects after renderer restart with Stop visible even when status becomes uncertain', async () => {
  vi.mocked(window.electronAPI!.broadcast!.status).mockResolvedValue(live);
  await act(async () => root.render(createElement(BroadcastIndicator)));
  expect(button('Stop Broadcast')).toBeTruthy(); expect(window.electronAPI!.broadcast!.start).not.toHaveBeenCalled();
  vi.mocked(window.electronAPI!.broadcast!.status).mockRejectedValue(new Error('secret-not-for-ui'));
  await act(async () => broadcastMonitor.refresh());
  expect(container.textContent).toContain('may still be running'); expect(button('Stop Broadcast')).toBeTruthy();
  expect(container.textContent).not.toContain('secret-not-for-ui');
});
it('explains desktop requirements without fake controls', async () => {
  window.electronAPI = undefined; await render(); expect(container.textContent).toContain('requires the agensis Electron'); expect(container.querySelector('button')).toBeNull();
});
