import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileDetailPanel, UploadedFileRow } from '../../src/components/files/FilePanelItems';
import {
  formatUploadedDate,
  normalizeUploadedFile,
  splitFileNameForDisplay,
} from '../../src/lib/uploadedFiles';
import { formatBytes } from '../../src/components/chat/ComposerAddContent';
import type { UploadedFile } from '../../src/types';

vi.mock('../../src/lib/backendClient', () => ({
  apiUrl: (path: string) => `https://backend.test${path}`,
  apiAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
}));

// Four things about the Files panel that only a mount can settle. Every one of
// them shipped broken.
//
//   1. SIZE SURVIVES FROM ROW TO PIXEL. `uploaded_files.size` is a Postgres
//      BIGINT and neither backend's driver parses int8, so the value arrives as
//      the STRING "3314900" in a field typed `number`. formatBytes tested it
//      with Number.isFinite — false for a string — and every file in a 113-row
//      workspace rendered "0 B". The fixture below is the row SHAPE THE DRIVER
//      ACTUALLY RETURNS, on purpose: a fixture that pre-coerces to a number
//      cannot fail, which is why nothing caught this.
//   2. NOTHING IS INVENTED ABOUT THE FILE. The detail pane used to render five
//      colour swatches derived from a hash of the file NAME under the heading
//      "Palette", and three lines of generated verse built from the same string.
//      Neither had read a byte of the file. Asserted absent by content, not by
//      reading the source.
//   3. AN IMAGE SHOWS THE IMAGE, through the authenticated route into a blob:
//      URL. There is no public URL for file bytes.
//   4. THE TAIL OF THE NAME SURVIVES TRUNCATION. These files are
//      `Screenshot 2026-07-27 at 10.16.32.png`; the characters that tell two of
//      them apart are the last dozen, so a trailing ellipsis renders a list of
//      identical rows.

const REAL_SIZE_FROM_DRIVER = '3314900';
const SCREENSHOT_NAME = 'Screenshot 2026-07-27 at 10.16.32.png';

/** A row exactly as postgres.js / the Neon lane hand it to the browser. */
function driverRow(over: Partial<UploadedFile> = {}): UploadedFile {
  return {
    id: 'file-1',
    workspace_id: 'ws-1',
    name: SCREENSHOT_NAME,
    // Deliberately a string. See note 1 above.
    size: REAL_SIZE_FROM_DRIVER as unknown as number,
    type: 'image/png',
    storage_path: 'ws-1/file-1/shot.png',
    version: 1,
    created_at: '2026-07-27T10:16:32.000Z',
    ...over,
  };
}

let root: Root | null = null;
let host: HTMLDivElement;
let objectUrlSeq = 0;
let fetchOk = true;

async function mountRow(file: UploadedFile) {
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(UploadedFileRow, { file, onOpen: () => {} }));
  });
}

async function mountDetail(file: UploadedFile) {
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(FileDetailPanel, {
      selectedFile: { kind: 'uploaded', file },
      agents: [],
      onOpenUploaded: async () => {},
      onCreateTask: undefined,
      onTaskCreated: () => {},
    }));
  });
}

