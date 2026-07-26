import { useCallback, useMemo, useState } from 'react';
import { MessageSquareWarning } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiAuthHeaders, apiUrl } from '@/lib/backendClient';
import { BUILD_ID } from '@/lib/appVersion';
import { CHROME_DEPTH } from '@/lib/chromeDepth';
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
import { WORKSPACE_CHROME_GAP, WORKSPACE_DOCK_BOTTOM_OFFSET, WORKSPACE_DOCK_HEIGHT } from '@/lib/workspaceLayout';
import { ElementPicker } from './ElementPicker';
import { FeedbackDialog } from './FeedbackDialog';

const BUTTON_SIZE = 40;

interface FeedbackButtonProps {
  workspaceId: string | null;
  userId: string | null;
  /** Human anchor for the report — the workspace/canvas the user is looking at. */
  contextLabel: string;
}

/**
 * Persistent feedback trigger, bottom-right.
 *
 * Positioned to sit in the same horizontal band as the window dock (which is
 * bottom-CENTRE with a `calc(100% - 12rem)` max width, leaving ~96px of clear
 * space each side) so the two read as one row and can never overlap. It stays
 * below the dialog layer (z 11990+) and above the dock (z 11000), and well
 * above floating windows, whose z-indexes start at 100.
 */
export function FeedbackButton({ workspaceId, userId, contextLabel }: FeedbackButtonProps) {
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
      {/*
        Hidden while picking. It carries `data-feedback-ui`, so the picker
        exempts it from click-swallowing — which would make it the one thing on
        the page that still reacts, and pressing it mid-pick would reset the
        description the user has already typed.
      */}
      {!picking && (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          data-feedback-ui
          onClick={handleOpen}
          title="Send feedback"
          aria-label="Send feedback"
          className="agensis-glass-panel fixed rounded-full border shadow-md"
          style={{
            right: WORKSPACE_CHROME_GAP + 8,
            bottom: WORKSPACE_DOCK_BOTTOM_OFFSET + Math.round((WORKSPACE_DOCK_HEIGHT - BUTTON_SIZE) / 2),
            width: BUTTON_SIZE,
            height: BUTTON_SIZE,
            // Above the window dock, below dialogs/sheets, so an open dialog is
            // never fighting a floating button for clicks. See the ladder in
            // src/lib/chromeDepth.ts.
            zIndex: CHROME_DEPTH.appDock,
          }}
        >
          <MessageSquareWarning className="size-4" />
        </Button>
      )}

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
}
