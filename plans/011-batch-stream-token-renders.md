# Plan 011: Batch streaming-token renders and memoize markdown parsing

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 871b535..HEAD -- src/hooks/useChat.ts src/hooks/useSubThreads.ts src/components/chat/MarkdownContent.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `871b535`, 2026-07-04

## Why this matters

This is the single biggest "the app feels slow" driver. During an AI reply, every
SSE token chunk calls `setMessages` (or `setSubThreadMessages`), and those states
live in hooks mounted at the top of the 3,011-line `App.tsx`. Nothing in
`src/components` is wrapped in `React.memo` (verify: `grep -rln "memo(" src/components`
returns nothing), so **each streamed token re-renders the entire application** —
sidebar, canvas, every floating window. On top of that, `MarkdownContent` re-parses
every message's markdown blocks on every render, so one token re-parses the whole
conversation: O(messages × tokens) parsing. After this plan, stream writes are
coalesced to at most one state flush per animation frame, and settled messages
never re-parse their markdown.

## Current state

- `src/hooks/useChat.ts` — main chat hook, mounted in `App.tsx:602`. The stream
  consumer (lines 451–487):

```ts
// src/hooks/useChat.ts:451
const consumeStreamData = (data: string) => {
  if (data === '[DONE]') return;
  try {
    const parsed = JSON.parse(data);
    const { text, error } = parseAiStreamPayload(parsed);
    if (error) {
      streamError = error;
    }
    if (text) {
      fullContent += text;
      setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, content: fullContent } : m)); // :461 — fires per token
    }
  } catch {
    // Ignore malformed stream chunks and keep consuming the stream.
  }
};
```

  After the read loop, the final flush (must stay synchronous and exact):

```ts
// src/hooks/useChat.ts:486
const finalContent = finalAssistantStreamContent(fullContent, streamError);
setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, content: finalContent } : m));
```

- `src/hooks/useSubThreads.ts` — identical pattern for sub-thread replies, in the
  `consume` closure around lines 305–316 (`setSubThreadMessages(prev => prev.map(...))`
  per token), with its own final flush right after the read loop via
  `finalAssistantStreamContent`.

- `src/components/chat/MarkdownContent.tsx:21-32` — parses on every render, no memo:

```tsx
export function MarkdownContent({ content, compact = false, streaming = false, onMentionClick }: MarkdownContentProps) {
  const frontmatter = streaming ? null : parseFrontmatter(content);
  const bodyContent = frontmatter ? frontmatter.body : content;
  const blocks = parseBlocks(streaming ? closeOpenMarkers(bodyContent) : bodyContent);
  ...
```

- Convention: hooks in this repo use `useRef` for mutable stream state already
  (see `streamAbortRef`, `src/hooks/useChat.ts:20`). Match that style.

## Commands you will need

