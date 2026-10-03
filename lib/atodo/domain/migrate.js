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
 const seeded = Occurrence.missingLiveOccurrences(keptTasks, occurrenceList, uid);
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
 return migrateToSingleRecordTasks(realTasks, realOccurrences);
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

module.exports = { normalizeTasks, migrateToSingleRecordTasks, prepareImport, applyFreeTierLimits };
