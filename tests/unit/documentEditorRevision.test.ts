import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocWindowContent } from '../../src/components/windows/DocWindowContent';
import { AppletDocWindowContent } from '../../src/components/windows/AppletDocWindowContent';
import type { Document } from '../../src/types';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../src/hooks/useDocumentVersions', () => ({
  useDocumentVersions: () => ({ createSnapshot: vi.fn() }),
}));
vi.mock('../../src/components/editor/DocumentCommentsPanel', () => ({ DocumentCommentsPanel: () => null }));
vi.mock('../../src/components/editor/DocumentVersionHistoryPanel', () => ({ DocumentVersionHistoryPanel: () => null }));
vi.mock('../../src/hooks/usePaneSplit', () => ({
  usePaneSplit: () => ({
    size: 400,
    containerSize: 1000,
    dragging: false,
    containerRef: () => {},
    dividerProps: { type: 'button', 'aria-label': 'Resize', title: 'Resize' },
  }),
}));
vi.mock('../../src/components/windows/AppletCodeEditor', () => ({
  default: ({ value, onChange, ariaLabel }: { value: string; onChange: (value: string) => void; ariaLabel: string }) => createElement('textarea', {
    value,
    onChange: (event: Event) => onChange((event.target as HTMLTextAreaElement).value),
    'aria-label': ariaLabel,
  }),
}));

