import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetZoomRouter, dispatchZoom, registerZoomHandler } from '@/lib/zoomRouter';

// The router is what keeps a zoom chord inside the pane you are looking at. Its
// two failure modes both matter: routing to the wrong pane (zooming a shell you
// are not using) and swallowing the chord (a dead shortcut). The `false` return
// is the contract that prevents the second one.

function pane(id: string, content: string): HTMLElement {
  const el = document.createElement('div');
  el.id = id;
  el.innerHTML = content;
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  __resetZoomRouter();
  document.body.innerHTML = '';
});

describe('zoom routing', () => {
  it('gives the chord to the pane whose element has focus', () => {
    const terminal = pane('terminal', '<textarea id="shell"></textarea>');
    const browser = pane('browser', '<input id="addr">');
    const calls: string[] = [];

    registerZoomHandler('terminal', () => { calls.push('terminal'); return true; }, terminal);
    registerZoomHandler('browser', () => { calls.push('browser'); return true; }, browser);

    (document.getElementById('shell') as HTMLTextAreaElement).focus();
    expect(dispatchZoom('in')).toBe(true);
    expect(calls).toEqual(['terminal']);
  });

  it('lets the app zoom when no pane is focused and nothing is hovered', () => {
    const terminal = pane('terminal', '<textarea id="shell"></textarea>');
    const handler = vi.fn(() => true);
    registerZoomHandler('terminal', handler, terminal);
    // Nothing focused inside any pane, so nothing claims it.
    expect(dispatchZoom('in')).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('falls through a pane that declines, so the chord is never dead', () => {
    // A terminal whose shell has not started, or a browser pane on the web where
    // the guest is an iframe, declines — and the app must still get the chord.
    const terminal = pane('terminal', '<textarea id="shell"></textarea>');
    registerZoomHandler('terminal', () => false, terminal);
    (document.getElementById('shell') as HTMLTextAreaElement).focus();
    expect(dispatchZoom('in')).toBe(false);
  });

  it('stops routing at the first pane that actually zooms', () => {
    const terminal = pane('terminal', '<textarea id="shell"></textarea>');
    const fallback = pane('fallback', '');
    const calls: string[] = [];
    registerZoomHandler('terminal', () => { calls.push('terminal'); return true; }, terminal);
    registerZoomHandler('fallback', () => { calls.push('fallback'); return true; }, fallback);
    (document.getElementById('shell') as HTMLTextAreaElement).focus();
    expect(dispatchZoom('out')).toBe(true);
    expect(calls).toEqual(['terminal']);
  });

  it('survives a handler that throws, rather than blocking every other pane', () => {
    const broken = pane('broken', '<input id="b">');
    const good = pane('good', '<input id="g">');
    registerZoomHandler('broken', () => { throw new Error('boom'); }, broken);
    registerZoomHandler('good', () => true, good);
    (document.getElementById('g') as HTMLInputElement).focus();
    expect(dispatchZoom('reset')).toBe(true);
  });

  it('unregisters cleanly, so a closed window stops claiming the chord', () => {
    const terminal = pane('terminal', '<textarea id="shell"></textarea>');
    const handler = vi.fn(() => true);
    const unsubscribe = registerZoomHandler('terminal', handler, terminal);
    (document.getElementById('shell') as HTMLTextAreaElement).focus();
    expect(dispatchZoom('in')).toBe(true);
    unsubscribe();
    expect(dispatchZoom('in')).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
