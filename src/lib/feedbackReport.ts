// ---------------------------------------------------------------------------
// The feedback report payload: one shape, assembled by one pure function.
//
// This exists so the wire format has a single definition that both the dialog
// and the tests agree on, and so the size/redaction rules live somewhere they
// can be asserted rather than being scattered through a React component.
//
// The server re-validates and re-clamps everything here (see
// normalizeFeedbackSubmission in shared/backend-core.cjs) — this is the
// client's contribution to a payload the server never trusts.
// ---------------------------------------------------------------------------

import type { DiagnosticsSnapshot } from './feedbackDiagnostics';
import type { ElementDescriptor } from './feedbackElement';
import { redactSecrets } from './feedbackRedaction';

export const FEEDBACK_DESCRIPTION_MAX_CHARS = 4000;
export const FEEDBACK_MAX_SELECTIONS = 5;

export interface FeedbackPageRef {
  /** location.pathname — the route, such as it is in a single-page canvas app. */
  path: string;
  hash: string;
  /** Human anchor: the workspace/canvas the user was looking at. */
  label: string;
}

export interface FeedbackSubmission {
  description: string;
  workspaceId: string | null;
  page: FeedbackPageRef;
  selections: ElementDescriptor[];
  /** Null when the user unticked "attach diagnostics". Consent is not implied. */
  diagnostics: DiagnosticsSnapshot | null;
}

export interface BuildFeedbackSubmissionInput {
  description: string;
  workspaceId?: string | null;
  page: FeedbackPageRef;
  selections?: ElementDescriptor[];
  diagnostics?: DiagnosticsSnapshot | null;
  includeDiagnostics?: boolean;
}

/**
 * Assemble + sanitise the payload. Pure: no DOM, no fetch, no clock.
 *
 * Redaction runs over the user's own prose too — people paste error output
 * containing an Authorization header into free-text boxes constantly, and that
 * text goes to the same shared workspace as everything else.
 */
export function buildFeedbackSubmission(input: BuildFeedbackSubmissionInput): FeedbackSubmission {
  const description = redactSecrets(String(input.description ?? '').trim()).slice(0, FEEDBACK_DESCRIPTION_MAX_CHARS);
  const includeDiagnostics = input.includeDiagnostics !== false;

  return {
    description,
    workspaceId: input.workspaceId ? String(input.workspaceId) : null,
    page: {
      path: redactSecrets(String(input.page?.path ?? '')).slice(0, 400),
      hash: redactSecrets(String(input.page?.hash ?? '')).slice(0, 200),
      label: redactSecrets(String(input.page?.label ?? '')).slice(0, 200),
    },
    selections: (input.selections ?? []).slice(0, FEEDBACK_MAX_SELECTIONS).map(selection => ({
      ...selection,
      selector: redactSecrets(selection.selector),
      text: redactSecrets(selection.text),
    })),
    diagnostics: includeDiagnostics ? (input.diagnostics ?? null) : null,
  };
}

/** True when there is enough here to be worth someone's time. */
export function isSubmittableFeedback(submission: FeedbackSubmission): boolean {
  return submission.description.trim().length >= 3;
}

/**
 * Human summary of what is about to be sent, rendered above the submit button.
 * "Show the user what is attached before they submit" is the consent
 * requirement; this is the sentence that does it.
 */
export function describeAttachments(submission: FeedbackSubmission): string {
  const parts: string[] = [];
  if (submission.selections.length > 0) {
    parts.push(`${submission.selections.length} element${submission.selections.length === 1 ? '' : 's'}`);
  }
  const diagnostics = submission.diagnostics;
  if (diagnostics) {
    parts.push(`${diagnostics.console.length} console line${diagnostics.console.length === 1 ? '' : 's'}`);
    if (diagnostics.errors.length > 0) {
      parts.push(`${diagnostics.errors.length} error${diagnostics.errors.length === 1 ? '' : 's'}`);
    }
    parts.push('build + browser info');
  }
  if (parts.length === 0) return 'Nothing attached — just your description.';
  return `Attaching: ${parts.join(', ')}.`;
}
