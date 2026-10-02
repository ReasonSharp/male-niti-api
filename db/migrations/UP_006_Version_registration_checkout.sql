-- Version 006: a registration started from the landing page's pricing
-- buttons remembers the plan the visitor chose, so the emailed verification
-- link brings them back to checkout for it -- verifying logs them in (see
-- POST /atodo/v1/auth/verify-email). NULL = an ordinary registration.

ALTER TABLE atodo.pending_registrations
    ADD COLUMN checkout_plan TEXT CHECK (checkout_plan IN ('monthly', 'annual'));
