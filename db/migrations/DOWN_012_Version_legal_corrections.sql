-- Reverts version 012: versions are no longer told apart as changes and
-- corrections (every one then counts as a change).

ALTER TABLE maleniti.legal_publication DROP COLUMN substantial;
