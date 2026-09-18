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
  pendingReschedules: row.pending_reschedules,
  endDate: row.end_date,
  frequency: row.frequency,
  completions: row.completions,
  dismissed: row.dismissed,
  markedFailed: row.marked_failed,
  createdAt: Number(row.created_at),
  timer: row.timer,
  log: row.log,
  comments: row.comments,
 };
}

router.get('/', asyncHandler(async (req, res) => {
 const { rows } = await db.query(
  'SELECT * FROM atodo.tasks WHERE account_id = $1 ORDER BY created_at ASC',
  [req.atodoAuth.id]
 );
 res.json(rows.map(toTask));
}));

router.put('/', asyncHandler(async (req, res) => {
 if (!Array.isArray(req.body)) return res.status(400).send('Expected an array of tasks');

 const client = await db.getClient();
 try {
  await client.query('BEGIN');
  await client.query('DELETE FROM atodo.tasks WHERE account_id = $1', [req.atodoAuth.id]);

  for (const task of req.body) {
   await client.query(
    `INSERT INTO atodo.tasks (
      account_id, id, task_id, series_id, series_name, name, description, details,
      due_date, due_time, all_day, appointment, passive, recur_until_completed,
      pending_reschedules, end_date, frequency, completions, dismissed, marked_failed,
      created_at, timer, log, comments
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
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
     task.recurUntilCompleted,
     task.pendingReschedules ?? [],
     task.endDate ?? null,
     JSON.stringify(task.frequency),
     JSON.stringify(task.completions ?? {}),
     JSON.stringify(task.dismissed ?? {}),
     JSON.stringify(task.markedFailed ?? {}),
     task.createdAt,
     task.timer ? JSON.stringify(task.timer) : null,
     JSON.stringify(task.log ?? []),
     JSON.stringify(task.comments ?? []),
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

 const { rows } = await db.query(
  'SELECT * FROM atodo.tasks WHERE account_id = $1 ORDER BY created_at ASC',
  [req.atodoAuth.id]
 );
 res.json(rows.map(toTask));
}));

module.exports = router;
