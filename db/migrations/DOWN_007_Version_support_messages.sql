-- Reverts version 007: contact submissions forget where they came from, the
-- A-To-Do account that sent them, and their diagnostic context. (A-To-Do's
-- support messages themselves stay, as plain contact submissions.)

ALTER TABLE contact_submissions
    DROP COLUMN context,
    DROP COLUMN atodo_account_id,
    DROP COLUMN source;
