-- Version 007: A-To-Do's support form (POST /atodo/v1/support) files its
-- messages with the website's own contact form submissions, so the admin
-- app's Contact tab shows both:
--   source           -- where it came from: 'maleniti' (the website's form)
--                       or 'atodo' (A-To-Do's support page)
--   atodo_account_id -- the A-To-Do account that sent it, if logged in
--                       (detached if the account is deleted)
--   context          -- what helps diagnose it: the client's version, page,
--                       language and browser

ALTER TABLE contact_submissions
    ADD COLUMN source TEXT NOT NULL DEFAULT 'maleniti' CHECK (source IN ('maleniti', 'atodo')),
    ADD COLUMN atodo_account_id UUID REFERENCES atodo.accounts (id) ON DELETE SET NULL,
    ADD COLUMN context JSONB;
