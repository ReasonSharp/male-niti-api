const express = require('express');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');

const router = express.Router();

// Mounted at /atodo/v1/tasks behind requireAtodoAuth (see routes/atodo/index.js).

function toTask(row) {
 return {
  id: row.id,
  taskId: row.task_id,
  seriesId: row.series_id,
  seriesName: row.series_name,
  name: row.name,
  description: row.description,
  details: row.details,
  dueDate: row.due_date,
  dueTime: row.due_time,
  allDay: row.all_day,
  appointment: row.appointment,
  passive: row.passive,
  recurUntilCompleted: row.recur_until_completed,
  endDate: row.end_date,
  frequency: row.frequency,
  createdAt: Number(row.created_at),
  log: row.log,
  comments: row.comments,
 };
}

function toOccurrence(row) {
 return {
  id: row.id,
  taskId: row.task_id,
  occurrenceDate: row.occurrence_date,
  pendingReschedules: row.pending_reschedules,
  status: row.status,
  resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
  dismissed: row.dismissed,
  manual: row.manual,
  overrides: row.overrides,
  details: row.details,
  comments: row.comments,
  log: row.log,
  focusedSeconds: row.focused_seconds,
  timerSeconds: row.timer_seconds,
  timer: row.timer,
 };
}

async function fetchAll(queryable, accountId) {
 const [{ rows: taskRows }, { rows: occurrenceRows }] = await Promise.all([
  queryable.query('SELECT * FROM atodo.tasks WHERE account_id = $1 ORDER BY created_at ASC', [accountId]),
  queryable.query('SELECT * FROM atodo.occurrences WHERE account_id = $1 ORDER BY occurrence_date ASC', [accountId]),
 ]);
 return { tasks: taskRows.map(toTask), occurrences: occurrenceRows.map(toOccurrence) };
}

router.get('/', asyncHandler(async (req, res) => {
 res.json(await fetchAll(db, req.atodoAuth.id));
}));

router.put('/', asyncHandler(async (req, res) => {
 const { tasks, occurrences } = req.body || {};
 if (!Array.isArray(tasks) || !Array.isArray(occurrences)) {
  return res.status(400).send('Expected { tasks: [...], occurrences: [...] }');
 }

 const client = await db.getClient();
 try {
  await client.query('BEGIN');

  // Serializes concurrent PUTs for the same account (e.g. a client-side
  // retry racing the original request, or a double-fire save) on a
  // transaction-scoped advisory lock -- without it, two overlapping calls
  // can both pass the DELETEs below seeing the other's not-yet-committed
  // rows as absent, then both try to INSERT the same (account_id, id), and
  // the second genuinely violates the primary key once the first commits.
  // Both tables are replaced under the same lock/transaction so a save can
  // never land tasks without their occurrences (or vice versa).
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [req.atodoAuth.id]);

  await client.query('DELETE FROM atodo.tasks WHERE account_id = $1', [req.atodoAuth.id]);
  await client.query('DELETE FROM atodo.occurrences WHERE account_id = $1', [req.atodoAuth.id]);

  for (const task of tasks) {
   await client.query(
    `INSERT INTO atodo.tasks (
      account_id, id, task_id, series_id, series_name, name, description, details,
      due_date, due_time, all_day, appointment, passive, recur_until_completed,
      end_date, frequency, created_at, log, comments
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     -- A duplicate id within the same request array (a client-side bug,
     -- e.g. a botched export/merge) would otherwise violate the primary
     -- key the same way -- last occurrence in the array wins instead.
     ON CONFLICT (account_id, id) DO UPDATE SET
      task_id = EXCLUDED.task_id,
      series_id = EXCLUDED.series_id,
      series_name = EXCLUDED.series_name,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      details = EXCLUDED.details,
      due_date = EXCLUDED.due_date,
      due_time = EXCLUDED.due_time,
      all_day = EXCLUDED.all_day,
      appointment = EXCLUDED.appointment,
      passive = EXCLUDED.passive,
      recur_until_completed = EXCLUDED.recur_until_completed,
      end_date = EXCLUDED.end_date,
      frequency = EXCLUDED.frequency,
      created_at = EXCLUDED.created_at,
      log = EXCLUDED.log,
      comments = EXCLUDED.comments`,
    [
     req.atodoAuth.id,
     task.id,
     task.taskId,
     task.seriesId,
     task.seriesName ?? null,
     task.name,
     task.description ?? null,
     task.details ?? null,
     task.dueDate,
     task.dueTime ?? null,
     task.allDay,
     task.appointment,
     task.passive,
     task.recurUntilCompleted ?? false,
     task.endDate ?? null,
     JSON.stringify(task.frequency),
     task.createdAt,
     JSON.stringify(task.log ?? []),
     JSON.stringify(task.comments ?? []),
    ]
   );
  }

  for (const occurrence of occurrences) {
   await client.query(
    `INSERT INTO atodo.occurrences (
      account_id, id, task_id, occurrence_date, pending_reschedules, status,
      resolved_at, dismissed, manual, overrides, details, comments, log, focused_seconds, timer_seconds, timer
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (account_id, id) DO UPDATE SET
      task_id = EXCLUDED.task_id,
      occurrence_date = EXCLUDED.occurrence_date,
      pending_reschedules = EXCLUDED.pending_reschedules,
      status = EXCLUDED.status,
      resolved_at = EXCLUDED.resolved_at,
      dismissed = EXCLUDED.dismissed,
      manual = EXCLUDED.manual,
      overrides = EXCLUDED.overrides,
      details = EXCLUDED.details,
      comments = EXCLUDED.comments,
      log = EXCLUDED.log,
      focused_seconds = EXCLUDED.focused_seconds,
      timer_seconds = EXCLUDED.timer_seconds,
      timer = EXCLUDED.timer`,
    [
     req.atodoAuth.id,
     occurrence.id,
     occurrence.taskId,
     occurrence.occurrenceDate,
     occurrence.pendingReschedules ?? [],
     occurrence.status ?? 'pending',
     occurrence.resolvedAt ?? null,
     occurrence.dismissed ?? false,
     occurrence.manual ?? false,
     occurrence.overrides ? JSON.stringify(occurrence.overrides) : null,
     occurrence.details ?? null,
     JSON.stringify(occurrence.comments ?? []),
     JSON.stringify(occurrence.log ?? []),
     occurrence.focusedSeconds ?? 0,
     occurrence.timerSeconds ?? 0,
     occurrence.timer ? JSON.stringify(occurrence.timer) : null,
    ]
   );
  }

  await client.query('COMMIT');
 } catch (err) {
  await client.query('ROLLBACK');
  throw err;
 } finally {
  client.release();
 }

 res.json(await fetchAll(db, req.atodoAuth.id));
}));

module.exports = router;
