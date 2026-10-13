-- Reverts version 015: the texts of the "Timer paused", "Timer resumed",
-- "Timer expired" and "Unfocused by another task" entries go (such entries
-- then show as written, in English).

DELETE FROM maleniti.translation_key
WHERE name IN ('log.timerPaused', 'log.timerResumed', 'log.timerExpired', 'log.unfocusedByAnotherTask') AND brand_id = (SELECT brand_id FROM maleniti.brand WHERE code = 'atodo');
