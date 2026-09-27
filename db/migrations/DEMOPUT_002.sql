-- Demo data for version 002 (pgupgrade --demo): a free account with a few
-- sample tasks, dated relative to today. Log in as demo@a-to-do.test /
-- demo-password. (.test is a reserved domain -- no email can reach it.)

INSERT INTO atodo.accounts (email, password_hash, nickname, language)
VALUES ('demo@a-to-do.test', 'e9e11bb10a4f0d85856696935a16321e:da66fec570484d95ca50b48893ec449b3b746699605bb297ed43454420e5ea9ec58092bee88ef6b0a7cea40d7b4bd6ddb609e3b2067aaa370b608925923f447b', 'Demo', 'en');

INSERT INTO atodo.tasks (account_id, id, task_id, series_id, name, description, due_date, due_time, all_day, appointment, passive, recur_until_completed, end_date, frequency, created_at)
SELECT a.id, t.id, t.id, t.id, t.name, t.description,
       to_char(CURRENT_DATE + t.due_in, 'YYYY-MM-DD'), t.due_time, t.due_time IS NULL, t.appointment, false, false, NULL,
       t.frequency::jsonb, (extract(epoch FROM now()) * 1000)::bigint
FROM atodo.accounts a,
     (VALUES
       ('demo-1', 'Water the plants', 'Every third day', 0, NULL, false, '{"type": "days", "interval": 3}'),
       ('demo-2', 'Team meeting', 'Weekly, Mondays at 10:00', 1 - extract(isodow FROM CURRENT_DATE)::int, '10:00', true, '{"type": "weeks", "interval": 1, "weekdays": [1]}'),
       ('demo-3', 'Pay the electricity bill', 'Monthly', 5, NULL, false, '{"type": "months", "interval": 1, "dayMode": "day"}'),
       ('demo-4', 'Renew passport', 'A one-off task', 14, NULL, false, '{"type": "once"}')
     ) AS t (id, name, description, due_in, due_time, appointment, frequency)
WHERE a.email = 'demo@a-to-do.test';
