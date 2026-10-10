-- Version 012: a legal document's version is either a change or a
-- correction (legal_publication.substantial):
--
--   true   a change to the policy or terms themselves -- made in every
--          language at once (no one can tell which language's version a
--          user agreed to, so they must say the same), every open account
--          emailed about it; the pages' "Last updated" date is the latest
--          one's
--   false  a correction (a typo, a mistranslation) in any languages -- no
--          emails, and "Last updated" stays the last change's
--
-- Every version so far was a change.

ALTER TABLE maleniti.legal_publication ADD COLUMN substantial BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE maleniti.legal_publication ALTER COLUMN substantial DROP DEFAULT;
