import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { HUDDLE_NOTES_MAX_LENGTH } from '@/lib/huddleDock';
import { useHuddleRecord } from '@/hooks/useHuddle';
import { useHuddleSession } from './HuddleSessionContext';

// The Notes tab. "A note-taking area — click on it and just drop some text in,
// or you guys could drop stuff in there if you wanted to" (Jason). Shared,
// plain text, autosaved — not a document editor and not per-person.
//
// TWO SOURCES, same split as HuddlePanel: while this channel's own huddle is
// live, the dock's session (HuddleSessionContext) already holds the row and
// its realtime subscription, so notes saved by someone else's browser arrive
// here for free. A marker can point at a DIFFERENT, usually-ended huddle
// (`huddleId` prop) — that one is fetched on its own via useHuddleRecord,
// exactly like the transcript is.

const SAVE_DEBOUNCE_MS = 600;

interface HuddleNotesProps {
  workspaceId: string | null;
  huddleId?: string | null;
}

export function HuddleNotes({ workspaceId, huddleId = null }: HuddleNotesProps) {
  const session = useHuddleSession();
  const currentId = session?.huddle?.id ?? null;

  // Only a genuinely different huddle needs its own fetch — see HuddlePanel's
  // identical `needsFetch` reasoning.
  const needsFetch = Boolean(huddleId && huddleId !== currentId);
  const record = useHuddleRecord(workspaceId, needsFetch ? huddleId : null);

  const live = !needsFetch;
  const remoteNotes = live ? (session?.notes ?? '') : record.notes;
  const loading = !live && record.loading;
  // Something to save INTO: a live huddle row (session.huddle), or a specific
  // past one named by huddleId. Neither exists before the first huddle in a
  // channel ever starts.
  const canEdit = live ? !!session?.huddle?.id : !!huddleId;

  const [text, setText] = useState(remoteNotes);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const lastRemoteRef = useRef(remoteNotes);
  const saveTimerRef = useRef<number | null>(null);
  const savedHintTimerRef = useRef<number | null>(null);

  // A remote change landed (realtime, in live mode; a fresh fetch, in record
  // mode). Adopt it UNLESS there is an unsaved edit sitting in the box right
  // now — otherwise someone else's save mid-keystroke would erase what's
  // being typed.
  useEffect(() => {
    if (remoteNotes === lastRemoteRef.current) return;
    lastRemoteRef.current = remoteNotes;
    if (!dirty) setText(remoteNotes);
  }, [remoteNotes, dirty]);

  // Switching which huddle is shown (a different marker opened, or the tab
  // regained a live huddle it did not have a moment ago) starts fresh rather
  // than carrying over the previous huddle's box contents.
  useEffect(() => {
    lastRemoteRef.current = remoteNotes;
    setText(remoteNotes);
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live ? currentId : huddleId]);

  useEffect(() => () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    if (savedHintTimerRef.current) window.clearTimeout(savedHintTimerRef.current);
  }, []);

  const flush = async (value: string) => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setSaving(true);
    const ok = live ? await session?.saveNotes(value) : await record.saveNotes(value);
    setSaving(false);
    if (ok) {
      setDirty(false);
      lastRemoteRef.current = value;
      setJustSaved(true);
      if (savedHintTimerRef.current) window.clearTimeout(savedHintTimerRef.current);
      savedHintTimerRef.current = window.setTimeout(() => setJustSaved(false), 1500);
    }
  };

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value.slice(0, HUDDLE_NOTES_MAX_LENGTH);
    setText(value);
    setDirty(true);
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => { void flush(value); }, SAVE_DEBOUNCE_MS);
  };

  // A blur (switching tabs, closing the dock) must not lose the last few
  // keystrokes to a debounce that never got to fire.
  const handleBlur = () => {
    if (dirty) void flush(text);
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-3 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Loading notes
      </div>
    );
  }

  if (!canEdit) {
    return (
      <div className="p-3 text-sm text-muted-foreground">
        Notes appear here once this huddle has started.
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <textarea
        data-testid="huddle-notes-textarea"
        value={text}
        onChange={handleChange}
        onBlur={handleBlur}
        placeholder="Notes and actions from this call — anyone here can add to them."
        maxLength={HUDDLE_NOTES_MAX_LENGTH}
        className={cn(
          'min-h-0 flex-1 resize-none border-0 bg-transparent p-3 text-sm text-foreground',
          'placeholder:text-muted-foreground focus-visible:outline-none',
        )}
      />
      <div className="flex shrink-0 items-center justify-end gap-1.5 border-t border-border px-3 py-1 text-[11px] text-muted-foreground">
        {saving ? (
          <>
            <Spinner className="size-3" />
            Saving…
          </>
        ) : justSaved ? (
          'Saved'
        ) : dirty ? (
          'Unsaved changes'
        ) : (
          ' '
        )}
      </div>
    </div>
  );
}
