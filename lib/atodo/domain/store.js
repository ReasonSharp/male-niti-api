// Loads an account's tasks and occurrences into an AccountState and writes
// back only what an action changed (see account.js).
//
// Rows are loaded "full" (notes and activity log included) for the tasks a
// request needs them for -- the ones an action touches, the focused one --
// and "light" (state only, notes and log as LightLists of the right length,
// see lists.js) for every other, so neither reads nor actions pull the whole
// account's notes and logs out of the database. On save, the store compares
// each row with how it was loaded: new rows are inserted, gone ones deleted,
// changed ones updated -- a light row's notes/log only ever by appending.
//
// Actions run under the account's row lock (`lock: true`), so two requests
// changing the same account are applied one after the other instead of
// overwriting each other.

const { AccountState } = require('./account');
const { LightList, isLight, lightAppends } = require('./lists');
const { migrateToSingleRecordTasks, normalizeTasks } = require('./migrate');
const { SUBSCRIPTION_PROMPT_TASK_ID } = require('./account');

const TASK_FIELDS = ['taskId', 'seriesId', 'seriesName', 'name', 'description', 'details', 'dueDate', 'dueTime', 'allDay', 'appointment', 'passive', 'recurUntilCompleted', 'endDate', 'frequency', 'timeZone', 'createdAt', 'statsResetAt'];
const OCCURRENCE_FIELDS = ['taskId', 'occurrenceDate', 'pendingReschedules', 'status', 'resolvedAt', 'dismissed', 'manual', 'overrides', 'details', 'focusedSeconds', 'timerSeconds', 'timer'];

const num = (v) => (v === null || v === undefined ? null : Number(v));

function lists(row, full) {
 return full
  ? { log: row.log || [], comments: row.comments || [] }
  : { log: LightList.fromCount(row.log_count), comments: LightList.fromCount(row.comments_count) };
}

function toTask(row, full) {
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
  timeZone: row.time_zone,
  createdAt: num(row.created_at),
  statsResetAt: num(row.stats_reset_at),
  ...lists(row, full),
 };
}

function toOccurrence(row, full) {
 return {
  id: row.id,
  taskId: row.task_id,
  occurrenceDate: row.occurrence_date,
  pendingReschedules: row.pending_reschedules || [],
  status: row.status,
  resolvedAt: num(row.resolved_at),
  dismissed: row.dismissed,
  manual: row.manual,
  overrides: row.overrides,
  details: row.details,
  focusedSeconds: row.focused_seconds,
  timerSeconds: row.timer_seconds,
  timer: row.timer,
  ...lists(row, full),
 };
}

// What a row was when loaded, to tell later whether it changed.
const snapshotOf = (row, fields) => JSON.stringify(fields.map((f) => row[f] ?? null));

const subscriptionIsActive = (account, nowMs) =>
 !!account.subscription_plan && !!account.subscription_expires_at && new Date(account.subscription_expires_at).getTime() > nowMs;

