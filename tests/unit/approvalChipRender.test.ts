import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PermissionRequestCard } from '../../src/components/chat/PermissionRequestCard';
import { ToolStepGroup } from '../../src/components/chat/ToolStepGroup';
import { PERMISSION_REQUEST_KIND, settledApprovalFromMessage } from '../../src/components/chat/permissionRequests';
import { buildTranscriptRows, type TranscriptStepRow } from '../../src/components/chat/toolSteps';
import type { Message, PermissionRequest } from '../../src/types';

// What the pure functions cannot show: that ONE approval produces ONE piece of
// UI, and that the string a reader actually sees is the shortened path while the
// full one is still reachable. The bug this covers was two renders for the same
// class of event — a full-width bubble carrying a raw absolute path, plus a chip
// — decided only by whether the tab was open when the human clicked.

const LONG = '/Users/jkneen/Documents/GitHub/agensis/src/components/windows/TasksWindowContent.tsx';

const message = (over: Partial<Message>): Message => ({
  id: 'm1',
  session_id: 's1',
  role: 'assistant',
  content: '',
  created_at: '2026-07-29T09:00:00.000Z',
  sender_id: 'agent-1',
  ...over,
} as Message);

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('an approved call renders as one chip, not a chip and a bubble', () => {
  const rows = () => buildTranscriptRows(
    [
      message({
        id: 'req-msg',
        message_kind: PERMISSION_REQUEST_KIND,
        permission_request_id: 'req-1',
        tool_name: 'Read',
        tool_detail: LONG,
        content: `Always allowed by God Emperor Jason: Read · ${LONG}`,
      }),
      message({ id: 'step', message_kind: 'tool_step', tool_name: 'Read', tool_detail: LONG }),
    ],
    undefined,
    // No live row: the decision was made before this tab loaded, which is the
    // case that used to fall through to a bubble.
    () => undefined,
  );

  it('produces a single step row and no message row', () => {
    expect(rows().map(row => row.kind)).toEqual(['steps']);
  });

  it('shows the shortened path on the chip and keeps the full one in title', () => {
    act(() => root.render(createElement(ToolStepGroup, { row: rows()[0] as TranscriptStepRow })));
    // Expand the strip, then the Read bucket, to reach the individual call.
    click(container.querySelector('button[aria-expanded]')!);
    const bucket = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Read'))!;
    click(bucket);

    const chip = container.querySelector('li > span')!;
    expect(chip.textContent).toContain('…/components/windows/TasksWindowContent.tsx');
    // The machine-specific prefix is gone from what is DRAWN...
    expect(chip.textContent).not.toContain('/Users/jkneen');
    // ...but never lost: the untouched path is one hover away.
    expect(chip.getAttribute('title')).toContain(LONG);
  });

  it('names the scope on the chip and the approver only in the title', () => {
    act(() => root.render(createElement(ToolStepGroup, { row: rows()[0] as TranscriptStepRow })));
    click(container.querySelector('button[aria-expanded]')!);
    const bucket = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Read'))!;
    click(bucket);

    const chip = container.querySelector('li > span')!;
    expect(chip.textContent).toContain('Always');
    // Which grant was made outlives the conversation; who made it does not, and
    // it was crowding out the call being described.
    expect(chip.textContent).not.toContain('God Emperor Jason');
    expect(chip.getAttribute('title')).toContain('Always allowed by God Emperor Jason');
  });
});

describe('a settled approval that gated no call is a quiet line', () => {
  const denied = settledApprovalFromMessage(message({
    message_kind: PERMISSION_REQUEST_KIND,
    permission_request_id: 'req-2',
    tool_name: 'Bash',
    tool_detail: `rm -rf ${LONG}`,
    content: `Denied by God Emperor Jason: Bash · rm -rf ${LONG}`,
  })) as PermissionRequest;

  it('leads with what was asked for, not with who answered', () => {
    act(() => root.render(createElement(PermissionRequestCard, { request: denied, onDecide: () => {} })));
    const text = container.textContent ?? '';
    expect(text).toContain('…/components/windows/TasksWindowContent.tsx');
    expect(text).toContain('Denied');
    expect(text).not.toContain('God Emperor Jason');
    // Reading order: the call, then the outcome.
    expect(text.indexOf('TasksWindowContent.tsx')).toBeLessThan(text.indexOf('Denied'));
  });

  it('renders no buttons — there is nothing left to answer', () => {
    act(() => root.render(createElement(PermissionRequestCard, { request: denied, onDecide: () => {} })));
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});
