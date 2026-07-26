import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { RENAME_MAX_CHARS, resolveRename, shouldCommitOnBlur } from '@/lib/renameEntity';

// One inline rename editor, shared by workspace tiles and desktop tiles.
//
// Click, type, Enter to save, Escape to abandon. A modal for a two-word edit
// is a lot of ceremony for something you do while looking straight at the
// thing you are renaming.

interface InlineRenameProps {
  value: string;
  /** Resolves false when the write was rejected; the editor stays open and says so. */
  onCommit: (name: string) => Promise<boolean> | boolean;
  onCancel: () => void;
  className?: string;
  ariaLabel?: string;
}

export function InlineRename({ value, onCommit, onCancel, className, ariaLabel }: InlineRenameProps) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // Escape sets this BEFORE the blur it causes, so the blur handler can tell an
  // abandoned edit from an ordinary one. Without it, Escape saves the very
  // change it was meant to discard.
  const cancelledRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = useCallback(async () => {
    if (saving) return;
    const outcome = resolveRename(draft, value);
    if (outcome.action === 'noop') { onCancel(); return; }
    if (outcome.action === 'reject') { setError(outcome.reason); return; }
    setSaving(true);
    setError('');
    // The write is allowed to fail, and the editor must not close pretending it
    // saved — that optimistic lie is the bug class fixed across this app today.
    const ok = await onCommit(outcome.name);
    setSaving(false);
    if (ok) onCancel();
    else setError('Could not rename. Try again.');
  }, [draft, value, saving, onCommit, onCancel]);

  return (
    <span className={cn('relative flex min-w-0 flex-1 items-center', className)}>
      <input
        ref={inputRef}
        value={draft}
        maxLength={RENAME_MAX_CHARS}
        aria-label={ariaLabel || 'Rename'}
        aria-invalid={error ? true : undefined}
        disabled={saving}
        onChange={event => { setDraft(event.target.value); if (error) setError(''); }}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); void commit(); }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            cancelledRef.current = true;
            onCancel();
          }
        }}
        onBlur={() => { if (shouldCommitOnBlur(cancelledRef.current)) void commit(); }}
        // Stop a click inside the editor from reaching the tile underneath and
        // switching workspace mid-rename.
        onClick={event => event.stopPropagation()}
        onPointerDown={event => event.stopPropagation()}
        className={cn(
          'min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-[13px] text-foreground outline-none',
          error ? 'border-destructive' : 'border-ring',
        )}
      />
      {error && (
        <span role="alert" className="absolute left-0 top-full z-10 mt-1 whitespace-nowrap rounded bg-destructive px-1.5 py-0.5 text-[11px] text-destructive-foreground">
          {error}
        </span>
      )}
    </span>
  );
}
