const express = require('express');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { prepareImport, applyFreeTierLimits } = require('../../lib/atodo/domain/migrate');
const { replaceAll } = require('../../lib/atodo/domain/store');
const { isValidTimeZone } = require('../../lib/atodo/domain/clock');
const { clockFor } = require('../../lib/atodo/domain/request');

// Mounted at /atodo/v1/imports behind requireAtodoAuth (see routes/atodo/index.js).
//
// A data import (Settings -> Import data), uploaded in pieces so a large
// file neither needs one huge request nor holds up the API:
//   POST   /imports               -> { importId }  (starts one; any earlier
//                                     unfinished import of the account goes)
//   POST   /imports/:id/chunks    { seq, tasks, occurrences } -- whole tasks
//                                     with their occurrences, staged
//   POST   /imports/:id/commit    -> replaces the account's tasks with the
//                                     staged ones, in one transaction
//   DELETE /imports/:id           -- abandons it
// Until the commit nothing about the account changes, so a failed or
// abandoned upload leaves it as it was. Chunks are paced (MIN_CHUNK_INTERVAL_MS
// per import) and capped in number and size; an import not committed within
// an hour expires.

const router = express.Router();

const MAX_CHUNKS = 500;
const MIN_CHUNK_INTERVAL_MS = 200;
const lastChunkAt = new Map(); // importId -> ms, in memory: pacing, not state

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FREQUENCY_TYPES = ['once', 'days', 'weeks', 'months'];

const bad = (res, message) => res.status(400).json({ code: 'VALIDATION_ERROR', message });

// Just enough checking that the rules can't choke on a row: the rest of the
// file's shape is the export's own (see reports.exportData).
function checkTask(t) {
 return t && typeof t === 'object' && typeof (t.taskId || t.id) === 'string' && typeof t.name === 'string'
  && typeof t.dueDate === 'string' && DATE_RE.test(t.dueDate)
  && t.frequency && typeof t.frequency === 'object' && FREQUENCY_TYPES.includes(t.frequency.type)
  && (t.timeZone === undefined || t.timeZone === null || isValidTimeZone(t.timeZone));
}
function checkOccurrence(o) {
 return o && typeof o === 'object' && typeof o.taskId === 'string' && typeof o.occurrenceDate === 'string' && DATE_RE.test(o.occurrenceDate);
}

async function ownImport(importId, accountId) {
 const { rows } = await db.query('SELECT * FROM atodo.imports WHERE id = $1 AND account_id = $2 AND expires_at > now()', [importId, accountId]);
 return rows[0] || null;
}

router.post('/', asyncHandler(async (req, res) => {
 await db.query('DELETE FROM atodo.imports WHERE account_id = $1 OR expires_at <= now()', [req.atodoAuth.id]);
 const { rows } = await db.query('INSERT INTO atodo.imports (account_id) VALUES ($1) RETURNING id', [req.atodoAuth.id]);
 res.status(201).json({ importId: rows[0].id, maxChunks: MAX_CHUNKS });
}));

router.post('/:importId/chunks', asyncHandler(async (req, res) => {
 if (!/^[0-9a-f-]{36}$/.test(req.params.importId)) return res.status(404).json({ code: 'NOT_FOUND', message: 'No such import.' });
 const imp = await ownImport(req.params.importId, req.atodoAuth.id);
 if (!imp) return res.status(404).json({ code: 'NOT_FOUND', message: 'No such import (or it expired).' });
 const now = Date.now();
 const last = lastChunkAt.get(imp.id) || 0;
 if (now - last < MIN_CHUNK_INTERVAL_MS) {
  res.setHeader('Retry-After', '1');
  return res.status(429).json({ code: 'TOO_FAST', message: 'Send import chunks one at a time, a moment apart.' });
 }
 lastChunkAt.set(imp.id, now);
 const { seq, tasks, occurrences } = req.body || {};
 if (!Number.isInteger(seq) || seq < 0 || seq >= MAX_CHUNKS) return bad(res, `seq must be a whole number below ${MAX_CHUNKS}`);
 if (!Array.isArray(tasks) || !Array.isArray(occurrences)) return bad(res, 'tasks and occurrences must be arrays');
 const badTask = tasks.findIndex((t) => !checkTask(t));
 if (badTask >= 0) return bad(res, `tasks[${badTask}] isn't a task this app can import`);
 const badOccurrence = occurrences.findIndex((o) => !checkOccurrence(o));
 if (badOccurrence >= 0) return bad(res, `occurrences[${badOccurrence}] isn't an occurrence this app can import`);
 await db.query(
  `INSERT INTO atodo.import_chunks (import_id, seq, tasks, occurrences) VALUES ($1, $2, $3, $4)
   ON CONFLICT (import_id, seq) DO UPDATE SET tasks = EXCLUDED.tasks, occurrences = EXCLUDED.occurrences`,
  [imp.id, seq, JSON.stringify(tasks), JSON.stringify(occurrences)]
 );
 res.status(204).send();
}));

