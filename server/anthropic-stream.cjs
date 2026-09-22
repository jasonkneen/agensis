'use strict';

// One transport parser for a built-in model step. A parsed JSON argument is
// not permission to dispatch: both its block and the message must finish.
async function readAnthropicStream(body, { signal, onDelta, usage, idleMs = 120_000, abort = () => {} } = {}) {
 let text = '', buffer = '', stopReason = '';
 let ended = false;
 const blocks = new Map();
 const open = new Set();
 const decoder = new TextDecoder();
 let timer;
 let rejectIdle;
 const idle = new Promise((_, reject) => { rejectIdle = reject; });
 const failure = (reason) => Object.assign(new Error(`Anthropic stream failed: phase=body reason=${reason}`), {
  code: 'anthropic_stream_failed', partialText: text,
 });
 const touch = () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
   const error = failure('idle_timeout');
   rejectIdle(error);
   abort(error);
  }, idleMs);
 };
 let rejectAbort;
 const aborted = new Promise((_, reject) => { rejectAbort = reject; });
 const onAbort = () => rejectAbort(signal.reason || failure('cancelled'));
 signal?.addEventListener('abort', onAbort, { once: true });
 const consume = (frame) => {
  const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  if (!data) return;
  let event;
  try { event = JSON.parse(data); } catch { throw failure('malformed_frame'); }
  if (!event || typeof event !== 'object') throw failure('invalid_event');
  if (ended) throw failure('event_after_message_stop');
  usage.event(event);
  if (event.type === 'error') throw failure(`provider_${event.error?.type || 'error'}`);
  if (event.type === 'content_block_start') {
   if (open.has(event.index) || blocks.has(event.index)) throw failure('duplicate_block');
   open.add(event.index);
   if (event.content_block?.type === 'tool_use') {
    const { id, name, input } = event.content_block;
    if (!id || !name) throw failure('invalid_tool_identity');
    blocks.set(event.index, { id, name, initial: input, json: '', closed: false });
   }
   touch();
  } else if (event.type === 'content_block_delta') {
   if (!open.has(event.index)) throw failure('delta_without_block');
   if (event.delta?.type === 'text_delta') {
    text += event.delta.text || '';
    if (event.delta.text) touch();
    onDelta?.(text);
   } else if (event.delta?.type === 'input_json_delta') {
    const block = blocks.get(event.index);
    if (!block) throw failure('arguments_without_tool');
    block.json += event.delta.partial_json || '';
    if (event.delta.partial_json) touch();
   } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) touch();
  } else if (event.type === 'content_block_stop') {
   if (!open.delete(event.index)) throw failure('stop_without_block');
   const block = blocks.get(event.index);
   if (block) block.closed = true;
   touch();
  } else if (event.type === 'message_delta') {
   if (event.delta?.stop_reason) stopReason = String(event.delta.stop_reason);
  } else if (event.type === 'message_stop') {
   if (open.size) throw failure('open_block');
   ended = true;
  }
 };
 const iterator = body[Symbol.asyncIterator]();
 try {
  if (signal?.aborted) throw signal.reason || failure('cancelled');
  touch();
  while (!ended) {
   const part = await Promise.race([iterator.next(), idle, aborted]);
   if (part.done) {
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    buffer = '';
    break;
   }
   buffer += decoder.decode(part.value, { stream: true });
   // Bound malformed events before buffering an arbitrarily large body.
   if (buffer.length > 2 * 1024 * 1024) throw failure('frame_too_large');
   let match;
   while ((match = /\r?\n\r?\n/.exec(buffer))) {
    const frame = buffer.slice(0, match.index);
    buffer = buffer.slice(match.index + match[0].length);
    consume(frame);
   }
  }
  if (!ended) throw failure('missing_message_stop');
  if (buffer.trim()) throw failure('trailing_partial_frame');
  if (!stopReason) throw failure('missing_stop_reason');
  const toolUses = [];
  for (const [, block] of [...blocks].sort(([a], [b]) => a - b)) {
   let input = block.initial;
   try { if (block.json.trim()) input = JSON.parse(block.json); } catch { throw failure('invalid_tool_json'); }
   if (!block.closed || !input || typeof input !== 'object' || Array.isArray(input) || '_partial' in input || '_raw' in input) {
    throw failure('invalid_tool_arguments');
   }
   toolUses.push({ id: block.id, name: block.name, input, inputError: '' });
  }
  if (toolUses.length && stopReason !== 'tool_use') throw failure(`tools_on_${stopReason}`);
  return { text, toolUses, stopReason };
 } catch (error) {
  if (error && typeof error === 'object') error.partialText = text;
  throw error;
 } finally {
  clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);
  // Cancel consumption without waiting for a stalled upstream iterator.
  Promise.resolve(iterator.return?.()).catch(() => {});
 }
}

module.exports = { readAnthropicStream };