const baseDocument: Document = {
  id: 'doc-1',
  workspace_id: 'workspace-1',
  title: 'Runbook',
  content: '<p>old body</p>',
  is_favorite: false,
  version: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

let root: Root;
let container: HTMLDivElement;
let fetchDocumentContent: ReturnType<typeof vi.fn>;
let onAutoSave: ReturnType<typeof vi.fn>;

const appletDocument: Document = {
  ...baseDocument,
  folder: 'Applets',
  content: '<!doctype html><style>old</style><script>old()</script>',
};

function renderDocument(document: Document) {
  return createElement(DocWindowContent, {
    document,
    onAutoSave,
    onToggleFavorite: vi.fn(),
    onDelete: vi.fn(),
    onTitleChange: vi.fn(),
    fetchDocumentContent,
  });
}

function renderApplet(document: Document) {
  return createElement(AppletDocWindowContent, {
    document,
    onAutoSave,
    onToggleFavorite: vi.fn(),
    onDelete: vi.fn(),
    onTitleChange: vi.fn(),
    fetchDocumentContent,
  });
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchDocumentContent = vi.fn().mockResolvedValue('<p>remote body</p>');
  onAutoSave = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('open document revision refresh', () => {
  it('refreshes a clean editor when a metadata-only remote revision arrives', async () => {
    await act(async () => {
      root.render(renderDocument(baseDocument));
      await flush();
    });
    const editor = container.querySelector<HTMLElement>('[contenteditable="true"]');
    expect(editor?.innerHTML).toContain('old body');

    fetchDocumentContent.mockResolvedValue('<p>remote body</p>');
    await act(async () => {
      root.render(renderDocument({
        ...baseDocument,
        content: undefined,
        version: 2,
        updated_at: '2026-01-01T00:01:00.000Z',
      }));
      await flush();
    });

    expect(fetchDocumentContent).toHaveBeenLastCalledWith('doc-1', true);
    expect(editor?.innerHTML).toContain('remote body');
  });

  it('keeps local edits and lets their pending save complete across a remote revision', async () => {
    await act(async () => {
      root.render(renderDocument(baseDocument));
      await flush();
    });
    const editor = container.querySelector<HTMLElement>('[contenteditable="true"]');
    expect(editor).not.toBeNull();
    editor!.innerHTML = '<p>local body</p>';
    await act(async () => {
      editor!.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      await flush();
    });
    expect(onAutoSave).toHaveBeenCalledWith('doc-1', expect.objectContaining({ content: '<p>local body</p>' }));

    fetchDocumentContent.mockResolvedValue('<p>someone else body</p>');
    await act(async () => {
      root.render(renderDocument({
        ...baseDocument,
        content: undefined,
        version: 2,
        updated_at: '2026-01-01T00:01:00.000Z',
      }));
      await flush();
    });

    expect(editor!.innerHTML).toContain('local body');
    await act(async () => {
      vi.advanceTimersByTime(800);
      await flush();
    });
    expect(onAutoSave).toHaveBeenCalledWith('doc-1', expect.objectContaining({ content: '<p>local body</p>' }));
  });

  it('hands the final rich edit to the document queue before the editor closes', async () => {
    await act(async () => {
      root.render(renderDocument(baseDocument));
      await flush();
    });
    const editor = container.querySelector<HTMLElement>('[contenteditable="true"]');
    editor!.innerHTML = '<p>saved before close</p>';
    await act(async () => {
      editor!.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      await flush();
    });
    expect(onAutoSave).toHaveBeenCalledTimes(1);
    await act(async () => { root.unmount(); });
    vi.advanceTimersByTime(800);
    expect(onAutoSave).toHaveBeenCalledTimes(1);
  });

  it('recognizes its own remote revision without resetting the edited DOM', async () => {
    await act(async () => {
      root.render(renderDocument(baseDocument));
      await flush();
    });
    const editor = container.querySelector<HTMLElement>('[contenteditable="true"]');
    editor!.innerHTML = '<p>local body</p>';
    await act(async () => {
      editor!.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      await flush();
    });
    const editorBeforeAck = container.querySelector('[contenteditable="true"]');

    fetchDocumentContent.mockResolvedValue('<p>local body</p>');
    await act(async () => {
      root.render(renderDocument({
        ...baseDocument,
        content: undefined,
        version: 2,
        updated_at: '2026-01-01T00:01:00.000Z',
      }));
      await flush();
    });

    expect(container.querySelector('[contenteditable="true"]')).toBe(editorBeforeAck);
    expect(editor!.innerHTML).toBe('<p>local body</p>');
  });

  it('keeps applet source mounted while a remote revision is fetched', async () => {
    await act(async () => {
      root.render(renderApplet(appletDocument));
      await flush();
    });
    const editButton = container.querySelector<HTMLButtonElement>('button[title="Edit code"]');
    expect(editButton).not.toBeNull();
    await act(async () => {
      editButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });
    const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label]');
    expect(editor).not.toBeNull();

    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    valueSetter.call(editor, 'local applet source');
    await act(async () => {
      editor!.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    });
    expect(onAutoSave).toHaveBeenCalledWith('doc-1', expect.objectContaining({ content: 'local applet source' }));
    const editorBeforeRevision = container.querySelector('textarea[aria-label]');

    fetchDocumentContent.mockResolvedValue('remote applet source');
    await act(async () => {
      root.render(renderApplet({
        ...appletDocument,
        content: undefined,
        version: 2,
        updated_at: '2026-01-01T00:01:00.000Z',
      }));
      await flush();
    });

    expect(fetchDocumentContent).toHaveBeenLastCalledWith('doc-1', true);
    expect(container.querySelector('textarea[aria-label]')).toBe(editorBeforeRevision);
    expect(editor!.value).toBe('local applet source');
  });
});

it('keeps a document read-only until its body loads and offers retry on failure', async () => {
  let reject!: (reason: Error) => void;
  fetchDocumentContent.mockReturnValueOnce(new Promise((_resolve, rejectRead) => { reject = rejectRead; }));
  await act(async () => { root.render(renderDocument({ ...baseDocument, content: undefined })); await flush(); });
  expect(container.querySelector('.doc-editor')?.getAttribute('contenteditable')).toBe('false');
  expect((container.querySelector('.doc-title-input') as HTMLInputElement).disabled).toBe(true);
  expect(container.textContent).toContain('Loading document');
  await act(async () => { reject(new Error('unavailable')); await flush(); });
  expect(container.textContent).toContain('Editing is paused');
  expect(onAutoSave).not.toHaveBeenCalled();
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry')?.click(); await flush(); });
  expect(container.querySelector('.doc-editor')?.innerHTML).toBe('<p>remote body</p>');
  expect(container.querySelector('.doc-editor')?.getAttribute('contenteditable')).toBe('true');
});

it('keeps applet title/source unavailable after a failed load until retry succeeds', async () => {
  fetchDocumentContent.mockRejectedValueOnce(new Error('unavailable'));
  await act(async () => { root.render(renderApplet({ ...appletDocument, content: undefined })); await flush(); });
  expect(container.textContent).toContain('Applet source could not be loaded');
  expect((container.querySelector('.doc-title-input') as HTMLInputElement).disabled).toBe(true);
  expect(onAutoSave).not.toHaveBeenCalled();
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry')?.click(); await flush(); });
  expect(container.textContent).not.toContain('Editing is paused');
  expect((container.querySelector('.doc-title-input') as HTMLInputElement).disabled).toBe(false);
});

it('preserves a loaded document body when refreshing its revision fails', async () => {
  await act(async () => { root.render(renderDocument(baseDocument)); await flush(); });
  fetchDocumentContent.mockRejectedValueOnce(new Error('unavailable'));
  await act(async () => { root.render(renderDocument({ ...baseDocument, content: undefined, version: 2 })); await flush(); });
  expect(container.querySelector('.doc-editor')?.innerHTML).toBe('<p>old body</p>');
  expect(container.querySelector('.doc-editor')?.getAttribute('contenteditable')).toBe('false');
  expect(container.textContent).toContain('Editing is paused');
});
