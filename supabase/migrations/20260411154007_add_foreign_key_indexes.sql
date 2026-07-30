/*
  # Add indexes on unindexed foreign keys

  1. New Indexes
    - `idx_chat_sessions_workspace_id` on `chat_sessions(workspace_id)`
    - `idx_documents_workspace_id` on `documents(workspace_id)`
    - `idx_memory_facts_workspace_id` on `memory_facts(workspace_id)`
    - `idx_messages_session_id` on `messages(session_id)`
    - `idx_uploaded_files_workspace_id` on `uploaded_files(workspace_id)`

  2. Purpose
    - Improves JOIN and CASCADE DELETE performance on foreign key lookups
    - Resolves unindexed foreign key warnings
*/

CREATE INDEX IF NOT EXISTS idx_chat_sessions_workspace_id ON chat_sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_documents_workspace_id ON documents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_memory_facts_workspace_id ON memory_facts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_workspace_id ON uploaded_files(workspace_id);
