-- Heal chat_sessions.participants[].agent_id / .id: strip the browser's
-- `agent:<uuid>` composite-key prefix down to the bare uuid.
--
-- NOT COSMETIC. Every server-side roster comparison is an exact string match on
-- the bare id, the load-bearing one being insertActiveAgentJob's final
-- reservation (server/agent-jobs.cjs):
--
--     where participant->>'agent_id' = a.id::text
--
-- With the prefix stored, that matched nothing, the insert returned null, the
-- "Thinking …" placeholder was deleted and the human's message disappeared —
-- no job, no parked turn, no error surfaced anywhere. Measured live before this
-- ran: @codex sat in #testtest with agent_id 'agent:0870de2f-…' and could not
-- answer a single message; six of Jason's last twenty-four messages got no
-- agent turn at all.
--
-- Writes are normalized from now on (normalizeSessionParticipants, applied in
-- server/lib/db-sql.cjs and netlify/functions/backend.mjs), so this is a
-- one-time repair of rows written before that landed.
--
-- Scoped to agent rows with the prefix actually present: `where` keeps the
-- statement off every other session, and the kind check means a human
-- participant is never rewritten. Idempotent — running it twice is a no-op.

UPDATE chat_sessions s
   SET participants = (
         SELECT jsonb_agg(
                  CASE
                    WHEN participant->>'kind' = 'agent' THEN
                      participant
                        || CASE WHEN participant ? 'agent_id'
                                THEN jsonb_build_object('agent_id', regexp_replace(participant->>'agent_id', '^agent:', ''))
                                ELSE '{}'::jsonb END
                        || CASE WHEN participant ? 'id'
                                THEN jsonb_build_object('id', regexp_replace(participant->>'id', '^agent:', ''))
                                ELSE '{}'::jsonb END
                    ELSE participant
                  END
                  ORDER BY ordinality
                )
           FROM jsonb_array_elements(s.participants) WITH ORDINALITY AS t(participant, ordinality)
       ),
       updated_at = now()
 WHERE jsonb_typeof(s.participants) = 'array'
   AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(s.participants) AS p
          WHERE p->>'kind' = 'agent'
            AND (p->>'agent_id' LIKE 'agent:%' OR p->>'id' LIKE 'agent:%')
       );
