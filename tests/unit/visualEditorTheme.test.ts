import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInThisContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PREFS_KEY = 'visual-dev-editor:prefs';
const clientSource = readFileSync(resolve(process.cwd(), 'visual-editor/src/client.js'), 'utf8');

type VisualEditorApi = {
  disable: () => void;
  select: (element: Element) => void;
};

const editorWindow = window as typeof window & {
  __visualEditor?: VisualEditorApi;
};

function mountEditor() {
  document.body.innerHTML = '<main id="page"><h1>Theme test</h1><p>Host content</p></main>';
  const fetchMock = vi.fn(() => Promise.resolve({
    json: () => Promise.resolve({ ok: true, libraries: [], components: [] }),
  }));
  vi.stubGlobal('fetch', fetchMock);

  runInThisContext(clientSource, { filename: 'visual-editor/src/client.js' });

  const host = document.getElementById('__visual-editor-host') as HTMLElement | null;
  expect(host, 'the real visual-editor client should mount').not.toBeNull();
  expect(host?.shadowRoot, 'the editor UI should remain isolated in its shadow root').not.toBeNull();
  return {
    host: host as HTMLElement,
    shadow: host?.shadowRoot as ShadowRoot,
    fetchMock,
  };
}

beforeEach(() => {
  editorWindow.__visualEditor?.disable();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  localStorage.clear();
});

afterEach(() => {
  editorWindow.__visualEditor?.disable();
  document.documentElement.removeAttribute('style');
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('visual editor theme', () => {
  it('keeps dark as the compatible default and exposes a labelled light-mode control', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      leftW: 340,
      rightW: 360,
      livePreview: false,
    }));

    const { host, shadow } = mountEditor();
    const themeButton = shadow.querySelector<HTMLButtonElement>(
      'button[aria-label="Light editor theme"]',
    );

    expect(host.dataset.theme).toBe('dark');
    expect(host.style.getPropertyValue('--leftw')).toBe('340px');
    expect(host.style.getPropertyValue('--rightw')).toBe('360px');
    expect(themeButton?.getAttribute('aria-pressed')).toBe('false');
    expect(themeButton?.textContent).toContain('Light');

    const style = shadow.querySelector('style')?.textContent ?? '';
    expect(style).toContain(':host([data-theme="light"])');
    expect(style).toContain('color-scheme: light');
    expect(style).toContain('--range-track: #d7dce4');
    expect(style).toContain('--chip-remove: #087f5b');
    expect(style).toContain('--overlay-bg: #ffffff');
    expect(style).toContain('background: var(--hover)');

    themeButton?.click();
    expect(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')).toMatchObject({
      leftW: 340,
      rightW: 360,
      livePreview: false,
      theme: 'light',
    });
  });

  it('switches immediately, preserves the page, and persists across a remount', () => {
    const first = mountEditor();
    editorWindow.__visualEditor?.select(document.querySelector('h1') as HTMLElement);
    first.shadow.querySelector<HTMLButtonElement>(
      'button[title="Insert an element or component"]',
    )?.click();

    const pageBefore = document.getElementById('page')?.outerHTML;
    const inspectorBefore = first.shadow.querySelector('#props')?.textContent;
    const themeButton = first.shadow.querySelector<HTMLButtonElement>(
      'button[aria-label="Light editor theme"]',
    );
    const fetchesBeforeToggle = first.fetchMock.mock.calls.length;

    themeButton?.click();

    expect(first.host.dataset.theme).toBe('light');
    expect(themeButton?.getAttribute('aria-label')).toBe('Light editor theme');
    expect(themeButton?.getAttribute('title')).toBe('Switch editor to dark mode');
    expect(themeButton?.getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById('page')?.outerHTML).toBe(pageBefore);
    expect(inspectorBefore).toContain('LAYOUT');
    expect(first.shadow.querySelector('#props')?.textContent).toBe(inspectorBefore);
    expect(first.shadow.querySelector('#palette')?.classList.contains('show')).toBe(true);
    expect(first.fetchMock).toHaveBeenCalledTimes(fetchesBeforeToggle);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')).toMatchObject({
      theme: 'light',
      livePreview: true,
    });

    editorWindow.__visualEditor?.disable();
    const second = mountEditor();
    expect(second.host.dataset.theme).toBe('light');
    expect(
      second.shadow.querySelector('button[aria-label="Light editor theme"][aria-pressed="true"]'),
    ).not.toBeNull();

    const secondThemeButton = second.shadow.querySelector<HTMLButtonElement>(
      'button[aria-label="Light editor theme"]',
    );
    secondThemeButton?.click();
    expect(second.host.dataset.theme).toBe('dark');
    expect(secondThemeButton?.getAttribute('title')).toBe('Switch editor to light mode');
    expect(secondThemeButton?.getAttribute('aria-pressed')).toBe('false');
    expect(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}').theme).toBe('dark');
  });

  it.each([
    ['an unknown theme', JSON.stringify({ theme: 'sepia' })],
    ['malformed JSON', '{not-json'],
  ])('recovers from %s without breaking the editor', (_label, stored) => {
    localStorage.setItem(PREFS_KEY, stored);
    const { host } = mountEditor();

    expect(host.dataset.theme).toBe('dark');
    expect(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}').theme).toBe('dark');
  });

  it('still switches in memory when browser storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });

    const { host, shadow } = mountEditor();
    shadow.querySelector<HTMLButtonElement>(
      'button[aria-label="Light editor theme"]',
    )?.click();

    expect(host.dataset.theme).toBe('light');
  });
});
