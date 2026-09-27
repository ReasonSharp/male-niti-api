-- Reverts version 002: drops the whole A-To-Do schema -- every account,
-- task and fiscal receipt. Blocked by minAllowedVersion 002 (set by UP_002)
-- -- only reachable if that's deliberately lowered, e.g. on a dev database.

DROP SCHEMA atodo CASCADE;
