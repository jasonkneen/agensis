import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInThisContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clientSource = readFileSync(resolve(process.cwd(), 'visual-editor/src/client.js'), 'utf8');

type VisualEditorApi = {
  disable: () => void;
  select: (element: Element) => void;
};

const editorWindow = window as typeof window & {
  __visualEditor?: VisualEditorApi;
};

function mountEditor(
  html: string,
  discovery: Record<string, unknown> = { libraries: [], components: [] },
  responseForCall?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>,
) {
  document.body.innerHTML = html;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = responseForCall
      ? await responseForCall(input, init)
      : { ok: true, ...discovery };
    return { json: () => Promise.resolve(response) };
  });
  vi.stubGlobal('fetch', fetchMock);
  runInThisContext(clientSource, { filename: 'visual-editor/src/client.js' });

  const host = document.getElementById('__visual-editor-host') as HTMLElement | null;
  expect(host?.shadowRoot).not.toBeNull();
  return {
    host: host as HTMLElement,
    shadow: host?.shadowRoot as ShadowRoot,
    fetchMock,
  };
}

function box(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
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
  Reflect.deleteProperty(document, 'elementFromPoint');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('visual editor canvas interactions', () => {
  it('offers independently discovered content pages as editor targets', async () => {
    const { shadow } = mountEditor('<main><h1>Home</h1></main>', {
      libraries: [],
      components: [],
      pages: [
        { path: 'index.html', title: 'Home' },
        { path: 'work.html', title: 'Work' },
        { path: 'about.html', title: 'About' },
      ],
    });

    await vi.waitFor(() => {
      expect(shadow.querySelector<HTMLSelectElement>('#page-select')?.options).toHaveLength(3);
    });
    const pageSelect = shadow.querySelector<HTMLSelectElement>('#page-select');

    expect(pageSelect?.style.display).not.toBe('none');
    expect(pageSelect?.value).toBe('/index.html');
    expect([...pageSelect?.options ?? []].map(option => option.textContent)).toEqual([
      'Home',
      'Work',
      'About',
    ]);
  });

  it('hides the target selector when the host exposes only one page', async () => {
    const { shadow } = mountEditor('<main><h1>Only page</h1></main>', {
      libraries: [],
      components: [],
      pages: [{ path: 'index.html', title: 'Only page' }],
    });

    await vi.waitFor(() => {
      expect(shadow.querySelector<HTMLSelectElement>('#page-select')?.style.display).toBe('none');
    });
  });

  it('waits for an inline save before navigating to a configured application target', async () => {
    let finishSave: ((response: Record<string, unknown>) => void) | undefined;
    let navigatedTo = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      navigatedTo = this.getAttribute('href') ?? '';
    });
    const discovery = {
      libraries: [],
      components: [],
      pages: [
        { title: 'Home', href: '/index.html', file: 'content/home.html' },
        { title: 'Work route', href: '/work/alpha%20beta?view=grid', file: 'src/routes/work.tsx' },
      ],
    };
    const { shadow, fetchMock } = mountEditor(
      '<main><h1 id="title">Original title</h1></main>',
      discovery,
      (_input, init) => {
        if (init?.method !== 'POST') return { ok: true, ...discovery };
        return new Promise(resolveResponse => { finishSave = resolveResponse; });
      },
    );
    await vi.waitFor(() => {
      expect(shadow.querySelector<HTMLSelectElement>('#page-select')?.options).toHaveLength(2);
    });
    const title = document.getElementById('title') as HTMLElement;
    const pageSelect = shadow.querySelector<HTMLSelectElement>('#page-select') as HTMLSelectElement;

    title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    title.textContent = 'Saved before leaving';
    title.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    pageSelect.value = '/work/alpha%20beta?view=grid';
    pageSelect.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true);
    });
    const editCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(editCall?.[1]?.body))).toMatchObject({
      file: 'content/home.html',
      op: 'setText',
      text: 'Saved before leaving',
    });
    expect(pageSelect.disabled).toBe(true);
    expect(navigatedTo).toBe('');

    finishSave?.({ ok: true });
    await vi.waitFor(() => {
      expect(navigatedTo).toBe('/work/alpha%20beta?view=grid');
    });
  });

  it('keeps live drag reflow inside the target neighbourhood and draws local alignment guides', async () => {
    const { shadow } = mountEditor(`
      <main id="page">
        <section id="source"><p id="moving">Move me</p></section>
        <section id="target" style="display:flex"><div id="reference">Reference</div></section>
        <footer id="far-away">Far away</footer>
      </main>
    `);
    const moving = document.getElementById('moving') as HTMLElement;
    const target = document.getElementById('target') as HTMLElement;
    const reference = document.getElementById('reference') as HTMLElement;
    const originalTargetStyle = target.getAttribute('style');

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.hasAttribute('data-ve-preview-placeholder')) return box(400, 100, 100, 40);
      if (this.id === 'moving') return box(100, 100, 100, 40);
      if (this.id === 'target') return box(380, 80, 240, 160);
      if (this.id === 'reference') return box(400, 100, 100, 40);
      if (this.id === 'source') return box(80, 80, 240, 160);
      if (this.id === 'page') return box(40, 40, 700, 500);
      return box(0, 0, 20, 20);
    });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => reference),
    });

    editorWindow.__visualEditor?.select(moving);
    moving.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 110,
      clientY: 110,
    }));
    document.dispatchEvent(new MouseEvent('pointermove', {
      bubbles: true,
      clientX: 410,
      clientY: 110,
    }));
    await new Promise(resolveFrame => window.requestAnimationFrame(() => resolveFrame(undefined)));

    const placeholder = target.querySelector<HTMLElement>('[data-ve-preview-placeholder]');
    const guides = [...shadow.querySelectorAll<HTMLElement>('.ov-guide')];

    expect(placeholder).not.toBeNull();
    expect(moving.parentElement?.id).toBe('source');
    expect(moving.style.getPropertyValue('visibility')).toBe('hidden');
    expect(target.hasAttribute('data-ve-preview-isolated')).toBe(true);
    expect(target.style.width).toBe('240px');
    expect(target.style.height).toBe('160px');
    expect(document.body.hasAttribute('data-ve-preview-isolated')).toBe(false);
    expect(document.getElementById('far-away')?.getAttribute('style')).toBeNull();
    expect(guides.some(guide => guide.dataset.axis === 'vertical')).toBe(true);
    expect(guides.some(guide => guide.dataset.axis === 'horizontal')).toBe(true);
    expect(guides.some(guide => guide.classList.contains('center'))).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));

    expect(document.querySelector('[data-ve-preview-placeholder]')).toBeNull();
    expect(shadow.querySelector('.ov-guide')).toBeNull();
    expect(moving.style.getPropertyValue('visibility')).toBe('');
    expect(target.getAttribute('style')).toBe(originalTargetStyle);
  });

  it('collapses the old slot only when reordering inside the isolated target container', async () => {
    const { fetchMock } = mountEditor(`
      <main>
        <section id="flow" style="display:flex">
          <article id="moving">Move me</article>
          <article id="reference">Reference</article>
        </section>
        <footer id="far-away">Far away</footer>
      </main>
    `);
    const flow = document.getElementById('flow') as HTMLElement;
    const moving = document.getElementById('moving') as HTMLElement;
    const reference = document.getElementById('reference') as HTMLElement;
    const originalFlowStyle = flow.getAttribute('style');

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.hasAttribute('data-ve-preview-placeholder')) return box(400, 100, 100, 40);
      if (this.id === 'moving') return box(100, 100, 100, 40);
      if (this.id === 'reference') return box(400, 100, 100, 40);
      if (this.id === 'flow') return box(80, 80, 520, 120);
      return box(0, 0, 20, 20);
    });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => reference),
    });

    editorWindow.__visualEditor?.select(moving);
    moving.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 110,
      clientY: 110,
    }));
    document.dispatchEvent(new MouseEvent('pointermove', {
      bubbles: true,
      clientX: 490,
      clientY: 110,
    }));
    await new Promise(resolveFrame => window.requestAnimationFrame(() => resolveFrame(undefined)));

    expect(flow.hasAttribute('data-ve-preview-isolated')).toBe(true);
    expect(moving.style.getPropertyValue('display')).toBe('none');
    expect(moving.style.getPropertyValue('visibility')).toBe('');
    expect(document.getElementById('far-away')?.getAttribute('style')).toBeNull();

    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true);
    });
    const editCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    const body = JSON.parse(String(editCall?.[1]?.body));

    expect(body).toMatchObject({ op: 'moveTo' });
    expect([...flow.children].map(child => child.id)).toEqual(['reference', 'moving']);
    expect(moving.getAttribute('style')).toBeNull();
    expect(flow.getAttribute('style')).toBe(originalFlowStyle);
    expect(document.querySelector('[data-ve-preview-placeholder]')).toBeNull();
  });

  it('restores the original DOM order when a committed drag save fails', async () => {
    const discovery = { libraries: [], components: [] };
    const { fetchMock } = mountEditor(
      '<main><section id="flow"><article id="moving">Move me</article><article id="reference">Reference</article></section></main>',
      discovery,
      (_input, init) => init?.method === 'POST'
        ? { ok: false, error: 'simulated save refusal' }
        : { ok: true, ...discovery },
    );
    const flow = document.getElementById('flow') as HTMLElement;
    const moving = document.getElementById('moving') as HTMLElement;
    const reference = document.getElementById('reference') as HTMLElement;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.hasAttribute('data-ve-preview-placeholder')) return box(400, 100, 100, 40);
      if (this.id === 'moving') return box(100, 100, 100, 40);
      if (this.id === 'reference') return box(400, 100, 100, 40);
      if (this.id === 'flow') return box(80, 80, 520, 120);
      return box(0, 0, 20, 20);
    });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => reference),
    });

    editorWindow.__visualEditor?.select(moving);
    moving.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 110,
      clientY: 110,
    }));
    document.dispatchEvent(new MouseEvent('pointermove', {
      bubbles: true,
      clientX: 490,
      clientY: 110,
    }));
    await new Promise(resolveFrame => window.requestAnimationFrame(() => resolveFrame(undefined)));
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true);
      expect([...flow.children].map(child => child.id)).toEqual(['moving', 'reference']);
    });
    expect(document.querySelector('[data-ve-preview-placeholder]')).toBeNull();
    expect(moving.getAttribute('style')).toBeNull();
  });

  it('keeps alignment guides available when live layout preview is turned off', async () => {
    const { shadow } = mountEditor(`
      <main>
        <section id="flow"><article id="moving">Move me</article><article id="reference">Reference</article></section>
      </main>
    `);
    const moving = document.getElementById('moving') as HTMLElement;
    const reference = document.getElementById('reference') as HTMLElement;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.hasAttribute('data-ve-guide-probe')) return box(400, 100, 100, 40);
      if (this.id === 'moving') return box(100, 100, 100, 40);
      if (this.id === 'reference') return box(400, 100, 100, 40);
      if (this.id === 'flow') return box(80, 80, 520, 120);
      return box(0, 0, 20, 20);
    });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => reference),
    });
    const liveButton = [...shadow.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.title.startsWith('Live layout preview'));
    liveButton?.click();

    editorWindow.__visualEditor?.select(moving);
    moving.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 110,
      clientY: 110,
    }));
    document.dispatchEvent(new MouseEvent('pointermove', {
      bubbles: true,
      clientX: 490,
      clientY: 110,
    }));
    await new Promise(resolveFrame => window.requestAnimationFrame(() => resolveFrame(undefined)));

    expect(document.querySelector('[data-ve-preview-placeholder]')).toBeNull();
    expect(shadow.querySelectorAll('.ov-guide').length).toBeGreaterThan(0);

    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(shadow.querySelector('.ov-guide')).toBeNull();
  });

  it('edits leaf text in place on double-click and commits one setText operation', async () => {
    const { fetchMock } = mountEditor(`
      <main><h1 id="title">Original title</h1><p id="nested">Text <strong>child</strong></p></main>
    `);
    const title = document.getElementById('title') as HTMLElement;

    title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    expect(title.hasAttribute('data-ve-inline-edit')).toBe(true);
    expect(title.getAttribute('contenteditable')).toBe('plaintext-only');
    expect(document.activeElement).toBe(title);

    title.textContent = 'Changed in place';
    title.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));

    await vi.waitFor(() => {
      const editCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(editCall).toBeDefined();
    });
    const editCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    const body = JSON.parse(String(editCall?.[1]?.body));

    expect(body).toMatchObject({ op: 'setText', text: 'Changed in place' });
    expect(title.textContent).toBe('Changed in place');
    expect(title.hasAttribute('data-ve-inline-edit')).toBe(false);
    expect(title.hasAttribute('contenteditable')).toBe(false);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);

    const nested = document.getElementById('nested') as HTMLElement;
    nested.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(nested.hasAttribute('data-ve-inline-edit')).toBe(false);
    expect(nested.querySelector('strong')?.textContent).toBe('child');
  });

  it('restores inline text on Escape without writing to source', () => {
    const { fetchMock } = mountEditor('<main><p id="copy">Keep this text</p></main>');
    const copy = document.getElementById('copy') as HTMLElement;

    copy.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    copy.textContent = 'Discard this text';
    copy.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));

    expect(copy.textContent).toBe('Keep this text');
    expect(copy.hasAttribute('data-ve-inline-edit')).toBe(false);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('requires Select mode before editing text inside an interactive control', () => {
    const { shadow, fetchMock } = mountEditor(
      '<main><a id="link" href="/leave">Editable label</a><p id="copy">Plain copy</p></main>',
    );
    const selectButton = [...shadow.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.title.startsWith('Toggle select mode'));
    selectButton?.click();
    const link = document.getElementById('link') as HTMLElement;
    const copy = document.getElementById('copy') as HTMLElement;

    link.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(link.hasAttribute('data-ve-inline-edit')).toBe(false);

    copy.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(copy.hasAttribute('data-ve-inline-edit')).toBe(true);
    copy.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('commits blur and plain-text paste while restoring the element attributes exactly', async () => {
    const { fetchMock } = mountEditor(
      '<main><p id="copy" contenteditable="true" spellcheck="false" tabindex="3" style="color: red">Keep</p></main>',
    );
    const copy = document.getElementById('copy') as HTMLElement;

    copy.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: (type: string) => type === 'text/plain' ? '<b>plain</b>' : '' },
    });
    copy.dispatchEvent(paste);
    copy.dispatchEvent(new FocusEvent('blur'));

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true);
    });
    const editCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(editCall?.[1]?.body))).toMatchObject({
      op: 'setText',
      text: '<b>plain</b>',
    });
    expect(copy.textContent).toBe('<b>plain</b>');
    expect(copy.innerHTML).toBe('&lt;b&gt;plain&lt;/b&gt;');
    expect(copy.getAttribute('contenteditable')).toBe('true');
    expect(copy.getAttribute('spellcheck')).toBe('false');
    expect(copy.getAttribute('tabindex')).toBe('3');
    expect(copy.getAttribute('style')).toBe('color: red');
  });
});
