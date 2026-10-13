-- Version 014: a pattern change that would alter a task's past asks the
-- user how to apply it (recalculate the past from the new pattern, or apply
-- it from a date) -- the API refuses it until then (409
-- PATTERN_CHANGE_NEEDS_CHOICE), and never moves a task's due date by
-- itself. The question's texts, and the Recurrence tab's hint saying so
-- (if unedited since).

UPDATE maleniti.translation t SET text = 'A change that would alter past occurrences asks how to apply it: recalculate the past from the new pattern, or apply the new pattern from a date.' FROM maleniti.translation_key k
WHERE k.trid = t.trid AND k.name = 'taskEditor.patternHint' AND t.language_id = 'en' AND t.text = 'Changes here apply from today on -- past occurrences stay as they were.';
UPDATE maleniti.translation t SET text = 'Promjena koja bi izmijenila prošle pojave pita kako je primijeniti: preračunati prošlost prema novom uzorku ili primijeniti novi uzorak od određenog datuma.' FROM maleniti.translation_key k
WHERE k.trid = t.trid AND k.name = 'taskEditor.patternHint' AND t.language_id = 'hr' AND t.text = 'Promjene ovdje vrijede od danas nadalje -- prošle pojave ostaju kakve jesu.';

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

SELECT pg_temp.ui('app', 'patternChoice.title', 'Change the past occurrences?', 'Promijeniti prošle pojave?');
SELECT pg_temp.ui('app', 'patternChoice.introLastRecorded', 'This change would alter which past dates are occurrences of this task. The last past occurrence with something recorded on it (done or failed, notes, measured time…) is {date}.', 'Ova promjena mijenja koji su prošli datumi pojave ovog zadatka. Posljednja prošla pojava na kojoj je nešto zabilježeno (obavljeno ili neuspješno, bilješke, izmjereno vrijeme…) je {date}.');
SELECT pg_temp.ui('app', 'patternChoice.introNothingRecorded', 'This change would alter which past dates are occurrences of this task. Nothing is recorded on any past occurrence.', 'Ova promjena mijenja koji su prošli datumi pojave ovog zadatka. Ni na jednoj prošloj pojavi nije ništa zabilježeno.');
SELECT pg_temp.ui('app', 'patternChoice.how', 'What to do', 'Što učiniti');
SELECT pg_temp.ui('app', 'patternChoice.from', 'Apply the new pattern from a date', 'Primijeni novi uzorak od datuma');
SELECT pg_temp.ui('app', 'patternChoice.recalculate', 'Recalculate the past from the new pattern', 'Preračunaj prošlost prema novom uzorku');
SELECT pg_temp.ui('app', 'patternChoice.fromDate', 'Apply from', 'Primijeni od');
SELECT pg_temp.ui('app', 'patternChoice.recalculateLoses', 'Every past occurrence is deleted. Occurrences with something recorded that will be lost: {count}. To keep them, apply the new pattern from a later date instead.', 'Sve prošle pojave bit će izbrisane. Pojava na kojima je nešto zabilježeno, a koje će se izgubiti: {count}. Da ih zadržite, radije primijenite novi uzorak od kasnijeg datuma.');
SELECT pg_temp.ui('app', 'patternChoice.recalculateLosesNothing', 'Every past occurrence is deleted -- nothing is recorded on any of them.', 'Sve prošle pojave bit će izbrisane -- ni na jednoj nije ništa zabilježeno.');
SELECT pg_temp.ui('app', 'patternChoice.fromLoses', 'Before {date}, the old pattern stays. Past occurrences from {date} on are deleted. Occurrences with something recorded that will be lost: {count}.', 'Prije {date} ostaje stari uzorak. Prošle pojave od {date} nadalje bit će izbrisane. Pojava na kojima je nešto zabilježeno, a koje će se izgubiti: {count}.');
SELECT pg_temp.ui('app', 'patternChoice.fromLosesNothing', 'Before {date}, the old pattern stays. Past occurrences from then on are deleted -- nothing is recorded on them.', 'Prije {date} ostaje stari uzorak. Prošle pojave od tada nadalje bit će izbrisane -- na njima nije ništa zabilježeno.');
SELECT pg_temp.ui('app', 'patternChoice.fromNoLaterThanToday', 'Pick a date no later than today ({date}).', 'Odaberite datum najkasnije danas ({date}).');
SELECT pg_temp.ui('app', 'patternChoice.apply', 'Apply', 'Primijeni');
