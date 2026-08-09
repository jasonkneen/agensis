// ---------------------------------------------------------------------------
// LINE DIFF — what changed between two versions of a document.
//
// The library shows one document that several agents each hold a copy of, and
// the question that follows immediately is "how does this one differ from the
// latest?". Answering it needs a diff, and this repo has no diff dependency —
// so this is a small, honest one rather than a reason to add 300 KB to the
// bundle for a panel most people open occasionally.
//
// ALGORITHM: classic LCS over LINES, with the two cheap guards that make it
// usable on real documents. Lines rather than characters because these are
// markdown files, and a character diff of two prose paragraphs produces
// something nobody can read. Common prefix and suffix are trimmed first, which
// is what turns "a 900-line file with one edited line" from a 810,000-cell
// table into a 2-cell one.
//
// THE CAP IS PART OF THE CONTRACT. Above DIFF_MAX_CELLS the LCS is abandoned
// and the result says so (`truncated: true`) instead of quietly rendering a
// whole-file replacement as if it were the real answer. A diff view that lies
// about two large files being entirely different is worse than one that says
// it did not try.
//
// PURE. Unit-tested in tests/unit/textDiff.test.ts.
// ---------------------------------------------------------------------------

export type DiffOp = 'equal' | 'added' | 'removed';

export interface DiffLine {
  op: DiffOp;
  /** 1-based line number in the LEFT document, or null for an added line. */
  leftNumber: number | null;
  /** 1-based line number in the RIGHT document, or null for a removed line. */
  rightNumber: number | null;
  text: string;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** True when the two inputs are identical, including whitespace. */
  identical: boolean;
  /**
   * The LCS was too large to compute, so `lines` is a whole-file replacement
   * rather than a real diff. The UI must say so — see the header.
   */
  truncated: boolean;
}

/**
 * Cells in the LCS table before we give up.
 *
 * ~4M is a fraction of a second in a browser and covers every markdown document
 * a person will realistically compare (two 2000-line files). Beyond it, the
 * cost stops being worth an answer nobody asked to wait for.
 */