| Purpose   | Command                 | Expected on success |
|-----------|-------------------------|---------------------|
| Typecheck | `npm run typecheck`     | exit 0              |
| Lint      | `npm run lint`          | exit 0              |
| Unit tests| `npm run test:unit`     | all pass            |
| Node tests| `npm test`              | all pass            |
| Build     | `npm run build`         | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/hooks/useChat.ts`
- `src/hooks/useSubThreads.ts`
- `src/components/chat/MarkdownContent.tsx`

**Out of scope** (do NOT touch, even though they look related):
- `src/lib/chatStream.ts` — the SSE frame parser is shared and correct; batching
  happens at the state-write layer, not the parse layer.
- `src/components/windows/ChatWindowContent.tsx` — memoizing `ChatMessageBubble`
  is deliberately deferred (its ~20 callback props are inline closures; see plan 016).
- The realtime INSERT/UPDATE/DELETE handlers in either hook — they are
  event-driven deltas, not token streams; leave them alone.

## Git workflow

- Branch: `perf/011-batch-stream-renders`
- Commit style: imperative summary line, matching `git log` (e.g. "Batch stream token renders behind rAF").
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: rAF-coalesce stream writes in `useChat.ts`

Inside `streamDirectAI`, replace the per-token `setMessages` at line 461 with a
requestAnimationFrame-batched flush. Target shape:

```ts
let flushHandle: number | null = null;
const flushStreamContent = () => {
  flushHandle = null;
  const snapshot = fullContent;
  setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, content: snapshot } : m));
};
const consumeStreamData = (data: string) => {
  if (data === '[DONE]') return;
  try {
    const parsed = JSON.parse(data);
    const { text, error } = parseAiStreamPayload(parsed);
    if (error) streamError = error;
    if (text) {
      fullContent += text;
      if (flushHandle === null) flushHandle = requestAnimationFrame(flushStreamContent);
    }
  } catch { /* ignore malformed frame */ }
};
```

After the read loop (before the existing final flush at ~line 486), cancel any
pending frame so the final synchronous `setMessages` with `finalContent` is the
last write:

```ts
if (flushHandle !== null) { cancelAnimationFrame(flushHandle); flushHandle = null; }
```

Also cancel the pending frame in the abort/error paths of the same function (the
`catch` that handles unmount-abort around line 501 — a cancelled stream must not
flush after state teardown).

**Verify**: `npm run typecheck` → exit 0. `grep -n "requestAnimationFrame" src/hooks/useChat.ts` → at least 1 match inside `streamDirectAI`.

### Step 2: Same batching in `useSubThreads.ts`

Apply the identical pattern to the `consume` closure (~line 305): accumulate
`fullContent`, schedule one `requestAnimationFrame` flush, cancel before the
final `finalAssistantStreamContent` write.

**Verify**: `npm run typecheck` → exit 0. `grep -n "requestAnimationFrame" src/hooks/useSubThreads.ts` → at least 1 match.

### Step 3: Memoize parsing in `MarkdownContent.tsx`

Wrap the parse work in `useMemo` and the component in `React.memo`:

```tsx
export const MarkdownContent = React.memo(function MarkdownContent({ content, compact = false, streaming = false, onMentionClick }: MarkdownContentProps) {
  const { frontmatter, blocks } = React.useMemo(() => {
    const fm = streaming ? null : parseFrontmatter(content);
    const body = fm ? fm.body : content;
    return { frontmatter: fm, blocks: parseBlocks(streaming ? closeOpenMarkers(body) : body) };
  }, [content, streaming]);
  ...
});
```

Keep the JSX body identical. Check every import site still works
(`grep -rn "MarkdownContent" src --include='*.tsx'`) — it is imported as a named
export; keep the export name.

**Verify**: `npm run typecheck` → exit 0; `npm run lint` → exit 0.

### Step 4: Full verification

**Verify**: `npm run test:unit` → all pass; `npm test` → all pass; `npm run build` → exit 0.

## Test plan

- `tests/` contains node test files for stream parsing (`chatStream`); do not
  modify them. Add a vitest unit test only if one already covers
  `MarkdownContent` (check `git grep -l MarkdownContent -- '*.test.*'`); if none
  exists, skip new tests — the verification gates above plus a manual smoke
  (send a chat message in dev, watch the reply stream smoothly and finish with
  complete text) are the acceptance check.
- Manual smoke (if a dev environment is available): `npm run dev`, send a
  message, confirm (a) streamed text appears progressively, (b) the final
  message text is complete, (c) editing/deleting a message still works.

## Done criteria

- [ ] `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm test`, `npm run build` all exit 0
- [ ] `grep -c "setMessages(prev => prev.map(m => m.id === assistantMsgId" src/hooks/useChat.ts` returns fewer per-token occurrences than before: the only remaining unconditional per-chunk write is gone (the rAF flush + final flush remain)
- [ ] `src/components/chat/MarkdownContent.tsx` contains `useMemo` around `parseBlocks`
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts above don't match the live code (drift).
- The final streamed message ever renders incomplete or duplicated in the manual
  smoke — the cancel-before-final-flush ordering is wrong; report rather than
  adding more state.
- You find yourself wanting to change `ChatWindowContent.tsx` or `App.tsx` to
  make this work — that's plan 016's territory.

## Maintenance notes

- Plan 016 (memoize the window tree) multiplies this win: after 016, a stream
  flush re-renders only the chat window, not the whole app.
- Reviewers should scrutinize the abort path: an unmounted component must not
  receive a queued rAF flush.
- Deferred: throttling below one flush per frame (e.g. 50ms) if profiling still
  shows pressure on low-end devices.
