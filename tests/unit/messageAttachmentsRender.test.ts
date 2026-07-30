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
//   5. THE PREVIEW IS A DIALOG. A thumbnail is only useful if the full picture
//      is one click away, and a modal is only usable if Escape closes it, focus
//      is trapped inside it, and focus returns to where it came from.

// React only honours act() when it is told it is in a test environment. Without
// this the dialog's own layout effects flush outside the act() that triggered
// them and React says so, once per update.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FETCHED: Array<{ url: string; headers: Record<string, string> }> = [];
let objectUrlSeq = 0;
let fetchStatus = 200;
// When set, a fetch does not settle until the test says so — the only way to
// reach "the file vanished while the preview was open".
let releaseFetch: ((status: number) => void) | null = null;
let root: Root | null = null;
let host: HTMLDivElement;

function attachment(over: Partial<MessageAttachment> & { id: string }): MessageAttachment {
  return { name: 'file.bin', type: '', size: 0, ...over };
}

async function mount(attachments: MessageAttachment[], onRemove?: (attachment: MessageAttachment) => void) {
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(MessageAttachmentList, { attachments, onRemove }));
  });
}

function response(status: number) {
  return {
    ok: status === 200,
    status,
    blob: async () => new Blob(status === 200 ? ['bytes'] : []),
  } as unknown as Response;
}

async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

/** Radix portals the dialog to document.body, not into our host node. */
function dialog(): HTMLElement | null {
  return document.body.querySelector('[data-testid="attachment-preview"]');
}

/**
 * A dialog's focus moves are deferred (Radix restores focus after the exit
 * transition has been given a frame), so a single act() flush is not enough —
 * it passed alone and failed inside the full run, which is the flake this
 * avoids. Assert the outcome, not the number of ticks it took.
 */
