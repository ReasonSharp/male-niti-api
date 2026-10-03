-- Reverts version 008: drops staged imports, the per-task time zones (fixed
-- times become fluid again) and the server-side focus session start.

DROP TABLE atodo.import_chunks;
DROP TABLE atodo.imports;
DROP INDEX atodo.occurrences_account_task;
DROP INDEX atodo.tasks_account_task;
ALTER TABLE atodo.accounts DROP COLUMN active_focus_since;
ALTER TABLE atodo.tasks DROP COLUMN time_zone;
