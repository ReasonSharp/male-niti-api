-- Version 016: in a task's side panel, an activity log entry about one
-- occurrence reads "15 Oct occurrence: Marked done" ("Pojava na dan 15. lis:
-- Označeno kao obavljeno") rather than "Task name, 15 Oct -- Marked done", and
-- a note on one occurrence is headed "15 Oct occurrence · ..." ("Pojava na dan
-- 15. lis · ...") rather than "Task name, 15 Oct · ...". Their texts.

INSERT INTO maleniti.translation_key (brand_id, bundle, name)
SELECT brand_id, 'app', v.name
FROM maleniti.brand
CROSS JOIN (VALUES ('sidePanel.logOccurrence'), ('sidePanel.noteOccurrence')) AS v(name)
WHERE code = 'atodo';

INSERT INTO maleniti.translation (trid, language_id, text)
SELECT k.trid, v.language_id, v.text
FROM maleniti.translation_key k
JOIN maleniti.brand b ON b.brand_id = k.brand_id AND b.code = 'atodo'
JOIN (VALUES
  ('sidePanel.logOccurrence', 'en', '{date} occurrence: {activity}'),
  ('sidePanel.logOccurrence', 'hr', 'Pojava na dan {date}: {activity}'),
  ('sidePanel.noteOccurrence', 'en', '{date} occurrence'),
  ('sidePanel.noteOccurrence', 'hr', 'Pojava na dan {date}')
) AS v(name, language_id, text) ON v.name = k.name;