beforeEach(() => {
  objectUrlSeq = 0;
  fetchOk = true;
  host = document.createElement('div');
  document.body.appendChild(host);

  vi.stubGlobal('fetch', vi.fn(async () => (fetchOk
    ? { ok: true, status: 200, blob: async () => new Blob(['bytes']) } as unknown as Response
    : { ok: false, status: 404, blob: async () => new Blob() } as unknown as Response)));

  URL.createObjectURL = vi.fn(() => `blob:mock/${++objectUrlSeq}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host.remove();
  vi.unstubAllGlobals();
});

describe('uploaded file size, row to rendered output', () => {
  it('formats the bigint STRING the driver returns, not "0 B"', () => {
    // The exact regression: the value is a string at runtime whatever the type says.
    expect(formatBytes(REAL_SIZE_FROM_DRIVER as unknown as number)).toBe('3.2 MB');
    expect(formatBytes(3314900)).toBe('3.2 MB');
  });

  it('normalizes a driver row so the declared `number` type is true', () => {
    const row = normalizeUploadedFile(driverRow());
    expect(typeof row.size).toBe('number');
    expect(row.size).toBe(3314900);
    expect(Number.isFinite(row.size)).toBe(true);
  });

  it('renders the real size in a list row fed the raw driver shape', async () => {
    await mountRow(driverRow());
    expect(host.textContent).toContain('3.2 MB');
    expect(host.textContent).not.toContain('0 B');
  });

  it('renders the real size in a list row fed the normalized shape', async () => {
    await mountRow(normalizeUploadedFile(driverRow()));
    expect(host.textContent).toContain('3.2 MB');
    expect(host.textContent).not.toContain('0 B');
  });

  it('renders the real size in the detail pane', async () => {
    await mountDetail(driverRow());
    expect(host.textContent).toContain('3.2 MB');
    expect(host.textContent).not.toContain('0 B');
  });

  it('still says 0 B for a genuinely empty file', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes('0' as unknown as number)).toBe('0 B');
    expect(formatBytes(null as unknown as number)).toBe('0 B');
  });
});

describe('the detail pane invents nothing', () => {
  it('has no hash-derived palette and no generated verse', async () => {
    await mountDetail(driverRow());
    const text = host.textContent || '';

    expect(text).not.toContain('Palette');
    expect(text).not.toContain('waits in place');
    expect(text).not.toContain('marks the path');
    expect(text).not.toContain('Hands reshape the file');

    // The swatches were inline `background: hsl(...)` spans seeded from a hash
    // of the file name. Nothing in the pane may colour itself from the name.
    const styled = Array.from(host.querySelectorAll('[style]'))
      .map(node => node.getAttribute('style') || '')
      .join(' ');
    expect(styled).not.toContain('hsl(');
  });

  it('shows real metadata that came off the row', async () => {
    await mountDetail(driverRow());
    const text = host.textContent || '';
    expect(text).toContain('image/png');
    expect(text).toContain(formatUploadedDate('2026-07-27T10:16:32.000Z'));
  });

  it('shows the image itself, through the authenticated route', async () => {
    await mountDetail(driverRow());
    const img = host.querySelector('img');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toMatch(/^blob:/);
    expect(img!.getAttribute('src')).not.toContain('/backend/files/');
  });

  it('says "No preview available" for a file it cannot render, rather than a stand-in', async () => {
    await mountDetail(driverRow({ name: 'notes.pdf', type: 'application/pdf' }));
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('No preview available');
  });

  it('says the file is unavailable when its bytes are gone', async () => {
    fetchOk = false;
    await mountDetail(driverRow());
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('File unavailable');
  });

  it('does not carry one file\'s dimensions onto the next', async () => {
    // Measured from the previous <img> and never cleared, "160 x 100" would sit
    // on a PDF — a fabricated fact about a file, arrived at by leaking state
    // rather than by generating text, but read by a user the same way.
    await mountDetail(driverRow());
    await act(async () => {
      const img = host.querySelector('img')!;
      Object.defineProperty(img, 'naturalWidth', { value: 1920, configurable: true });
      Object.defineProperty(img, 'naturalHeight', { value: 1080, configurable: true });
      img.dispatchEvent(new Event('load'));
    });
    expect(host.textContent).toContain('1920 x 1080');

    await act(async () => {
      root!.render(createElement(FileDetailPanel, {
        selectedFile: { kind: 'uploaded', file: driverRow({ id: 'file-2', name: 'notes.pdf', type: 'application/pdf' }) },
        agents: [],
        onOpenUploaded: async () => {},
        onCreateTask: undefined,
        onTaskCreated: () => {},
      }));
    });
    expect(host.textContent).not.toContain('1920 x 1080');
    expect(host.textContent).not.toContain('Dimensions');
    expect(host.textContent).toContain('No preview available');
  });
});

describe('file names truncate in the middle', () => {
  it('keeps the end of a screenshot name, which is the part that differs', () => {
    const { head, tail } = splitFileNameForDisplay(SCREENSHOT_NAME);
    expect(head + tail).toBe(SCREENSHOT_NAME);
    expect(tail).toBe('10.16.32.png');
    expect(SCREENSHOT_NAME.endsWith(tail)).toBe(true);
  });

  it('leaves a short name whole', () => {
    expect(splitFileNameForDisplay('logo.png')).toEqual({ head: 'logo.png', tail: '' });
  });

  it('renders the distinguishing tail in a row, and the full name as its title', async () => {
    await mountRow(driverRow());
    const button = host.querySelector('button');
    expect(button!.getAttribute('title')).toBe(SCREENSHOT_NAME);
    // Two adjacent boxes: only the head one may ellipsise.
    expect(host.textContent).toContain('10.16.32.png');
  });
});