export const DIFF_MAX_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  const value = String(text ?? '');
  if (value === '') return [];
  // Normalize line endings first: a file checked out on Windows and the same
  // file on a Mac would otherwise differ on EVERY line, which is a diff that
  // tells the reader nothing about what actually changed.
  return value.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * A line-level diff of two documents.
 *
 * `left` is the OLDER side (an alternate copy) and `right` is the newer one
 * (the library's primary). Additions are what the newer side has, removals are
 * what the older side had — so a reader scanning the panel sees "what this
 * version is missing" and "what it still carries".
 */
export function diffLines(left: string, right: string): DiffResult {
  const a = splitLines(left);
  const b = splitLines(right);

  if (a.length === b.length && a.every((line, index) => line === b[index])) {
    return {
      lines: a.map((text, index) => ({
        op: 'equal' as const,
        leftNumber: index + 1,
        rightNumber: index + 1,
        text,
      })),
      added: 0,
      removed: 0,
      identical: true,
      truncated: false,
    };
  }

  // Trim the common prefix/suffix before the expensive part. This is what makes
  // the cap generous rather than binding: a one-line edit in a long document
  // reduces to a table of a few cells.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix
    && suffix < b.length - prefix
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix += 1;

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  const head: DiffLine[] = a.slice(0, prefix).map((text, index) => ({
    op: 'equal' as const,
    leftNumber: index + 1,
    rightNumber: index + 1,
    text,
  }));
  const tail: DiffLine[] = a.slice(a.length - suffix).map((text, index) => ({
    op: 'equal' as const,
    leftNumber: a.length - suffix + index + 1,
    rightNumber: b.length - suffix + index + 1,
    text,
  }));

  if ((midA.length + 1) * (midB.length + 1) > DIFF_MAX_CELLS) {
    const lines: DiffLine[] = [
      ...head,
      ...midA.map((text, index) => ({
        op: 'removed' as const,
        leftNumber: prefix + index + 1,
        rightNumber: null,
        text,
      })),
      ...midB.map((text, index) => ({
        op: 'added' as const,
        leftNumber: null,
        rightNumber: prefix + index + 1,
        text,
      })),
      ...tail,
    ];
    return { lines, added: midB.length, removed: midA.length, identical: false, truncated: true };
  }

  const middle = lcsDiff(midA, midB, prefix);
  const lines = [...head, ...middle, ...tail];
  return {
    lines,
    added: lines.filter(line => line.op === 'added').length,
    removed: lines.filter(line => line.op === 'removed').length,
    identical: false,
    truncated: false,
  };
}

/**
 * LCS over the non-common middle, walked back into an ordered line list.
 *
 * `offset` is how many common prefix lines were trimmed, so the line numbers
 * this produces are numbers in the ORIGINAL documents. Reporting positions
 * within a trimmed slice would make every number in the panel wrong by exactly
 * the amount that is hardest to notice.
 */
function lcsDiff(a: string[], b: string[], offset: number): DiffLine[] {
  const rows = a.length;
  const cols = b.length;
  // One flat Int32Array rather than nested arrays: the table is the only real
  // allocation here and (rows+1)*(cols+1) int32s is a quarter of what an array
  // of arrays of JS numbers costs.
  const table = new Int32Array((rows + 1) * (cols + 1));
  const at = (row: number, col: number) => row * (cols + 1) + col;

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let col = cols - 1; col >= 0; col -= 1) {
      table[at(row, col)] = a[row] === b[col]
        ? table[at(row + 1, col + 1)] + 1
        : Math.max(table[at(row + 1, col)], table[at(row, col + 1)]);
    }
  }

  const lines: DiffLine[] = [];
  let row = 0;
  let col = 0;
  while (row < rows && col < cols) {
    if (a[row] === b[col]) {
      lines.push({ op: 'equal', leftNumber: offset + row + 1, rightNumber: offset + col + 1, text: a[row] });
      row += 1;
      col += 1;
    } else if (table[at(row + 1, col)] >= table[at(row, col + 1)]) {
      lines.push({ op: 'removed', leftNumber: offset + row + 1, rightNumber: null, text: a[row] });
      row += 1;
    } else {
      lines.push({ op: 'added', leftNumber: null, rightNumber: offset + col + 1, text: b[col] });
      col += 1;
    }
  }
  while (row < rows) {
    lines.push({ op: 'removed', leftNumber: offset + row + 1, rightNumber: null, text: a[row] });
    row += 1;
  }
  while (col < cols) {
    lines.push({ op: 'added', leftNumber: null, rightNumber: offset + col + 1, text: b[col] });
    col += 1;
  }
  return lines;
}

export interface DiffHunk {
  lines: DiffLine[];
  /** Equal lines dropped between this hunk and the previous one. */
  skipped: number;
}

/**
 * Collapse long runs of unchanged lines, keeping `context` on each side.
 *
 * Without this, comparing two 800-line documents that differ in one paragraph
 * renders 800 lines to show three. `skipped` is carried rather than discarded
 * so the UI can say "42 unchanged lines" instead of silently implying the two
 * documents are adjacent.
 */
export function diffHunks(result: DiffResult, context = 3): DiffHunk[] {
  const changed = result.lines
    .map((line, index) => (line.op === 'equal' ? -1 : index))
    .filter(index => index >= 0);
  if (changed.length === 0) return [];

  const hunks: DiffHunk[] = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(result.lines.length - 1, changed[0] + context);
  let previousEnd = -1;

  for (const index of changed.slice(1)) {
    if (index - context <= end + 1) {
      end = Math.min(result.lines.length - 1, index + context);
      continue;
    }
    hunks.push({ lines: result.lines.slice(start, end + 1), skipped: start - previousEnd - 1 });
    previousEnd = end;
    start = Math.max(0, index - context);
    end = Math.min(result.lines.length - 1, index + context);
  }
  hunks.push({ lines: result.lines.slice(start, end + 1), skipped: start - previousEnd - 1 });
  return hunks;
}

/** "+12 −3", or "No differences". For a one-line summary next to a source. */
export function describeDiff(result: DiffResult): string {
  if (result.identical) return 'No differences';
  const parts: string[] = [];
  if (result.added > 0) parts.push(`+${result.added}`);
  if (result.removed > 0) parts.push(`−${result.removed}`);
  return parts.length > 0 ? parts.join(' ') : 'No differences';
}