async function waitFor(predicate: () => boolean, what: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeEach(() => {
  FETCHED.length = 0;
  objectUrlSeq = 0;
  fetchStatus = 200;
  releaseFetch = null;
  host = document.createElement('div');
  document.body.appendChild(host);

  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    FETCHED.push({ url: String(url), headers: (init?.headers || {}) as Record<string, string> });
    if (fetchStatus === 0) {
      return new Promise<Response>(resolve => { releaseFetch = status => resolve(response(status)); });
    }
    return Promise.resolve(response(fetchStatus));
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

// Chat never passes onRemove — a sent message's attachments are history. The
// one caller that owns its list (a task editing its own attachments) does, and
// needs a second control alongside the download button without breaking the
// download button itself.
describe('remove control (onRemove)', () => {
  it('adds no extra control when onRemove is omitted — the chat path is untouched', async () => {
    await mount([attachment({ id: 'file-7', name: 'plan.pdf', type: 'application/pdf', size: 10 })]);
    expect(host.querySelectorAll('button')).toHaveLength(1);
  });

  it('renders a second control per chip once a caller passes onRemove', async () => {
    const onRemove = vi.fn();
    await mount([attachment({ id: 'file-8', name: 'plan.pdf', type: 'application/pdf', size: 10 })], onRemove);
    expect(host.querySelectorAll('button')).toHaveLength(2);
  });

  it('clicking remove calls back with the attachment and never downloads', async () => {
    const onRemove = vi.fn();
    const target = attachment({ id: 'file-9', name: 'plan.pdf', type: 'application/pdf', size: 10 });
    await mount([target], onRemove);

    const remove = host.querySelector('[aria-label="Remove plan.pdf"]') as HTMLButtonElement;
    expect(remove).toBeTruthy();
    await click(remove);

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith(target);
    expect(FETCHED).toHaveLength(0);
  });

  it('the download button still downloads when onRemove is also present', async () => {
    // jsdom does not implement anchor navigation; the download flow creates a
    // real <a download> and clicks it, which is exactly what "downloads on
    // click and never opens a tab" above already patches around.
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patched(this: HTMLAnchorElement) { void this; };
    try {
      const onRemove = vi.fn();
      await mount([attachment({ id: 'file-10', name: 'plan.pdf', type: 'application/pdf', size: 10 })], onRemove);

      const download = host.querySelector('[aria-label="Download plan.pdf"]') as HTMLButtonElement;
      await click(download);

      expect(FETCHED).toHaveLength(1);
      expect(onRemove).not.toHaveBeenCalled();
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
    }
  });

  it('an unavailable attachment can still be removed', async () => {
    fetchStatus = 404;
    const onRemove = vi.fn();
    const target = attachment({ id: 'file-11', name: 'gone.pdf', type: 'application/pdf', size: 10 });
    await mount([target], onRemove);

    await click(host.querySelector('[aria-label="Download gone.pdf"]') as HTMLButtonElement);
    expect(host.textContent).toContain('File unavailable');

    await click(host.querySelector('[aria-label="Remove gone.pdf"]') as HTMLButtonElement);
    expect(onRemove).toHaveBeenCalledWith(target);
  });

  it('an image thumbnail gets a remove button that does not open the preview', async () => {
    const onRemove = vi.fn();
    const target = attachment({ id: 'file-12', name: 'shot.png', type: 'image/png', size: 10 });
    await mount([target], onRemove);

    const remove = host.querySelector('[aria-label="Remove shot.png"]') as HTMLButtonElement;
    expect(remove).toBeTruthy();
    await click(remove);

    expect(onRemove).toHaveBeenCalledWith(target);
    expect(dialog()).toBeNull();
  });
});

// The size of the thing in the transcript. A message with an image has to still
// read as a message: the screenshot that prompted this took most of a floating
// window's height, and two of them made the channel unreadable.
describe('image thumbnails', () => {
  const image = () => attachment({ id: 'file-1', name: 'shot.png', type: 'image/png', size: 2048 });

  function loadImageAt(img: HTMLImageElement, naturalWidth: number, naturalHeight: number) {
    Object.defineProperty(img, 'naturalWidth', { value: naturalWidth, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: naturalHeight, configurable: true });
    return act(async () => { img.dispatchEvent(new Event('load')); });
  }

  it('reserves a bounded box before the bytes arrive', async () => {
    fetchStatus = 0; // never settles
    await mount([image()]);

    const button = host.querySelector('button') as HTMLButtonElement;
    // Reserved up front, so the transcript does not reflow when the blob lands.
    expect(button.style.width).toBe('160px');
    expect(button.style.height).toBe('120px');
    expect(button.textContent).toContain('Loading');
  });

  it('fits the real aspect ratio once the image decodes, within the bound', async () => {
    await mount([image()]);
    const button = host.querySelector('button') as HTMLButtonElement;
    await loadImageAt(host.querySelector('img') as HTMLImageElement, 2560, 1440);

    expect(button.style.height).toBe('120px');
    expect(button.style.width).toBe('213px');
  });

  it('does not blow a small image up to fill the box', async () => {
    await mount([image()]);
    const button = host.querySelector('button') as HTMLButtonElement;
    await loadImageAt(host.querySelector('img') as HTMLImageElement, 48, 48);

    expect(button.style.width).toBe('48px');
    expect(button.style.height).toBe('48px');
  });

  it('bounds the thumbnail by style, not by an unbounded <img>', async () => {
    await mount([image()]);
    const img = host.querySelector('img') as HTMLImageElement;
    // The image fills the reserved box; the box is what is capped. An <img>
    // free to size itself is how one screenshot took the whole window.
    expect(img.className).toContain('size-full');
    expect(img.className).toContain('object-contain');
    expect(host.querySelector('[style*="height: 120px"]')).toBeTruthy();
  });

  it('several images sit side by side and wrap rather than stacking', async () => {
    await mount([
      attachment({ id: 'a', name: 'a.png', type: 'image/png' }),
      attachment({ id: 'b', name: 'b.png', type: 'image/png' }),
      attachment({ id: 'c', name: 'c.png', type: 'image/png' }),
    ]);
    const list = host.querySelector('[data-testid="message-attachments"]') as HTMLElement;
    expect(list.className).toContain('flex-wrap');
    expect(host.querySelectorAll('button')).toHaveLength(3);
  });
});

// A thumbnail is only useful if the full picture is one click away, and a modal
// is only usable if it behaves like a dialog for someone on a keyboard.
describe('the image preview modal', () => {
  const image = () => attachment({ id: 'file-1', name: 'shot.png', type: 'image/png', size: 2048 });

  async function openPreview() {
    await mount([image()]);
    const trigger = host.querySelector('button') as HTMLButtonElement;
    trigger.focus();
    await click(trigger);
    await waitFor(() => dialog() !== null, 'the preview to open');
    return trigger;
  }

  it('says it opens a preview, not a download', async () => {
    await mount([image()]);
    const trigger = host.querySelector('button') as HTMLButtonElement;
    expect(trigger.getAttribute('aria-label')).toBe('Open preview of shot.png');
    expect(dialog()).toBeNull();
  });

  it('opens a real dialog named after the file, showing the image full size', async () => {
    await openPreview();

    const panel = dialog();
    expect(panel).toBeTruthy();
    expect(panel!.getAttribute('role')).toBe('dialog');
    // Modal, not a popover floating over the transcript: it comes with the
    // app's scrim, so it gets whatever surface treatment each theme applies.
    expect(document.body.querySelector('[data-slot="dialog-overlay"]')).toBeTruthy();
    expect(panel!.textContent).toContain('shot.png');

    const img = panel!.querySelector('img') as HTMLImageElement;
    expect(img).toBeTruthy();
    // Same authenticated blob the thumbnail already holds — no public URL, and
    // no second download of the same bytes.
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    expect(img.getAttribute('src')).not.toContain('/backend/files/');
    expect(FETCHED).toHaveLength(1);
    // Bounded by the viewport: chat lives in a floating, resizable window.
    expect(img.className).toContain('max-h-[70vh]');
  });

  it('offers an obvious close', async () => {
    await openPreview();
    const closers = Array.from(dialog()!.querySelectorAll('button'))
      .filter(button => (button.textContent || '').toLowerCase().includes('close'));
    expect(closers.length).toBeGreaterThan(0);
  });

  it('traps focus inside the dialog while it is open', async () => {
    const trigger = await openPreview();
    // Focus left the thumbnail and landed in the dialog.
    await waitFor(() => dialog()!.contains(document.activeElement), 'focus to move into the dialog');
    expect(document.activeElement).not.toBe(trigger);
  });

  it('closes on Escape and gives focus back to the thumbnail that opened it', async () => {
    const trigger = await openPreview();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    await waitFor(() => dialog() === null, 'the preview to close');
    // Where a keyboard user was before they opened it — not the top of the
    // document, which is where an unmanaged dialog dumps you.
    await waitFor(() => document.activeElement === trigger, 'focus to return to the thumbnail');
  });

  it('renders a crafted name as text inside the dialog too', async () => {
    const hostile = '<b onmouseover="alert(1)">shot</b>.png';
    await mount([attachment({ id: 'file-9', name: hostile, type: 'image/png', size: 1 })]);
    await click(host.querySelector('button') as HTMLButtonElement);
    await waitFor(() => dialog() !== null, 'the preview to open');

    const panel = dialog()!;
    expect(panel.querySelector('b')).toBeNull();
    expect(panel.querySelectorAll('[onmouseover]')).toHaveLength(0);
    expect(panel.textContent).toContain(hostile);
    // The picture is the only <img> in there; the one in the NAME is not real.
    expect(panel.querySelectorAll('img')).toHaveLength(1);
  });

  it('saves to disk from the dialog without opening a tab or refetching', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const clicks: HTMLAnchorElement[] = [];
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patched(this: HTMLAnchorElement) { clicks.push(this); };

    try {
      await openPreview();
      const download = Array.from(dialog()!.querySelectorAll('button'))
        .find(button => (button.textContent || '').trim() === 'Download');
      expect(download).toBeTruthy();
      await click(download!);

      expect(open).not.toHaveBeenCalled();
      expect(clicks).toHaveLength(1);
      expect(clicks[0].download).toBe('shot.png');
      expect(clicks[0].href).toMatch(/^blob:/);
      // The bytes were already here. One fetch for the whole interaction.
      expect(FETCHED).toHaveLength(1);
      // ...and the thumbnail's own object URL must survive the save.
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      expect(host.querySelector('img')!.getAttribute('src')).toMatch(/^blob:/);
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
    }
  });

  it('degrades to "File unavailable" inside the dialog when the file goes missing', async () => {
    // Click while the bytes are still in flight, then let the request fail —
    // the only way the modal can be open over a file that is not there.
    fetchStatus = 0;
    await mount([image()]);
    const trigger = host.querySelector('button') as HTMLButtonElement;
    await click(trigger);
    await waitFor(() => dialog() !== null, 'the preview to open');
    expect(dialog()!.textContent).toContain('Loading');

    await act(async () => { releaseFetch!(404); });

    const panel = dialog();
    expect(panel).toBeTruthy();
    expect(panel!.textContent).toContain('File unavailable');
    // The point of the whole branch: no broken-image glyph, at either size.
    expect(panel!.querySelector('img')).toBeNull();
    expect(host.querySelector('img')).toBeNull();
  });

  it('collapses to the unavailable chip once that dialog is closed', async () => {
    fetchStatus = 0;
    await mount([image()]);
    await click(host.querySelector('button') as HTMLButtonElement);
    await waitFor(() => dialog() !== null, 'the preview to open');
    await act(async () => { releaseFetch!(404); });

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    await waitFor(() => dialog() === null, 'the preview to close');
    expect(host.textContent).toContain('File unavailable');
    expect(host.textContent).toContain('shot.png');
    expect(host.querySelector('button')).toBeNull();
  });
});
