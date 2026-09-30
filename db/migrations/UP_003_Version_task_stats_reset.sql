-- Version 003: when each task's stats were last reset (ms since epoch, like
-- created_at; NULL = never). The client's stats count occurrences from
-- then on and the reset clears the measured focus/timer time -- the task's
-- own history (which occurrences were done when) is never touched.

ALTER TABLE atodo.tasks ADD COLUMN stats_reset_at BIGINT;