// fullTaskIds: taskIds to load in full, or 'all'. Returns
// { state, account, snapshot } -- pass the snapshot back to saveState.
async function loadState(client, accountId, { clock, fullTaskIds = [], lock = false }) {
 const { rows: [account] } = await client.query(`SELECT * FROM atodo.accounts WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [accountId]);
 if (!account) return null;

 // Old-format data (several records per task, per-occurrence overrides) is
 // migrated in full first -- the client used to do this on every load.
 const { rows: [{ fragments }] } = await client.query(
  `SELECT EXISTS (SELECT 1 FROM atodo.tasks WHERE account_id = $1 GROUP BY task_id HAVING count(*) > 1)
       OR EXISTS (SELECT 1 FROM atodo.occurrences WHERE account_id = $1 AND overrides IS NOT NULL) AS fragments`,
  [accountId]
 );
 const all = fullTaskIds === 'all' || fragments;
 const full = all ? [] : [...new Set(fullTaskIds.filter(Boolean))];
 const activeTask = account.active_task_id
  ? (await client.query('SELECT task_id FROM atodo.tasks WHERE account_id = $1 AND id = $2', [accountId, account.active_task_id])).rows[0]
  : null;
 if (activeTask) full.push(activeTask.task_id);

 const listColumns = (alias) => `
   CASE WHEN $2 OR ${alias}.task_id = ANY($3) THEN ${alias}.log END AS log,
   CASE WHEN $2 OR ${alias}.task_id = ANY($3) THEN ${alias}.comments END AS comments,
   jsonb_array_length(${alias}.log) AS log_count,
   jsonb_array_length(${alias}.comments) AS comments_count,
   ($2 OR ${alias}.task_id = ANY($3)) AS full`;
 const [{ rows: taskRows }, { rows: occurrenceRows }] = await Promise.all([
  client.query(`SELECT t.*, ${listColumns('t')} FROM atodo.tasks t WHERE t.account_id = $1 ORDER BY t.created_at`, [accountId, all, full]),
  client.query(`SELECT o.*, ${listColumns('o')} FROM atodo.occurrences o WHERE o.account_id = $1 ORDER BY o.occurrence_date`, [accountId, all, full]),
 ]);

 const snapshot = { tasks: new Map(), occurrences: new Map(), active: null };
 let tasks = taskRows.map((row) => {
  const task = toTask(row, row.full);
  snapshot.tasks.set(task.id, { values: snapshotOf(task, TASK_FIELDS), log: row.full ? JSON.stringify(task.log) : null, comments: row.full ? JSON.stringify(task.comments) : null });
  return task;
 });
 let occurrences = occurrenceRows.map((row) => {
  const occurrence = toOccurrence(row, row.full);
  snapshot.occurrences.set(occurrence.id, { values: snapshotOf(occurrence, OCCURRENCE_FIELDS), log: row.full ? JSON.stringify(occurrence.log) : null, comments: row.full ? JSON.stringify(occurrence.comments) : null });
  return occurrence;
 });

 // The subscription reminder the client used to store isn't a task any
 // more (views.js shows it) -- dropped here, deleted on save.
 tasks = tasks.filter((t) => t.id !== SUBSCRIPTION_PROMPT_TASK_ID && t.taskId !== SUBSCRIPTION_PROMPT_TASK_ID);
 occurrences = occurrences.filter((o) => o.taskId !== SUBSCRIPTION_PROMPT_TASK_ID);

 let activeTaskId = account.active_task_id;
 if (fragments) {
  const migrated = migrateToSingleRecordTasks(normalizeTasks(tasks), occurrences);
  tasks = migrated.tasks;
  occurrences = migrated.occurrences;
  if (migrated.idMap[activeTaskId]) activeTaskId = migrated.idMap[activeTaskId];
 }

 const state = new AccountState({
  tasks,
  occurrences,
  clock,
  subscriptionActive: subscriptionIsActive(account, clock.nowMs),
  active: { taskId: activeTaskId, occurrenceDate: account.active_occurrence_date, focusSince: num(account.active_focus_since) },
 });
 if (activeTaskId !== account.active_task_id) state.activeChanged = true;
 return { state, account, snapshot };
}

function taskParams(accountId, t) {
 return [
  accountId, t.id, t.taskId, t.seriesId, t.seriesName ?? null, t.name, t.description ?? null, t.details ?? null,
  t.dueDate, t.dueTime ?? null, !!t.allDay, !!t.appointment, !!t.passive, !!t.recurUntilCompleted,
  t.endDate ?? null, JSON.stringify(t.frequency), t.timeZone ?? null, t.createdAt, t.statsResetAt ?? null,
 ];
}

function occurrenceParams(accountId, o) {
 return [
  accountId, o.id, o.taskId, o.occurrenceDate, o.pendingReschedules ?? [], o.status ?? 'pending', o.resolvedAt ?? null,
  !!o.dismissed, !!o.manual, o.overrides ? JSON.stringify(o.overrides) : null, o.details ?? null,
  o.focusedSeconds ?? 0, o.timerSeconds ?? 0, o.timer ? JSON.stringify(o.timer) : null,
 ];
}

// The SET clause for a row's notes/log: whole for a full row, appended for
// a light one; nothing if unchanged.
function listUpdates(row, before, startIndex) {
 const sets = [];
 const params = [];
 for (const field of ['log', 'comments']) {
  const list = row[field];
  if (isLight(list)) {
   const appended = lightAppends(list);
   if (appended) {
    sets.push(`${field} = ${field} || $${startIndex + params.length}::jsonb`);
    params.push(JSON.stringify(appended));
   }
  } else {
   const json = JSON.stringify(list || []);
   if (!before || before[field] !== json) {
    sets.push(`${field} = $${startIndex + params.length}::jsonb`);
    params.push(json);
   }
  }
 }
 return { sets, params };
}

const fullList = (list) => (isLight(list) ? list.appended : list || []);

// Writes back whatever differs from the snapshot. Returns the taskIds whose
// rows changed (for the client to know what to re-fetch).
async function saveState(client, accountId, state, snapshot) {
 const touched = new Set();
 const taskIds = new Set(state.tasks.map((t) => t.id));
 const occurrenceIds = new Set(state.occurrences.map((o) => o.id));

 // Sessions moving to another occurrence go before it's deleted (deleting
 // an occurrence deletes its sessions).
 for (const { from, to } of state.sessionMoves) {
  await client.query('UPDATE atodo.focus_sessions SET occurrence_id = $3 WHERE account_id = $1 AND occurrence_id = $2', [accountId, from, to]);
 }

 // Deletions first (a moved occurrence may take a deleted one's date).
 for (const [id] of snapshot.tasks) {
  if (!taskIds.has(id)) {
   await client.query('DELETE FROM atodo.tasks WHERE account_id = $1 AND id = $2', [accountId, id]);
   touched.add('*');
  }
 }
 for (const [id] of snapshot.occurrences) {
  if (!occurrenceIds.has(id)) {
   const { rows } = await client.query('DELETE FROM atodo.occurrences WHERE account_id = $1 AND id = $2 RETURNING task_id', [accountId, id]);
   if (rows[0]) touched.add(rows[0].task_id);
  }
 }

 for (const t of state.tasks) {
  const before = snapshot.tasks.get(t.id);
  if (!before) {
   await client.query(
    `INSERT INTO atodo.tasks (account_id, id, task_id, series_id, series_name, name, description, details, due_date, due_time,
       all_day, appointment, passive, recur_until_completed, end_date, frequency, time_zone, created_at, stats_reset_at, log, comments)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [...taskParams(accountId, t), JSON.stringify(fullList(t.log)), JSON.stringify(fullList(t.comments))]
   );
   touched.add(t.taskId);
   continue;
  }
  const valuesChanged = before.values !== snapshotOf(t, TASK_FIELDS);
  const { sets, params } = listUpdates(t, before, 20);
  if (!valuesChanged && !sets.length) continue;
  await client.query(
   `UPDATE atodo.tasks SET task_id = $3, series_id = $4, series_name = $5, name = $6, description = $7, details = $8,
      due_date = $9, due_time = $10, all_day = $11, appointment = $12, passive = $13, recur_until_completed = $14,
      end_date = $15, frequency = $16, time_zone = $17, created_at = $18, stats_reset_at = $19${sets.length ? `, ${sets.join(', ')}` : ''}
    WHERE account_id = $1 AND id = $2`,
   [...taskParams(accountId, t), ...params]
  );
  touched.add(t.taskId);
 }

 // Updates before inserts, so a row moving off a date frees it first.
 const inserts = [];
 for (const o of state.occurrences) {
  const before = snapshot.occurrences.get(o.id);
  if (!before) {
   inserts.push(o);
   continue;
  }
  const valuesChanged = before.values !== snapshotOf(o, OCCURRENCE_FIELDS);
  const { sets, params } = listUpdates(o, before, 15);
  if (!valuesChanged && !sets.length) continue;
  await client.query(
   `UPDATE atodo.occurrences SET task_id = $3, occurrence_date = $4, pending_reschedules = $5, status = $6, resolved_at = $7,
      dismissed = $8, manual = $9, overrides = $10, details = $11, focused_seconds = $12, timer_seconds = $13, timer = $14${sets.length ? `, ${sets.join(', ')}` : ''}
    WHERE account_id = $1 AND id = $2`,
   [...occurrenceParams(accountId, o), ...params]
  );
  touched.add(o.taskId);
 }
 for (const o of inserts) {
  await client.query(
   `INSERT INTO atodo.occurrences (account_id, id, task_id, occurrence_date, pending_reschedules, status, resolved_at,
      dismissed, manual, overrides, details, focused_seconds, timer_seconds, timer, comments, log)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
   [...occurrenceParams(accountId, o), JSON.stringify(fullList(o.comments)), JSON.stringify(fullList(o.log))]
  );
  touched.add(o.taskId);
 }

 // Focus/timer sessions: cleared and deleted ones, then new ones (after
 // their occurrence's row exists -- and only if it still does: an
 // occurrence deleted in this same request takes its sessions with it).
 if (state.clearedSessionOccurrenceIds.size) {
  await client.query('DELETE FROM atodo.focus_sessions WHERE account_id = $1 AND occurrence_id = ANY($2)', [accountId, [...state.clearedSessionOccurrenceIds]]);
 }
 if (state.deletedSessionIds.length) {
  await client.query('DELETE FROM atodo.focus_sessions WHERE account_id = $1 AND id = ANY($2::bigint[])', [accountId, state.deletedSessionIds]);
 }
 for (const session of state.newSessions) {
  if (!occurrenceIds.has(session.occurrence.id)) continue;
  await client.query(
   'INSERT INTO atodo.focus_sessions (account_id, occurrence_id, kind, started_at, ended_at, seconds) VALUES ($1, $2, $3, $4, $5, $6)',
   [accountId, session.occurrence.id, session.kind, session.startMs, session.endMs, session.seconds]
  );
  touched.add(session.occurrence.taskId);
 }

 if (state.activeChanged) {
  await client.query(
   'UPDATE atodo.accounts SET active_task_id = $2, active_occurrence_date = $3, active_focus_since = $4 WHERE id = $1',
   [accountId, state.active.taskId, state.active.occurrenceDate, state.active.focusSince]
  );
 }
 return touched;
}

// Replaces an account's tasks and occurrences wholesale (a committed import).
async function replaceAll(client, accountId, tasks, occurrences) {
 await client.query('DELETE FROM atodo.occurrences WHERE account_id = $1', [accountId]);
 await client.query('DELETE FROM atodo.tasks WHERE account_id = $1', [accountId]);
 const empty = { tasks: new Map(), occurrences: new Map() };
 return saveState(client, accountId, { tasks, occurrences, activeChanged: false }, empty);
}

module.exports = { loadState, saveState, replaceAll, toTask, toOccurrence };
