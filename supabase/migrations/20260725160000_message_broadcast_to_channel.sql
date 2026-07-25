/*
  # "Send to channel": agents work in a thread and broadcast the answer

  Before this, an agent's "Thinking …" placeholder sat in the CHANNEL and quietly
  turned into the final answer, with every tool-step chip threaded underneath it.
  The channel therefore carried the whole working session — a spinner, four tool
  chips, three intermediate text blocks — for one answer.

  This inverts it, following Slack's "Also send to channel": the agent WORKS in a
  thread hanging off the human message that started the turn, and only its final
  answer is explicitly broadcast into the channel.

  broadcast_to_channel is that explicit flag. A broadcast reply KEEPS its
  thread_parent_id — it is still a thread message, and still shows in the thread —
  the flag only adds it to the channel view, which selects
  `thread_parent_id is null OR broadcast_to_channel`. Everything else in the
  thread (placeholders, tool steps, intermediate segments) stays unflagged and so
  stays out of the channel.

  Humans get the same switch from the thread composer ("Send to channel"), which
  is why the column lives on messages generally and not on agent replies only.

  Defaults to false so every existing row — and every insert that does not mention
  it — keeps today's behaviour exactly.
*/

ALTER TABLE messages ADD COLUMN IF NOT EXISTS broadcast_to_channel boolean NOT NULL DEFAULT false;
