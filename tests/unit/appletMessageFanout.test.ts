import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAppletMessageTarget } from '../../src/lib/appletBridge';

afterEach(() => vi.restoreAllMocks());

describe('canvas applet message bridge fanout', () => {
  it('installs one window listener and routes an applet message only to its source', () => {
    let hostListener: EventListenerOrEventListenerObject | null = null;
    const add = vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'message') hostListener = listener;
    }) as typeof window.addEventListener);
    const remove = vi.spyOn(window, 'removeEventListener').mockImplementation(() => {});
    const sources = Array.from({ length: 12 }, () => ({} as MessageEventSource));
    const calls = Array.from({ length: 12 }, () => vi.fn());

    const unregister = sources.map((source, index) => (
      registerAppletMessageTarget(source, calls[index])
    ));

    expect(add.mock.calls.filter(([type]) => type === 'message')).toHaveLength(1);

    const event = new MessageEvent('message', {
      data: { source: 'agensis-applet', type: 'agensis:ready' },
      source: sources[7],
    });
    if (typeof hostListener === 'function') hostListener(event);
    else hostListener?.handleEvent(event);

    expect(calls[7]).toHaveBeenCalledOnce();
    expect(calls.reduce((total, call) => total + call.mock.calls.length, 0)).toBe(1);

    unregister.forEach(dispose => dispose());
    expect(remove.mock.calls.filter(([type]) => type === 'message')).toHaveLength(1);
  });
});