// Assembles the staged chunks, brings old formats up to date, trims a free
// account's import to its limits, and replaces the account's tasks. Answers
// { taskCount, limited } -- limited: the free plan's limits dropped some.
router.post('/:importId/commit', asyncHandler(async (req, res) => {
 if (!/^[0-9a-f-]{36}$/.test(req.params.importId)) return res.status(404).json({ code: 'NOT_FOUND', message: 'No such import.' });
 const client = await db.getClient();
 try {
  await client.query('BEGIN');
  const { rows: [account] } = await client.query('SELECT * FROM atodo.accounts WHERE id = $1 FOR UPDATE', [req.atodoAuth.id]);
  const { rows: [imp] } = await client.query('SELECT * FROM atodo.imports WHERE id = $1 AND account_id = $2 AND expires_at > now() FOR UPDATE', [req.params.importId, req.atodoAuth.id]);
  if (!account || !imp) {
   await client.query('ROLLBACK');
   return res.status(404).json({ code: 'NOT_FOUND', message: 'No such import (or it expired).' });
  }
  const { rows: chunks } = await client.query('SELECT tasks, occurrences FROM atodo.import_chunks WHERE import_id = $1 ORDER BY seq', [imp.id]);
  const prepared = prepareImport(chunks.flatMap((c) => c.tasks), chunks.flatMap((c) => c.occurrences));
  const nowMs = clockFor(req).nowMs;
  const subscriptionActive = !!account.subscription_plan && !!account.subscription_expires_at && new Date(account.subscription_expires_at).getTime() > nowMs;
  const limitedImport = applyFreeTierLimits(prepared.tasks, prepared.occurrences, subscriptionActive);

  // The file's activity history isn't carried over: each task's starts with
  // its import (the export leaves logs out anyway).
  for (const task of limitedImport.tasks) {
   task.log = [{ message: 'Imported', timestamp: nowMs, occurrenceDate: null }];
   task.comments = Array.isArray(task.comments) ? task.comments : [];
   task.timeZone = task.allDay ? null : task.timeZone || null;
  }
  for (const occurrence of limitedImport.occurrences) {
   occurrence.log = [];
   occurrence.comments = Array.isArray(occurrence.comments) ? occurrence.comments : [];
  }
  await replaceAll(client, req.atodoAuth.id, limitedImport.tasks, limitedImport.occurrences);
  // Nothing imported is focused.
  await client.query('UPDATE atodo.accounts SET active_task_id = NULL, active_occurrence_date = NULL, active_focus_since = NULL WHERE id = $1', [req.atodoAuth.id]);
  await client.query('DELETE FROM atodo.imports WHERE id = $1', [imp.id]);
  await client.query('COMMIT');
  lastChunkAt.delete(imp.id);
  res.json({ taskCount: limitedImport.tasks.length, limited: limitedImport.limited });
 } catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
 } finally {
  client.release();
 }
}));

router.delete('/:importId', asyncHandler(async (req, res) => {
 if (/^[0-9a-f-]{36}$/.test(req.params.importId)) {
  await db.query('DELETE FROM atodo.imports WHERE id = $1 AND account_id = $2', [req.params.importId, req.atodoAuth.id]);
  lastChunkAt.delete(req.params.importId);
 }
 res.status(204).send();
}));

module.exports = router;
