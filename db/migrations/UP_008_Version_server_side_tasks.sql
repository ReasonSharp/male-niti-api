-- Version 008: A-To-Do's rules move to the server (lib/atodo/domain/) --
-- the client reads one day at a time and sends actions instead of saving
-- its whole task list.
--
--   atodo.tasks.time_zone            -- a timed task's fixed time zone (IANA,
--                                       e.g. America/New_York); NULL = fluid:
--                                       its due time is the user's local time
--                                       wherever they are
--   atodo.accounts.active_focus_since -- when the focused occurrence's
--                                       focus-only session started (ms), so
--                                       focus time is credited by the server
--                                       (the client kept it in page memory)
--   atodo.imports / import_chunks    -- a data import uploaded in chunks and
--                                       committed in one go (POST /imports)
--
-- Plus indexes for loading one task's rows.

ALTER TABLE atodo.tasks ADD COLUMN time_zone TEXT;
ALTER TABLE atodo.accounts ADD COLUMN active_focus_since BIGINT;

CREATE INDEX tasks_account_task ON atodo.tasks (account_id, task_id);
CREATE INDEX occurrences_account_task ON atodo.occurrences (account_id, task_id);

CREATE TABLE atodo.imports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES atodo.accounts (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- An import not committed by then is abandoned (and deleted).
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 hour',
    -- What the file carried besides tasks: profile, focus, view mode.
    meta JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE atodo.import_chunks (
    import_id UUID NOT NULL REFERENCES atodo.imports (id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    tasks JSONB NOT NULL,
    occurrences JSONB NOT NULL,
    PRIMARY KEY (import_id, seq)
);
