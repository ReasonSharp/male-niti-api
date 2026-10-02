-- Reverts version 006: pending registrations forget the plan they were
-- started for (their links then just verify, without continuing to checkout).

ALTER TABLE atodo.pending_registrations DROP COLUMN checkout_plan;
