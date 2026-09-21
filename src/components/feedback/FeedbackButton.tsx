import { forwardRef, useCallback, useImperativeHandle, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { apiAuthHeaders, apiUrl } from '@/lib/backendClient';
import { BUILD_ID } from '@/lib/appVersion';
import {
  buildDiagnosticsSnapshot,
  consoleCaptureTruncated,
  getCapturedConsole,
  getCapturedErrors,
  type DiagnosticsSnapshot,
} from '@/lib/feedbackDiagnostics';
import type { ElementDescriptor } from '@/lib/feedbackElement';
import {
  buildFeedbackSubmission,
  FEEDBACK_MAX_SELECTIONS,
  type FeedbackPageRef,
} from '@/lib/feedbackReport';
import { ElementPicker } from './ElementPicker';
import { FeedbackDialog } from './FeedbackDialog';

/** Imperative handle the workspace-rail trigger uses to open the dialog. */
export interface FeedbackHandle {
  open: () => void;
}

interface FeedbackButtonProps {
  workspaceId: string | null;
  userId: string | null;
  /** Human anchor for the report — the workspace/canvas the user is looking at. */
  contextLabel: string;
}

/**
 * The feedback flow: the report dialog, the on-page element picker, and the
 * submit call.
 *
 * It no longer renders its own launcher. The trigger is now a fixed,
 * non-movable icon in the workspace rail (see WorkspaceRail's Feedback button),
 * which calls `open()` on the handle this exposes via ref. This component stays
 * mounted at the app root so the dialog and picker overlay the whole UI
 * regardless of where the rail sits — it renders no chrome of its own until the
 * dialog is opened.
 *
 * The old draggable/dodging floating launcher (and its per-user anchor
 * persistence) was removed with that move; `src/lib/feedbackAnchor.ts` is the
 * home of that geometry and is now unused by this component.
 */
export const FeedbackButton = forwardRef<FeedbackHandle, FeedbackButtonProps>(
  function FeedbackButton({ workspaceId, userId, contextLabel }, ref) {
    const [open, setOpen] = useState(false);
    const [picking, setPicking] = useState(false);
    const [description, setDescription] = useState('');
    const [selections, setSelections] = useState<ElementDescriptor[]>([]);
    const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
    const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const page: FeedbackPageRef = useMemo(() => ({
      path: typeof window !== 'undefined' ? window.location.pathname : '',
      hash: typeof window !== 'undefined' ? window.location.hash : '',
      label: contextLabel,
    }), [contextLabel]);

    // Snapshot at OPEN time, not at submit time: by the time someone has finished
    // typing a paragraph the ring buffer has usually rolled past the lines that
    // explain the bug they are describing.
    const takeSnapshot = useCallback((): DiagnosticsSnapshot => buildDiagnosticsSnapshot(
      {
        buildId: BUILD_ID,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        url: typeof window !== 'undefined' ? window.location.href : '',
        viewportWidth: typeof window !== 'undefined' ? window.innerWidth : 0,
        viewportHeight: typeof window !== 'undefined' ? window.innerHeight : 0,
        language: typeof navigator !== 'undefined' ? navigator.language : '',
        capturedAt: new Date().toISOString(),
      },
      getCapturedConsole(),
      getCapturedErrors(),
      consoleCaptureTruncated(),
    ), []);

    const handleOpen = useCallback(() => {
      setDescription('');
      setSelections([]);
      setIncludeDiagnostics(true);
      setError(null);
      setDiagnostics(takeSnapshot());
      setOpen(true);
    }, [takeSnapshot]);

    useImperativeHandle(ref, () => ({ open: handleOpen }), [handleOpen]);

    const handleClose = useCallback(() => {
      setOpen(false);
      setPicking(false);
    }, []);

    const handleStartPicking = useCallback(() => setPicking(true), []);
    const handleStopPicking = useCallback(() => setPicking(false), []);

    const handlePick = useCallback((descriptor: ElementDescriptor) => {
      setSelections(prev => (prev.length >= FEEDBACK_MAX_SELECTIONS ? prev : [...prev, descriptor]));
    }, []);

    const handleRemoveSelection = useCallback((index: number) => {
      setSelections(prev => prev.filter((_, i) => i !== index));
    }, []);

    const submission = useMemo(() => buildFeedbackSubmission({
      description,
      workspaceId,
      page,
      selections,
      diagnostics,
      includeDiagnostics,
    }), [description, workspaceId, page, selections, diagnostics, includeDiagnostics]);

    const handleSubmit = useCallback(async () => {
      setSubmitting(true);
      setError(null);
      try {
        const response = await fetch(apiUrl('/backend/feedback'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
          body: JSON.stringify(submission),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.error) {
          setError(payload?.error?.message || `Could not send feedback (${response.status})`);
          return;
        }
        toast.success('Thanks — your report is in.');
        handleClose();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not send feedback');
      } finally {
        setSubmitting(false);
      }
    }, [submission, handleClose]);

    return (
      <>
        <FeedbackDialog
          // Hidden, not unmounted, while picking: the user is out on the page
          // choosing an element and must come back to the text they already typed.
          open={open && !picking}
          onClose={handleClose}
          description={description}
          onDescriptionChange={setDescription}
          workspaceId={workspaceId}
          userId={userId}
          page={page}
          selections={selections}
          onRemoveSelection={handleRemoveSelection}
          onStartPicking={handleStartPicking}
          maxSelections={FEEDBACK_MAX_SELECTIONS}
          includeDiagnostics={includeDiagnostics}
          onToggleDiagnostics={setIncludeDiagnostics}
          diagnostics={diagnostics}
          submission={submission}
          submitting={submitting}
          error={error}
          onSubmit={handleSubmit}
        />

        {picking && (
          <ElementPicker
            onPick={handlePick}
            onDone={handleStopPicking}
            onCancel={handleStopPicking}
            picked={selections}
            max={FEEDBACK_MAX_SELECTIONS}
          />
        )}
      </>
    );
  },
);
