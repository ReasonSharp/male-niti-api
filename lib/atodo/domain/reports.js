// Stats, Manage Tasks' months and series, and the data export -- computed
// from an AccountState, ported from the client's showStatsModal,
// computeSeriesMonthGroups and collectUserDataExport.

const Recurrence = require('./recurrence');
const { nextDay } = require('./account');
const { monthKeyOf, addMonthsToKey } = require('./views');

// ---------------------------------------------------------------------------
// Stats -- one task, a series, or all tasks
// ---------------------------------------------------------------------------

// scope: { kind: 'task', taskId } | { kind: 'series', seriesId } | { kind: 'all' }
function statsRecords(state, scope) {
 if (scope.kind === 'task') return state.tasks.filter((t) => t.taskId === scope.taskId);
 if (scope.kind === 'series') return state.tasksInSeries(scope.seriesId);
 return state.tasks;
}

function stats(state, scope) {
 const records = statsRecords(state, scope);
 const aggregate = scope.kind !== 'task';
 const recurring = aggregate || records.length > 1 || records.some((t) => t.frequency.type !== 'once');
 const taskIds = new Set(records.map((t) => t.taskId));
 const byTaskId = new Map(records.map((t) => [t.taskId, t]));

 // "Since the reset on ...", when every task in scope was reset together.
 const resets = new Set(records.map((r) => r.statsResetAt || null));
 const [onlyReset] = resets;

 let occurrencesToDate = 0;
 if (recurring) {
  for (const t of records) {
   const cutoff = nextDay(state.todayFor(t));
   state.forEachOccurrenceBefore(t, cutoff, (dateISO) => {
    if (state.countsTowardStats(t, dateISO)) occurrencesToDate++;
   });
  }
 }

 let completed = 0;
 let totalFocusedSeconds = 0;
 let totalTimerSeconds = 0;
 const byDate = new Map();
 for (const o of state.occurrences) {
  if (!taskIds.has(o.taskId)) continue;
  const task = byTaskId.get(o.taskId);
  if (o.status === 'completed' && state.countsTowardStats(task, o.occurrenceDate)) completed++;
  const focused = o.focusedSeconds || 0;
  const timer = o.timerSeconds || 0;
  if (!focused && !timer) continue;
  const bucket = byDate.get(o.occurrenceDate) || { date: o.occurrenceDate, focusedSeconds: 0, timerSeconds: 0 };
  bucket.focusedSeconds += focused;
  bucket.timerSeconds += timer;
  byDate.set(o.occurrenceDate, bucket);
  totalFocusedSeconds += focused;
  totalTimerSeconds += timer;
 }

 return {
  scope: scope.kind,
  title: scope.kind === 'task' ? (records[0] ? records[0].name : '') : scope.kind === 'series' ? state.getSeriesName(scope.seriesId) : null,
  since: resets.size === 1 && onlyReset ? onlyReset : null,
  aggregate,
  recurring,
  taskCount: taskIds.size,
  occurrencesToDate,
  completed,
  completionRate: occurrencesToDate > 0 ? Math.round((completed / occurrencesToDate) * 100) : 0,
  totalFocusedSeconds,
  totalTimerSeconds,
  perDate: [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)),
 };
}

// ---------------------------------------------------------------------------
// Manage Tasks: which series have occurrences in which months
// ---------------------------------------------------------------------------

const MAX_SCAN_MONTHS = 1200;

function taskOccursInMonth(state, task, monthKey) {
 const [year, month] = monthKey.split('-').map(Number);
 const startISO = `${monthKey}-01`;
 const endExclusiveISO = nextDay(startISO, Recurrence.daysInMonth(year, month - 1));
 if (task.recurUntilCompleted) {
  let found = false;
  state.allRecurUntilCompletedDatesInRange(task, startISO, endExclusiveISO, () => {
   found = true;
  });
  return found;
 }
 if (state.occursOnDate(task, startISO)) return true;
 const occurrence = state.nextOccurrenceAfterDate(task, nextDay(startISO, -1));
 return !!occurrence && occurrence < endExclusiveISO;
}

// [{ month, series: [{ seriesId, name, taskCount, mixed }] }], newest month
// first. Each task is scanned from its due date's month to its end date's
// (or the current month, if open-ended).
function manageMonths(state) {
 const currentMonthKey = monthKeyOf(state.clock.todayISO);
 const months = new Map();
 for (const task of state.tasks) {
  const startMonth = monthKeyOf(task.dueDate);
  const endMonth = task.endDate ? monthKeyOf(task.endDate) : startMonth > currentMonthKey ? startMonth : currentMonthKey;
  let cursor = startMonth;
  for (let i = 0; i < MAX_SCAN_MONTHS && cursor <= endMonth; i++) {
   if (taskOccursInMonth(state, task, cursor)) {
    if (!months.has(cursor)) months.set(cursor, new Set());
    months.get(cursor).add(task.seriesId);
   }
   cursor = addMonthsToKey(cursor, 1);
  }
 }
 return [...months.keys()].sort().reverse().map((month) => ({
  month,
  series: [...months.get(month)]
   .map((seriesId) => {
    const members = state.tasksInSeries(seriesId);
    return { seriesId, name: state.getSeriesName(seriesId), taskCount: new Set(members.map((t) => t.taskId)).size, mixed: state.isMixedSeries(seriesId) };
   })
   .sort((a, b) => a.name.localeCompare(b.name)),
 }));
}

// A task's own fields, for the client's forms and schedule descriptions.
function taskSummary(state, task) {
 return {
  taskId: task.taskId,
  seriesId: task.seriesId,
  name: task.name,
  label: state.displayName(task),
  description: task.description || '',
  details: task.details || '',
  dueDate: task.dueDate,
  dueTime: task.dueTime,
  allDay: !!task.allDay,
  appointment: !!task.appointment,
  passive: !!task.passive,
  recurUntilCompleted: !!task.recurUntilCompleted,
  endDate: task.endDate,
  frequency: task.frequency,
  timeZone: task.timeZone || null,
  createdAt: task.createdAt,
  statsResetAt: task.statsResetAt,
  locked: !state.canCompleteOrNoteTask(task),
  paused: state.currentPause(task),
 };
}

function seriesDetail(state, seriesId) {
 const members = state.tasksInSeries(seriesId).slice().sort((a, b) => a.dueDate.localeCompare(b.dueDate));
 return {
  seriesId,
  name: state.getSeriesName(seriesId),
  mixed: state.isMixedSeries(seriesId),
  tasks: members.map((t) => taskSummary(state, t)),
 };
}

// ---------------------------------------------------------------------------
// The data export (Settings -> Download my data)
// ---------------------------------------------------------------------------

const EXPORT_VERSION = 1;

// Same file the client used to build itself, activity logs left out (they're
// this account's own history, not data to carry over).
function exportData(state, account, profile) {
 const withoutLog = ({ log, ...rest }) => rest;
 const activeTask = state.taskByRecordId(state.active.taskId);
 return {
  version: EXPORT_VERSION,
  exportedAt: new Date(state.nowMs).toISOString(),
  tasks: state.tasks.map(withoutLog),
  occurrences: state.occurrences.map(withoutLog),
  userProfile: profile,
  activeTaskId: activeTask ? activeTask.id : null,
  activeOccurrenceDate: activeTask ? state.active.occurrenceDate : null,
  todoViewMode: account.todo_view_mode,
 };
}

module.exports = { stats, statsRecords, manageMonths, taskSummary, seriesDetail, exportData };
