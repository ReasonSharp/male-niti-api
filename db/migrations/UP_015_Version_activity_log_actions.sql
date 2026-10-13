-- Version 015: the activity log records what the user did, one entry per
-- action (see AccountState.logFocusToggle) -- resuming and pausing a timer
-- get entries of their own instead of "Focused"/"Unfocused" -- plus the two
-- things the app does that are worth one: an occurrence losing the focus to
-- another, and a timer stopping by itself. Their texts.

-- One A-To-Do interface text in English and Croatian; only for this script.
CREATE FUNCTION pg_temp.ui(bundle TEXT, name TEXT, en TEXT, hr TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    new_trid INT;
BEGIN
    INSERT INTO maleniti.translation_key (brand_id, bundle, name)
    SELECT brand_id, ui.bundle, ui.name FROM maleniti.brand WHERE code = 'atodo'
    RETURNING trid INTO new_trid;
    INSERT INTO maleniti.translation (trid, language_id, text) VALUES
        (new_trid, 'en', en),
        (new_trid, 'hr', hr);
END;
$$;

SELECT pg_temp.ui('app', 'log.timerPaused', 'Timer paused', 'Mjerač vremena pauziran');
SELECT pg_temp.ui('app', 'log.timerResumed', 'Timer resumed', 'Mjerač vremena nastavljen');
SELECT pg_temp.ui('app', 'log.timerExpired', 'Timer expired', 'Mjerač vremena istekao');
SELECT pg_temp.ui('app', 'log.unfocusedByAnotherTask', 'Unfocused by another task', 'Fokus preuzeo drugi zadatak');
