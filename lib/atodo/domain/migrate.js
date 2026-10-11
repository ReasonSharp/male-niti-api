// Older A-To-Do data, brought up to the current model -- ported from the
// client's normalizeLoadedTasks/migrateToSingleRecordTasks, which ran on
// every load and import. The server now runs it on an import, and on load
// when an account still holds old-format rows (see store.js).
//
// The old "fragments" model kept several Task records per taskId (a
// recurring task split by a "this and following" edit, a pause, a manual
// extra occurrence), each owning a date range. Per taskId:
//  - the latest-starting recurring record (or the latest one, if none
//    recurs) is kept as THE task;
//  - every date any other record's pattern produced is saved as a row first
//    (a one-off record's date as a `manual` row), so no history is lost;
//    their notes and activity move onto the kept record;
//  - a blank row no record covered (a paused span) is dropped;
//  - a row from a recurUntilCompleted record's range loses its chain if the
//    kept record isn't recurUntilCompleted.
// Also drops every Occurrence.overrides (old "this occurrence only" edits),
// and seeds a recurUntilCompleted task's missing live occurrence.
//
// Exports from before occurrence records (September 2026) go further back:
// each task record kept its per-date state as maps -- see
// convertLegacyOccurrenceMaps, which turns them into rows first.

const Recurrence = require('./recurrence');
const Occurrence = require('./occurrence');
const { uid, nextDay, SUBSCRIPTION_PROMPT_TASK_ID } = require('./account');

// Fills what very old exports can lack.
function normalizeTasks(tasks) {
 tasks.forEach((task, index) => {
  if (!task.seriesId) task.seriesId = uid();
  if (!task.taskId) task.taskId = uid();
  if (!task.id) task.id = task.taskId;
  if (!task.createdAt) task.createdAt = index;
  if (task.timeZone === undefined) task.timeZone = null;
 });
 return tasks;
}

// The oldest format: per-date state as maps on each task record --
// completions / markedFailed / dismissed ({ date: true }), focusLog
// ({ date: { focusedSeconds, timerSeconds } }), timer (with the date it
// ran on, occurrenceDate) and, on a recurUntilCompleted task -- whose
// dueDate was then its live occurrence -- pendingReschedules (the days it
// was carried). Every record's maps become occurrence rows for its taskId
// (merged with any the file already has: done over pending, dismissed if
// any says so, measured time added up), the live occurrence of a
// recurUntilCompleted record included; the maps are then dropped. When
// something was done isn't known (resolvedAt stays null). Mutates the
// arrays; returns whether anything changed.
const LEGACY_MAPS = ['completions', 'markedFailed', 'dismissed', 'focusLog', 'pendingReschedules'];

