-- Version 009: every focus and timer session on an A-To-Do occurrence, as it
-- ran -- the agenda draws them where they happened, and one can be deleted
-- as a bad measurement (its seconds come off the occurrence's totals,
-- atodo.occurrences.focused_seconds / timer_seconds, which stay the totals
-- stats and averages read).
--
--   kind        'focus' (focused without a timer) or 'timer'
--   started_at,
--   ended_at    when it ran (ms since the epoch, like atodo's other times);
--               a session still running isn't here yet -- it's the
--               account's focused occurrence (active_focus_since, or the
--               occurrence's timer.runningSince)
--   seconds     what it credited to the occurrence (a timer that ran out is
--               credited only up to that moment, so not always the span)
--
-- Deleted with its occurrence (and so with its task and account).

CREATE TABLE atodo.focus_sessions (
    id BIGSERIAL PRIMARY KEY,
    account_id UUID NOT NULL,
    occurrence_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('focus', 'timer')),
    started_at BIGINT NOT NULL,
    ended_at BIGINT NOT NULL,
    seconds INTEGER NOT NULL,
    FOREIGN KEY (account_id, occurrence_id) REFERENCES atodo.occurrences (account_id, id) ON DELETE CASCADE
);

CREATE INDEX focus_sessions_account_time ON atodo.focus_sessions (account_id, started_at, ended_at);
CREATE INDEX focus_sessions_occurrence ON atodo.focus_sessions (account_id, occurrence_id);
