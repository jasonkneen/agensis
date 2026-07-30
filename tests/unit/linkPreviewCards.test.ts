import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LinkPreviewCards } from '../../src/components/chat/LinkPreviewCards';
import { __resetLinkPreviewStoreForTests } from '../../src/hooks/useLinkPreviews';
import type { LinkPreview } from '../../src/lib/linkPreview';

// Three things about a link card cannot be checked by reading the component, and
// all three have a bad failure mode:
//
//   1. The metadata is a STRANGER'S TEXT. If it were ever interpreted as markup,
//      a card would be a stored-XSS delivery mechanism in every channel that link
//      was posted to. The assertion here is on the rendered DOM, not on the code.
//   2. The href must be the URL FROM THE MESSAGE. A card that can navigate
//      somewhere the message did not is a phishing primitive.
//   3. Pending / no-metadata / failed must each RENDER SOMETHING deliberate. A
//      spinner that never resolves and a blank bordered box both read as broken.

const URL_IN_MESSAGE = 'https://example.com/post?s=20';
const MESSAGE = `Crazy how good these models are ${URL_IN_MESSAGE}`;

function preview(overrides: Partial<LinkPreview> = {}): LinkPreview {
  return {
    url: URL_IN_MESSAGE,
    finalUrl: 'https://tracker.evil.test/redirected',
    status: 'ok',
    title: 'Crazy how good these models are',
    description: 'A short thread about it.',
    siteName: 'Example',
    imagePath: '',
    detail: '',
    fetchedAt: '2026-07-26T10:00:00.000Z',
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  __resetLinkPreviewStoreForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** Answer the batched POST with these rows, then let the flush timer run. */
async function renderWith(rows: LinkPreview[], content = MESSAGE) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { previews: rows }, error: null }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    root.render(createElement(LinkPreviewCards, { content }));
  });
  await act(async () => {
    // The store batches with a short timer before it sends.
    await new Promise(resolve => setTimeout(resolve, 120));
  });
  return fetchMock;
}

describe('LinkPreviewCards', () => {
  it('renders nothing when the message has no link', async () => {
    const fetchMock = await renderWith([], 'just words, no links');
    expect(container.querySelector('[data-testid="link-previews"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks the server for the URL it found, and only that', async () => {
    const fetchMock = await renderWith([preview()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ urls: [URL_IN_MESSAGE] });
    expect(init.method).toBe('POST');
  });

  it('shows the title, description and site as TEXT', async () => {
    await renderWith([preview()]);
    const card = container.querySelector('[data-testid="link-preview-card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Crazy how good these models are');
    expect(card?.textContent).toContain('A short thread about it.');
    expect(card?.textContent).toContain('Example');
  });

  it('NEVER interprets the page\'s metadata as markup', async () => {
    // Everything a hostile page could try, in one row.
    await renderWith([preview({
      title: '<img src=x onerror="alert(1)">',
      description: '<script>alert(2)</script><b>bold?</b>',
      siteName: '<iframe src="javascript:alert(3)"></iframe>',
    })]);
    const card = container.querySelector('[data-testid="link-preview-card"]');
    expect(card).not.toBeNull();
    // Not one of them became an element.
    expect(card?.querySelector('img')).toBeNull();
    expect(card?.querySelector('script')).toBeNull();
    expect(card?.querySelector('iframe')).toBeNull();
    expect(card?.querySelector('b')).toBeNull();
    // They are all still visible, as the literal characters they are — which is
    // what "rendered as text" means, and is why nothing here needs a sanitizer.
    expect(card?.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(card?.textContent).toContain('<b>bold?</b>');
    expect(container.innerHTML).toContain('&lt;img src=x');
  });

  it('links to the URL from the MESSAGE, never to anything the page said', async () => {
    await renderWith([preview()]);
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe(URL_IN_MESSAGE);
    // finalUrl is where a redirect chain ended up. It is not the href, so a page
    // cannot make a card point somewhere the message did not.
    expect(container.innerHTML).not.toContain('tracker.evil.test');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });

  it('shows a pending line while the answer is in flight', async () => {
    // A fetch that never settles: the pending state is all there is.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    await act(async () => {
      root.render(createElement(LinkPreviewCards, { content: MESSAGE }));
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 120));
    });
    const state = container.querySelector('[data-testid="link-preview-state"]');
    expect(state?.textContent).toBe('example.com · loading preview');
    expect(container.querySelector('[data-testid="link-preview-card"]')).toBeNull();
  });

  it('says so plainly when the page publishes no metadata', async () => {
    await renderWith([preview({ status: 'empty', title: '', description: '', siteName: 'example.com' })]);
    const state = container.querySelector('[data-testid="link-preview-state"]');
    expect(state?.textContent).toBe('example.com · no preview available');
    expect(container.querySelector('[data-testid="link-preview-card"]')).toBeNull();
  });

  it('says so plainly when the unfurl failed, and keeps the reason for a human', async () => {
    await renderWith([preview({ status: 'failed', title: '', description: '', detail: 'timeout' })]);
    const state = container.querySelector('[data-testid="link-preview-state"]');
    expect(state?.textContent).toBe('example.com · preview unavailable');
    expect(state?.getAttribute('title')).toBe('Reason: timeout');
  });

  it('resolves to a failed line rather than spinning forever when the request dies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await act(async () => {
      root.render(createElement(LinkPreviewCards, { content: MESSAGE }));
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 120));
    });
    expect(container.querySelector('[data-testid="link-preview-state"]')?.textContent)
      .toBe('example.com · preview unavailable');
  });

  it('resolves to a failed line when the server answers for nothing', async () => {
    // An 8-URL overflow, or a URL the server refused: the row is simply absent.
    await renderWith([]);
    expect(container.querySelector('[data-testid="link-preview-state"]')?.textContent)
      .toBe('example.com · preview unavailable');
  });

  it('renders no <img> when there is no image, and never a remote src', async () => {
    await renderWith([preview()]);
    expect(container.querySelector('img')).toBeNull();
    // The remote image URL is not even sent to the browser (see publicLinkPreview),
    // but assert on the DOM too: no card may reference a third-party host.
    expect(container.innerHTML).not.toContain('http://');
    expect(container.querySelectorAll('a').length).toBe(1);
  });

  it('caps the cards at two even when the message links five things', async () => {
    const urls = [
      'https://a.example.com/1',
      'https://b.example.com/2',
      'https://c.example.com/3',
      'https://d.example.com/4',
      'https://e.example.com/5',
    ];
    const fetchMock = await renderWith(
      urls.slice(0, 2).map(url => preview({ url, title: `Title for ${url}` })),
      `look: ${urls.join(' ')}`,
    );
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).urls)
      .toEqual(urls.slice(0, 2));
    expect(container.querySelectorAll('[data-testid="link-preview-card"]').length).toBe(2);
  });

  it('two messages linking the same page share one request', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { previews: [preview()] }, error: null }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(createElement('div', null, [
        createElement(LinkPreviewCards, { content: MESSAGE, key: 'a' }),
        createElement(LinkPreviewCards, { content: `also ${URL_IN_MESSAGE}`, key: 'b' }),
      ]));
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 120));
    });
    // One fetch, two cards. This is the whole reason the store is module-level.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('[data-testid="link-preview-card"]').length).toBe(2);
  });
});