function convertLegacyOccurrenceMaps(tasks, occurrences) {
 let changed = false;
 const rowFor = (taskId, date) => {
  let row = occurrences.find((o) => o.taskId === taskId && o.occurrenceDate === date);
  if (!row) {
   row = Occurrence.createOccurrence({ id: uid(), taskId, occurrenceDate: date });
   occurrences.push(row);
  }
  return row;
 };
 const datesOf = (map) => (map && typeof map === 'object' && !Array.isArray(map)
  ? Object.keys(map).filter((d) => map[d] && /^\d{4}-\d{2}-\d{2}$/.test(d))
  : []);
 for (const task of tasks) {
  const legacy = LEGACY_MAPS.some((field) => task[field] != null) || task.timer !== undefined;
  if (!legacy) continue;
  changed = true;
  for (const date of datesOf(task.completions)) {
   const row = rowFor(task.taskId, date);
   if (row.status === 'pending') row.status = 'completed';
  }
  for (const date of datesOf(task.markedFailed)) {
   const row = rowFor(task.taskId, date);
   if (row.status === 'pending' || task.passive) row.status = 'failed';
  }
  for (const date of datesOf(task.dismissed)) rowFor(task.taskId, date).dismissed = true;
  for (const date of datesOf(task.focusLog)) {
   const entry = task.focusLog[date] || {};
   const row = rowFor(task.taskId, date);
   row.focusedSeconds = (row.focusedSeconds || 0) + Math.max(0, Math.round(Number(entry.focusedSeconds) || 0));
   row.timerSeconds = (row.timerSeconds || 0) + Math.max(0, Math.round(Number(entry.timerSeconds) || 0));
  }
  if (task.timer && typeof task.timer === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(task.timer.occurrenceDate || '')) {
   const row = rowFor(task.taskId, task.timer.occurrenceDate);
   if (!row.timer) {
    const { occurrenceDate, ...timer } = task.timer;
    row.timer = timer;
   }
  }
  if (task.recurUntilCompleted) {
   const live = rowFor(task.taskId, task.dueDate);
   const carried = Array.isArray(task.pendingReschedules) ? task.pendingReschedules.filter((d) => typeof d === 'string' && d > task.dueDate) : [];
   if (carried.length) live.pendingReschedules = [...new Set([...(live.pendingReschedules || []), ...carried])].sort();
  }
  for (const field of LEGACY_MAPS) delete task[field];
  delete task.timer;
 }
 return changed;
}

// A recurUntilCompleted task always has its live occurrence: a pending row
// on or after its latest resolved one. Lacking it -- no rows at all, or
// only resolved ones (older data, a hand-edited file) -- it gets one: on
// its due date, or the next cycle after its latest completion. Returns the
// rows to add.
function seedLiveOccurrences(tasks, occurrences) {
 const seeded = [];
 const done = new Set();
 for (const task of tasks) {
  if (!task.recurUntilCompleted || done.has(task.taskId)) continue;
  done.add(task.taskId);
  const rows = occurrences.filter((o) => o.taskId === task.taskId);
  const resolvedDates = rows.filter((o) => o.status !== 'pending').map((o) => {
   const chain = o.pendingReschedules || [];
   return chain.length ? chain[chain.length - 1] : o.occurrenceDate;
  }).sort();
  const lastResolved = resolvedDates[resolvedDates.length - 1] || null;
  if (rows.some((o) => o.status === 'pending' && (!lastResolved || o.occurrenceDate >= lastResolved))) continue;
  const date = lastResolved ? Recurrence.nextRecurUntilCompletedDueDate(task, lastResolved) : task.dueDate;
  if (!date || rows.some((o) => o.occurrenceDate === date)) continue;
  seeded.push(Occurrence.createOccurrence({ id: uid(), taskId: task.taskId, occurrenceDate: date }));
 }
 return seeded;
}

// What a file can hold that the database can't take, or the rules
// shouldn't: a task record twice (the first is kept), occurrences of a
// task the file doesn't have, two rows for one task and date (merged: done
// or failed over pending, dismissed if either is, notes and measured time
// together), an occurrence id used twice (a fresh one), an unknown status
// (pending), and a timer still running -- nothing is focused after an
// import, so it's stopped where its last checkpoint left it. Mutates;
// returns the tidied arrays.
const STATUSES = ['pending', 'completed', 'failed'];

