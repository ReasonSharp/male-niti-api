-- Reverts version 016: the texts naming one occurrence in a task's activity
-- log and notes go (the client then shows the texts' keys).

DELETE FROM maleniti.translation_key
WHERE name IN ('sidePanel.logOccurrence', 'sidePanel.noteOccurrence')
  AND brand_id = (SELECT brand_id FROM maleniti.brand WHERE code = 'atodo');
