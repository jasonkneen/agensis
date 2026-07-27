import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MessageAttachmentList } from '../../src/components/chat/MessageAttachments';
import type { MessageAttachment } from '../../src/types';

// Stubbed so the assertions are about the COMPONENT's contract — that it goes
// through the authenticated helpers at all — rather than about reconstructing a
// valid stored session.
vi.mock('../../src/lib/backendClient', () => ({
  apiUrl: (path: string) => `https://backend.test${path}`,
  apiAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
}));

// What only a mount can settle about an attachment:
//
//   1. AN IMAGE GETS AN <img>, AND ITS BYTES COME FROM THE AUTHENTICATED ROUTE.
//      There is no public URL — the <img src> must be a blob:, produced by a
//      fetch that carried an Authorization header. A raw /backend/files/... in
//      an `src` would render as a broken image for every user.
//   2. A DELETED FILE READS AS A SENTENCE. When the route 404s, the chip says
//      "File unavailable" instead of leaving a broken-image glyph.
//   3. A CRAFTED NAME IS TEXT. Markup in a file name reaches the DOM as
//      characters, never as elements, and never escapes its chip.
//   4. NOTHING OPENS IN A TAB. `download` is what a click does; a file whose
//      type is attacker-chosen must never be handed to a viewer in this origin.

const FETCHED: Array<{ url: string; headers: Record<string, string> }> = [];
let objectUrlSeq = 0;
let fetchStatus = 200;
let root: Root | null = null;
let host: HTMLDivElement;

function attachment(over: Partial<MessageAttachment> & { id: string }): MessageAttachment {
  return { name: 'file.bin', type: '', size: 0, ...over };
}

async function mount(attachments: MessageAttachment[]) {
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(MessageAttachmentList, { attachments }));
  });
}

beforeEach(() => {
  FETCHED.length = 0;
  objectUrlSeq = 0;
  fetchStatus = 200;
  host = document.createElement('div');
  document.body.appendChild(host);

  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    FETCHED.push({ url: String(url), headers: (init?.headers || {}) as Record<string, string> });
    if (fetchStatus !== 200) {
      return { ok: false, status: fetchStatus, blob: async () => new Blob() } as unknown as Response;
    }
    return { ok: true, status: 200, blob: async () => new Blob(['bytes']) } as unknown as Response;
  }));

  // jsdom has no object-URL implementation.
  URL.createObjectURL = vi.fn(() => `blob:mock/${++objectUrlSeq}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host.remove();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('MessageAttachmentList', () => {
  it('renders nothing at all for an empty list', async () => {
    await mount([]);
    expect(host.innerHTML).toBe('');
  });

  it('serves an image through the authenticated route, not a public URL', async () => {
    await mount([attachment({ id: 'file-1', name: 'shot.png', type: 'image/png', size: 2048 })]);

    const request = FETCHED.find(entry => entry.url.includes('/backend/files/file-1/content'));
    expect(request).toBeTruthy();
    // An <img src> cannot carry this header, which is exactly why the bytes are
    // fetched into a blob first.
    expect(JSON.stringify(request!.headers)).toContain('test-token');

    const img = host.querySelector('img');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toMatch(/^blob:/);
    expect(img!.getAttribute('src')).not.toContain('/backend/files/');
    expect(img!.getAttribute('alt')).toBe('shot.png');
  });

  it('renders a non-image as a chip with no <img> and no prefetch', async () => {
    await mount([attachment({ id: 'file-2', name: 'notes.pdf', type: 'application/pdf', size: 1024 })]);

    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('notes.pdf');
    expect(host.textContent).toContain('1.0 KB');
    // A chip costs nothing until clicked — twenty PDFs must not fire twenty
    // downloads on scroll.
    expect(FETCHED).toHaveLength(0);
  });

  // SVG is an image by MIME prefix and a scriptable document in fact.
  it('renders an SVG as a chip, never as an inline image', async () => {
    await mount([attachment({ id: 'file-3', name: 'logo.svg', type: 'image/svg+xml', size: 300 })]);
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('logo.svg');
  });

  it('says "File unavailable" when the row behind an image is gone', async () => {
    fetchStatus = 404;
    await mount([attachment({ id: 'missing', name: 'gone.png', type: 'image/png', size: 10 })]);

    expect(host.textContent).toContain('File unavailable');
    expect(host.textContent).toContain('gone.png');
    // The point of the whole branch: no broken-image glyph.
    expect(host.querySelector('img')).toBeNull();
  });

  it('says "File unavailable" when a chip download 404s', async () => {
    fetchStatus = 404;
    await mount([attachment({ id: 'missing', name: 'gone.pdf', type: 'application/pdf', size: 10 })]);
    expect(host.textContent).not.toContain('File unavailable');

    const button = host.querySelector('button');
    await act(async () => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(host.textContent).toContain('File unavailable');
  });

  it('renders a crafted name as text, not markup', async () => {
    const hostile = '<img src=x onerror="alert(1)">.png';
    await mount([attachment({ id: 'file-4', name: hostile, type: 'application/pdf', size: 1 })]);

    // The <img> that exists in the NAME must not exist in the DOM.
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelectorAll('[onerror]')).toHaveLength(0);
    expect(host.textContent).toContain('<img src=x onerror="alert(1)">.png');
  });

  it('cannot break the row with a very long or multi-line name', async () => {
    await mount([attachment({
      id: 'file-5',
      name: `${'wide'.repeat(400)}\n\n\n${'more'.repeat(400)}.zip`,
      type: 'application/zip',
      size: 1,
    })]);

    const text = host.textContent || '';
    expect(text).not.toContain('\n');
    // Capped by safeAttachmentName, so no single label can widen the transcript.
    expect(text.length).toBeLessThan(120);
    // Every chip is truncation-bounded rather than free to grow.
    expect(host.querySelector('.truncate')).toBeTruthy();
  });

  it('downloads on click and never opens a tab', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const clicks: HTMLAnchorElement[] = [];
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patched(this: HTMLAnchorElement) { clicks.push(this); };

    try {
      await mount([attachment({ id: 'file-6', name: 'report.pdf', type: 'application/pdf', size: 5 })]);
      const button = host.querySelector('button');
      await act(async () => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

      expect(open).not.toHaveBeenCalled();
      expect(clicks).toHaveLength(1);
      expect(clicks[0].download).toBe('report.pdf');
      expect(clicks[0].href).toMatch(/^blob:/);
      // The anchor is torn down again, not left in the document.
      expect(document.querySelector('a[download]')).toBeNull();
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
    }
  });

  it('renders one control per attachment, keyed by id', async () => {
    await mount([
      attachment({ id: 'a', name: 'a.pdf', type: 'application/pdf' }),
      attachment({ id: 'b', name: 'b.pdf', type: 'application/pdf' }),
      attachment({ id: 'c', name: 'c.png', type: 'image/png' }),
    ]);
    expect(host.querySelectorAll('button')).toHaveLength(3);
  });
});