function tidyImport(tasks, occurrences) {
 const taskIds = new Set();
 const recordIds = new Set();
 const keptTasks = tasks.filter((t) => {
  if (recordIds.has(t.id)) return false;
  recordIds.add(t.id);
  taskIds.add(t.taskId);
  return true;
 });
 const byKey = new Map();
 const rowIds = new Set();
 const keptRows = [];
 for (const o of occurrences) {
  if (!taskIds.has(o.taskId)) continue;
  if (!STATUSES.includes(o.status)) o.status = 'pending';
  if (!Array.isArray(o.pendingReschedules)) o.pendingReschedules = [];
  if (!Array.isArray(o.comments)) o.comments = [];
  if (o.timer && typeof o.timer === 'object' && o.timer.runningSince != null) o.timer = { ...o.timer, runningSince: null };
  const key = `${o.taskId}|${o.occurrenceDate}`;
  const first = byKey.get(key);
  if (first) {
   if (first.status === 'pending' && o.status !== 'pending') {
    first.status = o.status;
    first.resolvedAt = o.resolvedAt ?? null;
   }
   first.dismissed = !!(first.dismissed || o.dismissed);
   first.comments = [...first.comments, ...o.comments];
   first.focusedSeconds = (first.focusedSeconds || 0) + (o.focusedSeconds || 0);
   first.timerSeconds = (first.timerSeconds || 0) + (o.timerSeconds || 0);
   if (!first.timer && o.timer) first.timer = o.timer;
   if (!first.details && o.details) first.details = o.details;
   first.pendingReschedules = [...new Set([...first.pendingReschedules, ...o.pendingReschedules])].sort();
   continue;
  }
  if (!o.id || rowIds.has(o.id)) o.id = uid();
  rowIds.add(o.id);
  byKey.set(key, o);
  keptRows.push(o);
 }
 return { tasks: keptTasks, occurrences: keptRows };
}

// Pure over the arrays given; returns the kept tasks and the occurrences,
// whether anything changed, and a map from every dropped record's id to the
// kept one's (for the focused task).
function migrateToSingleRecordTasks(taskList, occurrenceList) {
 let changed = false;
 const idMap = {};
 for (const o of occurrenceList) {
  if (o.overrides) {
   o.overrides = null;
   changed = true;
  }
 }
 const groups = new Map();
 for (const t of taskList) {
  if (!groups.has(t.taskId)) groups.set(t.taskId, []);
  groups.get(t.taskId).push(t);
 }
 const dropped = new Set();
 const hasRow = (taskId, d) => occurrenceList.some((o) => o.taskId === taskId && o.occurrenceDate === d);
 for (const [taskId, group] of groups) {
  if (group.length < 2) continue;
  changed = true;
  const byStart = group.slice().sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const recurring = byStart.filter((f) => f.frequency.type !== 'once');
  const pool = recurring.length ? recurring : byStart;
  const kept = pool[pool.length - 1];
  const covers = (f, d) => (f.frequency.type === 'once' ? d === f.dueDate : f.dueDate <= d && (!f.endDate || f.endDate >= d));

  for (const f of byStart) {
   if (f === kept) continue;
   if (f.frequency.type === 'once') {
    if (!hasRow(taskId, f.dueDate)) occurrenceList.push(Occurrence.createOccurrence({ id: uid(), taskId, occurrenceDate: f.dueDate, manual: true }));
   } else if (!f.recurUntilCompleted) {
    const lastISO = f.endDate && f.endDate < kept.dueDate ? f.endDate : nextDay(kept.dueDate, -1);
    let cursor = f.dueDate;
    for (let i = 0; i < 3660 && cursor <= lastISO; i++) {
     if (Recurrence.occursOn(f, cursor) && !Occurrence.isDateExcluded(occurrenceList, taskId, cursor) && !hasRow(taskId, cursor)) {
      occurrenceList.push(Occurrence.createOccurrence({ id: uid(), taskId, occurrenceDate: cursor }));
     }
     cursor = nextDay(cursor);
    }
   }
   kept.log = [...(f.log || []), ...(kept.log || [])];
   kept.comments = [...(f.comments || []), ...(kept.comments || [])];
   if (f.createdAt < kept.createdAt) kept.createdAt = f.createdAt;
   if (!kept.seriesName && f.seriesName) kept.seriesName = f.seriesName;
   idMap[f.id] = kept.id;
   dropped.add(f);
  }

  for (let i = occurrenceList.length - 1; i >= 0; i--) {
   const o = occurrenceList[i];
   if (o.taskId !== taskId) continue;
   const owner = byStart.find((f) => covers(f, o.occurrenceDate));
   if (!owner && Occurrence.isBlankOccurrence(o)) {
    occurrenceList.splice(i, 1);
    continue;
   }
   if (owner && owner.recurUntilCompleted && !kept.recurUntilCompleted && o.pendingReschedules && o.pendingReschedules.length) o.pendingReschedules = [];
  }
 }
 const keptTasks = dropped.size ? taskList.filter((t) => !dropped.has(t)) : taskList;
 const seeded = seedLiveOccurrences(keptTasks, occurrenceList);
 if (seeded.length) {
  occurrenceList.push(...seeded);
  changed = true;
 }
 return { tasks: keptTasks, occurrences: occurrenceList, changed, idMap };
}

