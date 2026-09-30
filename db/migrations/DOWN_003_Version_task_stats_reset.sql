-- Reverts version 003: forgets every task's stats reset point (the stats
-- then count its whole history again; cleared measured time stays cleared).

ALTER TABLE atodo.tasks DROP COLUMN stats_reset_at;
