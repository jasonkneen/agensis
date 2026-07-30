/*
  # Agent tool steps as structured messages

  A daemon turn spent reading files, grepping and running bash produces no text,
  so each tool call is posted as its own message threaded under the agent's
  reply. Those rows arrived as ordinary chat messages, so four tool calls in a
  row rendered as four full bubbles — avatar, agent name, timestamp and a wrapped
  raw bash command each — which filled the screen and read as noise.

  message_kind is the discriminator ('' for a normal message, 'tool_step' for one
  agent tool call); tool_name and tool_detail are the structured halves of the
  line the server already writes into `content` ("Bash · npm test").

  `content` KEEPS that human-readable line: it is the fallback for clients that
  predate these columns and for step rows inserted before they existed, so the
  renderer prefers tool_name/tool_detail and falls back to `content` when
  tool_name is empty. All three columns default to '' so every existing row —
  and every insert that does not mention them — stays valid.
*/

ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_kind text DEFAULT '';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_name text DEFAULT '';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_detail text DEFAULT '';