// Imported data, ready to store: normalized, migrated, without the stored
// subscription reminder the client used to keep (the server shows its own).
function prepareImport(tasks, occurrences) {
 const realTasks = normalizeTasks(tasks.filter((t) => t && t.id !== SUBSCRIPTION_PROMPT_TASK_ID && t.taskId !== SUBSCRIPTION_PROMPT_TASK_ID));
 const realOccurrences = occurrences.filter((o) => o && o.taskId !== SUBSCRIPTION_PROMPT_TASK_ID);
 convertLegacyOccurrenceMaps(realTasks, realOccurrences);
 const tidy = tidyImport(realTasks, realOccurrences);
 return migrateToSingleRecordTasks(tidy.tasks, tidy.occurrences);
}

// A free or lapsed account's import is trimmed to what it could have
// created itself: the first FREE_TASK_LIMITS one-off and recurring tasks (by
// creation) and NOTES_PER_TASK_LIMIT notes per task (task- and
// occurrence-level pooled, earliest kept). Returns { tasks, occurrences,
// limited }.
function applyFreeTierLimits(tasks, occurrences, subscriptionActive) {
 if (subscriptionActive) return { tasks, occurrences, limited: false };
 const { FREE_TASK_LIMITS, NOTES_PER_TASK_LIMIT } = require('./account');
 const isRecurring = (taskId) => tasks.some((t) => t.taskId === taskId && t.frequency.type !== 'once');
 const createdAt = (taskId) => Math.min(...tasks.filter((t) => t.taskId === taskId).map((t) => t.createdAt));
 const taskIds = [...new Set(tasks.map((t) => t.taskId))];
 const byCreated = (a, b) => createdAt(a) - createdAt(b);
 const once = taskIds.filter((id) => !isRecurring(id)).sort(byCreated);
 const recurring = taskIds.filter((id) => isRecurring(id)).sort(byCreated);
 const allowed = new Set([...once.slice(0, FREE_TASK_LIMITS.once), ...recurring.slice(0, FREE_TASK_LIMITS.recurring)]);
 const keptTasks = tasks.filter((t) => allowed.has(t.taskId));
 const keptOccurrences = occurrences.filter((o) => allowed.has(o.taskId));
 let limited = keptTasks.length < tasks.length;

 const entriesByTaskId = {};
 for (const record of [...keptTasks, ...keptOccurrences]) {
  for (const comment of record.comments || []) (entriesByTaskId[record.taskId] ||= []).push(comment);
 }
 for (const taskId in entriesByTaskId) {
  const dropped = new Set(entriesByTaskId[taskId].sort((a, b) => a.timestamp - b.timestamp).slice(NOTES_PER_TASK_LIMIT));
  if (!dropped.size) continue;
  limited = true;
  for (const record of [...keptTasks, ...keptOccurrences]) {
   if (record.taskId === taskId && record.comments) record.comments = record.comments.filter((c) => !dropped.has(c));
  }
 }
 return { tasks: keptTasks, occurrences: keptOccurrences, limited };
}

module.exports = { normalizeTasks, convertLegacyOccurrenceMaps, tidyImport, seedLiveOccurrences, migrateToSingleRecordTasks, prepareImport, applyFreeTierLimits };
