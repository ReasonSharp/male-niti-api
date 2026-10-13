-- Reverts version 014: the pattern-change question's texts go, and the
-- Recurrence tab's hint says changes apply from today on again (if
-- unedited since).

DELETE FROM maleniti.translation_key
WHERE name LIKE 'patternChoice.%' AND brand_id = (SELECT brand_id FROM maleniti.brand WHERE code = 'atodo');

UPDATE maleniti.translation t SET text = 'Changes here apply from today on -- past occurrences stay as they were.' FROM maleniti.translation_key k
WHERE k.trid = t.trid AND k.name = 'taskEditor.patternHint' AND t.language_id = 'en' AND t.text = 'A change that would alter past occurrences asks how to apply it: recalculate the past from the new pattern, or apply the new pattern from a date.';
UPDATE maleniti.translation t SET text = 'Promjene ovdje vrijede od danas nadalje -- prošle pojave ostaju kakve jesu.' FROM maleniti.translation_key k
WHERE k.trid = t.trid AND k.name = 'taskEditor.patternHint' AND t.language_id = 'hr' AND t.text = 'Promjena koja bi izmijenila prošle pojave pita kako je primijeniti: preračunati prošlost prema novom uzorku ili primijeniti novi uzorak od određenog datuma.';
