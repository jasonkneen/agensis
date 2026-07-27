// Uploaded files — the pure half of the Files panel. No React, no
// backendClient, so every decision in here is testable without a DOM.
// See tests/unit/uploadedFiles.test.ts.
//
// Two things live here because of bugs that shipped:
//
//   1. `uploaded_files.size` is a Postgres BIGINT. Neither driver parses int8:
//      postgres.js's `number` type lists OIDs [21, 23, 26, 700, 701] and int8 is
//      20, so it is absent; the Neon/pg lane returns int8 as a string for the
//      same precision reason. The value therefore reaches the browser as the
//      STRING "3314900" while `UploadedFile.size` claims `number`. Anything that
//      tested it with `Number.isFinite` — which is false for a string — rendered
//      "0 B" for every file in the workspace, on both backends at once.
//      normalizeUploadedFile is the boundary that makes the declared type true,
//      and it is the only place that needs to know this.
//
//   2. These files are mostly `Screenshot 2026-07-27 at 10.16.32.png`. The
//      characters that tell two of them apart are at the END, so a trailing
//      ellipsis truncates away the only distinguishing part and a list of
//      screenshots becomes a list of identical rows. splitFileNameForDisplay
//      keeps the tail and truncates in the middle instead.

import type { UploadedFile } from '../types';
// Type-only: the Files panel shows uploaded rows and daemon-reported project
// files side by side, and both shapes are declared with the composer that first
// needed them. No runtime coupling.
import type { ProjectFileEntry, ProjectFileSource } from '../components/chat/ComposerAddContent';
import { isImageAttachment, safeAttachmentSize, safeAttachmentType } from './messageAttachments';

/** The two things the Files panel can have selected. */
export type SelectedPanelFile =
  | { kind: 'uploaded'; file: UploadedFile }
  | { kind: 'project'; file: ProjectFileEntry; source: ProjectFileSource };

export function panelFileName(selectedFile: SelectedPanelFile) {
  return selectedFile.kind === 'uploaded'
    ? selectedFile.file.name
    : selectedFile.file.name || selectedFile.file.path.split('/').pop() || selectedFile.file.path;
}

export function panelFilePath(selectedFile: SelectedPanelFile) {
  return selectedFile.kind === 'uploaded' ? selectedFile.file.name : selectedFile.file.path;
}

export function panelFileSourceLabel(selectedFile: SelectedPanelFile) {
  return selectedFile.kind === 'uploaded' ? 'Uploaded' : selectedFile.source.label;
}

/** Characters of the file name kept at the end when the row is too narrow. */
export const NAME_TAIL_CHARS = 12;

/** Shortest head worth showing before the middle ellipsis. */
const NAME_MIN_HEAD_CHARS = 6;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Make one `uploaded_files` row match its TypeScript type.
 *
 * `size` is coerced from the driver's bigint string; `type` is put through the
 * same normaliser message attachments use, so an unexpected MIME can only ever
 * route a file to the icon renderer, never to an <img>.
 */
export function normalizeUploadedFile(row: UploadedFile): UploadedFile {
  return {
    ...row,
    size: safeAttachmentSize(row?.size),
    type: safeAttachmentType(row?.type),
  };
}

export function normalizeUploadedFiles(rows: UploadedFile[] | null | undefined): UploadedFile[] {
  if (!Array.isArray(rows)) return [];
  return rows.map(normalizeUploadedFile);
}

/**
 * True when this file's bytes can be shown inside an <img>. Deliberately the
 * SAME closed allowlist message attachments use (SVG is an image by prefix and a
 * scriptable document in fact, so it is not on it) rather than a second
 * `type.startsWith('image/')` test that would drift from it.
 */
export function isPreviewableImageFile(file: { type?: string | null } | null | undefined): boolean {
  return isImageAttachment(file);
}

/**
 * Split a file name so a row can truncate in the MIDDLE: render `head` in an
 * ellipsising box and `tail` in one that never shrinks.
 *
 * The tail is capped at half the name so a short name is not turned into
 * mostly-tail, and it is dropped entirely when what is left of the head would be
 * too short to read.
 */
export function splitFileNameForDisplay(name: string, tailChars: number = NAME_TAIL_CHARS): { head: string; tail: string } {
  const value = typeof name === 'string' ? name : '';
  const budget = Math.min(Math.max(0, Math.floor(tailChars)), Math.floor(value.length / 2));
  if (budget <= 0 || value.length - budget < NAME_MIN_HEAD_CHARS) return { head: value, tail: '' };
  return { head: value.slice(0, value.length - budget), tail: value.slice(value.length - budget) };
}

/** `27 Jul 2026`. Empty string when the timestamp is missing or unparseable. */
export function formatUploadedDate(value: string | null | undefined): string {
  const date = toDate(value);
  if (!date) return '';
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** `27 Jul 2026, 10:16`. Empty string when the timestamp is missing. */
export function formatUploadedDateTime(value: string | null | undefined): string {
  const date = toDate(value);
  if (!date) return '';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${formatUploadedDate(value)}, ${hours}:${minutes}`;
}

/** `1920 x 1080`. Empty string unless both dimensions are real. */
export function formatDimensions(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '';
  return `${Math.round(width)} x ${Math.round(height)}`;
}

/** A short, honest label for the file's kind. Never invented from the name. */
export function describeFileType(type: string | null | undefined): string {
  const normalized = safeAttachmentType(type);
  if (!normalized) return 'Unknown type';
  return normalized;
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
