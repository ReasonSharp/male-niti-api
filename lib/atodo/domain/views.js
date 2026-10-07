// What A-To-Do shows, computed from an AccountState -- ported from the
// client's computeTodoDisplayItems / computeAllTasksItems /
// computeNextRecurrenceItems, buildTodoItemRow and showTodoContextMenu (what
// a row may do), buildTodayAgendaItems and listTaskOccurrences.
//
// Each task is evaluated on its own clock (a fixed-zone task on its zone's,
// see clock.js), giving occurrences on that task's own dates; each item is
// then placed on the user's local day its due moment falls on (displayDate).
// The views are month-bound (pending, all) or not (next-recurrence); a
// request asks for one local day (dayView).

const Recurrence = require('./recurrence');
const { zonedToLocal } = require('./clock');
const { nextDay } = require('./account');

const monthKeyOf = (iso) => iso.slice(0, 7);
function addMonthsToKey(monthKey, n) {
 const [y, m] = monthKey.split('-').map(Number);
 const d = new Date(Date.UTC(y, m - 1 + n, 1));
 return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthBounds(monthKey) {
 const [y, m] = monthKey.split('-').map(Number);
 const startISO = `${monthKey}-01`;
 const endExclusiveISO = nextDay(startISO, Recurrence.daysInMonth(y, m - 1));
 return { startISO, endExclusiveISO };
}

// Where an occurrence shows for the user: their local date and time of its
// due moment. Only a timed task with its own zone moves; everything else
// shows on its own date.
function placement(state, task, occurrenceDate) {
 if (task.allDay || !task.timeZone || task.timeZone === state.clock.timeZone) {
  return { displayDate: occurrenceDate, dueTime: task.allDay ? null : task.dueTime, zoneDueTime: null };
 }
 const local = zonedToLocal(occurrenceDate, task.dueTime, task.timeZone, state.clock.timeZone);
 return { displayDate: local.dateISO, dueTime: local.time, zoneDueTime: task.dueTime };
}

// A fixed-zone task's own dates reach a day either side of the user's.
const rangePadding = (state, task) => (task.allDay || !task.timeZone || task.timeZone === state.clock.timeZone ? 0 : 1);

// ---------------------------------------------------------------------------
// The three views, for one month (raw items: task, occurrenceDate and state)
// ---------------------------------------------------------------------------

// Pending/overdue: every overdue or failed occurrence since the start of the
// month (dismissed or not -- a standing audit, not a decluttered list); in
// the current month also today's and tomorrow's. A past month is all over
// already; a future one has nothing overdue yet.
function pendingItems(state, monthKey) {
 const items = [];
 for (const task of state.tasks) {
  const clock = state.clockFor(task);
  const todayISO = clock.todayISO;
  const tomorrowISO = nextDay(todayISO);
  const pad = rangePadding(state, task);
  const { startISO, endExclusiveISO } = monthBounds(monthKey);
  const currentMonthKey = monthKeyOf(todayISO);
  const isCurrentMonth = monthKey === currentMonthKey;
  const scanCutoffISO = isCurrentMonth ? todayISO : monthKey < currentMonthKey ? endExclusiveISO : startISO;
  state.forEachOccurrenceInRange(task, nextDay(startISO, -pad), scanCutoffISO, (date) => {
   const occurrence = state.findOccurrence(task, date);
   if (state.isCompleted(task, date, occurrence)) return;
   const { overdue, failed } = state.pastDueStatus(task, date, false);
   if (overdue || failed) items.push({ task, occurrenceDate: date, completed: false, overdue, failed, dismissed: !!(occurrence && occurrence.dismissed) });
  });
  if (!isCurrentMonth) continue;
  if (state.occursOnDate(task, todayISO)) {
   const occurrence = state.findOccurrence(task, todayISO);
   const completed = state.isCompleted(task, todayISO, occurrence);
   const { overdue, failed } = state.pastDueStatus(task, todayISO, completed);
   items.push({ task, occurrenceDate: todayISO, completed, overdue, failed, dismissed: !!(occurrence && occurrence.dismissed) });
  }
  if (state.occursOnDate(task, tomorrowISO)) {
   const occurrence = state.findOccurrence(task, tomorrowISO);
   items.push({ task, occurrenceDate: tomorrowISO, completed: false, overdue: false, failed: false, dismissed: !!(occurrence && occurrence.dismissed) });
  }
 }
 return items;
}

// All tasks: every occurrence in the month, whatever its state.
function allItems(state, monthKey) {
 const items = [];
 const { startISO, endExclusiveISO } = monthBounds(monthKey);
 for (const task of state.tasks) {
  const pad = rangePadding(state, task);
  state.forEachOccurrenceInRange(task, nextDay(startISO, -pad), nextDay(endExclusiveISO, pad), (date) => {
   const occurrence = state.findOccurrence(task, date);
   const completed = state.isCompleted(task, date, occurrence);
   const { overdue, failed } = completed ? { overdue: false, failed: false } : state.pastDueStatus(task, date, false);
   items.push({ task, occurrenceDate: date, completed, overdue, failed, dismissed: !!(occurrence && occurrence.dismissed) });
  });
 }
 return items;
}

// Next recurrence: per task, today's occurrence (crossed out once done), its
// still-pending previous one, else a preview of what's next -- plus, after
// 18:00 (the user's), tomorrow's. A completed previous occurrence is shown
// once more and dismissed (the client's 5-second linger did the same).
// A carried-over occurrence just checked off stays in "next recurrence" this
// long (the client keeps the list as it is for a moment after a completion,
// then fetches it again: by then it's gone), and is dismissed after.
const RESOLVED_LINGER_MS = 4000;

function nextRecurrenceItems(state) {
 const items = [];
 for (const task of state.tasks) {
  const todayISO = state.todayFor(task);
  const todayOccurs = state.occursOnDate(task, todayISO);
  let todayPending = false;
  if (todayOccurs) {
   const occurrence = state.findOccurrence(task, todayISO);
   const completed = state.isCompleted(task, todayISO, occurrence);
   if (completed) {
    items.push({ task, occurrenceDate: todayISO, completed: true, overdue: false, failed: false, dismissed: false });
   } else {
    const { overdue, failed } = state.pastDueStatus(task, todayISO, false);
    todayPending = !failed;
    items.push({ task, occurrenceDate: todayISO, completed: false, overdue, failed, dismissed: false });
   }
  }

  const priorDate = state.previousOccurrenceBeforeDate(task, todayISO);
  const priorOccurrence = priorDate ? state.findOccurrence(task, priorDate) : null;
  let priorPending = false;
  if (priorDate && !(priorOccurrence && priorOccurrence.dismissed)) {
   const completed = state.isCompleted(task, priorDate, priorOccurrence);
   const lingering = !!(priorOccurrence && priorOccurrence.resolvedAt != null && state.nowMs - priorOccurrence.resolvedAt < RESOLVED_LINGER_MS);
   if (completed && !lingering) {
    // Done a while ago (or a timed passive one, done when its time passed):
    // off the list for good.
    if (priorOccurrence) priorOccurrence.dismissed = true;
   } else {
    const { overdue, failed } = completed ? { overdue: false, failed: false } : state.pastDueStatus(task, priorDate, false);
    if (!completed) priorPending = !failed;
    items.push({ task, occurrenceDate: priorDate, completed, overdue, failed, dismissed: false });
   }
  }

  if (!todayPending && !priorPending) {
   const recentDate = todayOccurs ? todayISO : priorDate;
   const searchFrom = recentDate == null ? nextDay(todayISO, -1) : recentDate;
   const nextDate = state.nextOccurrenceAfterDate(task, searchFrom);
   if (nextDate) items.push({ task, occurrenceDate: nextDate, completed: false, overdue: false, failed: false, dismissed: false });
  }
 }

 if (state.clock.hour >= 18) {
  for (const task of state.tasks) {
   const tomorrowISO = nextDay(state.todayFor(task));
   const alreadyShown = items.some((i) => i.task === task && i.occurrenceDate === tomorrowISO);
   if (!alreadyShown && state.occursOnDate(task, tomorrowISO)) {
    items.push({ task, occurrenceDate: tomorrowISO, completed: false, overdue: false, failed: false, dismissed: false });
   }
  }
 }
 return items;
}

// ---------------------------------------------------------------------------
// Items as sent to the client
// ---------------------------------------------------------------------------

function kindOf(state, displayDate) {
 const todayISO = state.clock.todayISO;
 if (displayDate < todayISO) return 'carried-over';
 if (displayDate === todayISO) return 'today';
 return displayDate === nextDay(todayISO) ? 'tomorrow' : 'upcoming';
}

// What may be done with the item -- the client's row buttons and context
// menu (buildTodoItemRow, showTodoContextMenu) draw exactly these.
function actionsFor(state, task, raw, kind, locked, active, timerHere) {
 if (locked) return ['stats'];
 const actions = [];
 const isFuture = kind === 'tomorrow' || kind === 'upcoming';
 const canWorkOnNow = !task.passive && (kind === 'today' || kind === 'carried-over') && !raw.completed && !raw.failed;
 if (!isFuture) {
  if (!timerHere) {
   if (canWorkOnNow) actions.push('timer');
  } else if (active) {
   actions.push('pauseTimer', 'cancelTimer');
  } else {
   if (canWorkOnNow) actions.push('resumeTimer');
   actions.push('cancelTimer');
  }
  if (task.passive) actions.push(raw.failed ? 'unfail' : 'fail');
  else actions.push(raw.completed ? 'reopen' : 'complete');
  if (canWorkOnNow && !active) actions.push('focus');
  if (active) actions.push('unfocus');
  if (kind === 'carried-over') actions.push(raw.dismissed ? 'restore' : 'dismiss');
 }
 actions.push('edit');
 if (state.canPauseRecurrence(task, raw.occurrenceDate, raw)) actions.push('pause');
 if (state.currentPause(task)) actions.push('resume');
 actions.push('stats');
 return actions;
}

function toItem(state, raw) {
 const { task } = raw;
 const place = placement(state, task, raw.occurrenceDate);
 const kind = kindOf(state, place.displayDate);
 const occurrence = state.findOccurrence(task, raw.occurrenceDate);
 const resolved = task.passive ? raw.failed : raw.completed;
 const locked = !resolved && !state.canCompleteOrNoteTask(task);
 const active = task.id === state.active.taskId && raw.occurrenceDate === state.active.occurrenceDate;
 const timer = occurrence && occurrence.timer ? occurrence.timer : null;
 return {
  taskId: task.taskId,
  seriesId: task.seriesId,
  occurrenceDate: raw.occurrenceDate,
  displayDate: place.displayDate,
  kind,
  name: task.name,
  label: state.displayName(task),
  description: task.description || '',
  allDay: !!task.allDay,
  dueTime: place.dueTime,
  timeZone: task.allDay ? null : task.timeZone || null,
  zoneDueTime: place.zoneDueTime,
  appointment: !!task.appointment,
  passive: !!task.passive,
  recurUntilCompleted: !!task.recurUntilCompleted,
  completed: raw.completed,
  failed: raw.failed,
  overdue: raw.overdue,
  dismissed: raw.dismissed,
  active,
  locked,
  virtual: null,
  timer,
  actions: actionsFor(state, task, raw, kind, locked, active, !!timer),
 };
}

// The subscription reminder a free or lapsed account sees: an all-day item
// on today only (the client used to store it as a daily task). Nothing can
// be done with it; the client shows its text in the user's language.
function subscriptionPromptItem(state) {
 return {
  taskId: null,
  seriesId: null,
  occurrenceDate: state.clock.todayISO,
  displayDate: state.clock.todayISO,
  kind: 'today',
  name: '',
  label: '',
  description: '',
  allDay: true,
  dueTime: null,
  timeZone: null,
  zoneDueTime: null,
  appointment: false,
  passive: false,
  recurUntilCompleted: false,
  completed: false,
  failed: false,
  overdue: false,
  dismissed: false,
  active: false,
  locked: false,
  virtual: 'subscription-prompt',
  timer: null,
  actions: [],
 };
}

// Within a day: all-day first, then by due time, then by name.
function compareItems(a, b) {
 if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
 if (!a.allDay && a.dueTime !== b.dueTime) return a.dueTime < b.dueTime ? -1 : 1;
 return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
}

// ---------------------------------------------------------------------------
// One day of a view
// ---------------------------------------------------------------------------

const VIEWS = ['pending', 'next-recurrence', 'all'];
// How far the neighbouring non-empty days are looked for, in months.
const NEIGHBOUR_SCAN_MONTHS = 3;

// Items of a view whose display date falls in `monthKey`, keyed by date.
// A month's items can spill into the next (tomorrow's preview on the last
// day of a month; a fixed-zone task's moment) -- so the month before is
// computed too, keeping only what lands in this one.
function itemsByDateForMonth(state, view, monthKey, cache) {
 if (cache.has(monthKey)) return cache.get(monthKey);
 const raw = view === 'next-recurrence'
  ? (cache.nextRecurrence ||= nextRecurrenceItems(state))
  : [...(view === 'all' ? allItems : pendingItems)(state, addMonthsToKey(monthKey, -1)), ...(view === 'all' ? allItems : pendingItems)(state, monthKey)];
 const byDate = new Map();
 const seen = new Set();
 for (const r of raw) {
  const key = `${r.task.taskId}|${r.occurrenceDate}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const item = toItem(state, r);
  if (monthKeyOf(item.displayDate) !== monthKey) continue;
  if (!byDate.has(item.displayDate)) byDate.set(item.displayDate, []);
  byDate.get(item.displayDate).push(item);
 }
 if (!state.subscriptionActive && monthKeyOf(state.clock.todayISO) === monthKey) {
  const today = state.clock.todayISO;
  if (!byDate.has(today)) byDate.set(today, []);
  byDate.get(today).push(subscriptionPromptItem(state));
 }
 for (const items of byDate.values()) items.sort(compareItems);
 cache.set(monthKey, byDate);
 return byDate;
}

// The nearest day with items strictly before/after `date`, within
// NEIGHBOUR_SCAN_MONTHS months.
function neighbourDate(state, view, date, direction, cache) {
 let monthKey = monthKeyOf(date);
 for (let i = 0; i <= NEIGHBOUR_SCAN_MONTHS; i++) {
  const dates = [...itemsByDateForMonth(state, view, monthKey, cache).keys()].sort();
  const found = direction === 'before' ? dates.filter((d) => d < date).pop() : dates.find((d) => d > date);
  if (found) return found;
  monthKey = addMonthsToKey(monthKey, direction === 'before' ? -1 : 1);
 }
 return null;
}

// GET /days: the requested day if it has items, else the nearest one that
// does in `direction`; with the nearest non-empty days either side.
function dayView(state, view, date, direction = 'after') {
 const cache = new Map();
 let day = date;
 let items = itemsByDateForMonth(state, view, monthKeyOf(date), cache).get(date);
 if (!items) {
  day = neighbourDate(state, view, date, direction, cache);
  items = day ? itemsByDateForMonth(state, view, monthKeyOf(day), cache).get(day) : [];
 }
 return {
  date: day,
  items: items || [],
  previousDate: day ? neighbourDate(state, view, day, 'before', cache) : null,
  nextDate: day ? neighbourDate(state, view, day, 'after', cache) : null,
 };
}

// ---------------------------------------------------------------------------
// The agenda, a task's occurrences, dates a pattern produces
// ---------------------------------------------------------------------------

// Average measured minutes of a task's completed occurrences that had any --
// how long it usually takes (null: no measurements).
function averageFocusedMinutes(state, task) {
 let totalSeconds = 0;
 let count = 0;
 for (const o of state.occurrences) {
  if (o.taskId !== task.taskId || o.status !== 'completed') continue;
  const seconds = (o.focusedSeconds || 0) + (o.timerSeconds || 0);
  if (seconds <= 0) continue;
  totalSeconds += seconds;
  count++;
 }
 return count ? totalSeconds / count / 60 : null;
}

const AGENDA_DEFAULT_MINUTES = 30;

// Everything on the user's local day, whatever its state, with how long each
// usually takes (for the timeline's block lengths).
function agenda(state, date = state.clock.todayISO) {
 const byDate = itemsByDateForMonth(state, 'all', monthKeyOf(date), new Map());
 return (byDate.get(date) || []).filter((item) => !item.virtual).map((item) => {
  const task = state.taskByTaskId(item.taskId);
  const minutes = averageFocusedMinutes(state, task);
  return { ...item, durationMinutes: minutes === null ? AGENDA_DEFAULT_MINUTES : minutes, draggable: !item.allDay && !item.locked };
 });
}

// The editor's Occurrences tab: every past occurrence, the next one (and
// the one after, if the next is done), and every recorded row -- newest
// first, with state.
function taskOccurrences(state, task, extraDates = []) {
 const todayISO = state.todayFor(task);
 const entries = [];
 if (task.recurUntilCompleted) {
  const live = state.findOccurrence(task, null);
  for (const o of state.occurrences) {
   if (o.taskId !== task.taskId) continue;
   if (o === live) entries.push({ date: o.occurrenceDate, next: true });
   else if (o.occurrenceDate < todayISO || o.status !== 'pending') entries.push({ date: state.resolvedRecurUntilCompletedDate(o) });
  }
 } else {
  state.forEachOccurrenceBefore(task, todayISO, (date) => entries.push({ date }));
  const next = state.nextOccurrenceAfterDate(task, nextDay(todayISO, -1));
  if (next) {
   entries.push({ date: next, next: true });
   if (state.isCompleted(task, next)) {
    const following = state.nextOccurrenceAfterDate(task, next);
    if (following) entries.push({ date: following, next: true });
   }
  }
 }
 const listed = new Set(entries.map((e) => e.date));
 const addUnlisted = (date) => {
  if (listed.has(date)) return;
  listed.add(date);
  entries.push({ date });
 };
 for (const o of state.occurrences) {
  if (o.taskId !== task.taskId) continue;
  addUnlisted(task.recurUntilCompleted && o.status !== 'pending' ? state.resolvedRecurUntilCompletedDate(o) : o.occurrenceDate);
 }
 for (const date of extraDates) addUnlisted(date);
 return entries
  .sort((x, y) => y.date.localeCompare(x.date))
  .map((entry) => {
   const row = state.findOccurrence(task, entry.date);
   const status = row && row.status !== 'pending' ? row.status : state.isCompleted(task, entry.date, row) ? 'completed' : 'pending';
   const state_ = status !== 'pending' ? status : entry.date < todayISO ? 'missed' : entry.date === todayISO ? 'pending' : 'upcoming';
   return {
    date: entry.date,
    next: !!entry.next,
    status: state_,
    recorded: !!row,
    noteCount: row && row.comments ? row.comments.length : 0,
    deletable: state.canDeleteOccurrence(task, entry.date),
    reschedulable: !!row && require('./occurrence').canManageOccurrenceDirectly(task, row),
   };
  });
}

// Dates in [from, to] the task occurs on (the pause and "Find occurrence"
// calendars only offer these).
function occurrenceDates(state, task, fromISO, toISO) {
 const dates = [];
 state.forEachOccurrenceInRange(task, fromISO, nextDay(toISO), (date) => dates.push(date));
 return [...new Set(dates)].sort();
}

// A focus/timer session as the agenda draws it: when it ran (endMs null
// while it's still running) and which task's occurrence it was on -- with
// what the block needs to look like that task's. id: its
// atodo.focus_sessions id (null: not stored yet -- running, or ended in this
// very request), which deleting it takes.
function sessionItem(state, { id, task, occurrenceDate, kind, startMs, endMs }) {
 return {
  id: id == null ? null : String(id),
  taskId: task.taskId,
  occurrenceDate,
  label: state.displayName(task),
  kind,
  startMs,
  endMs,
  appointment: !!task.appointment,
  passive: !!task.passive,
 };
}

// The focused occurrence as an item (null: none) -- sent with every day, so
// the client can show a running timer whose row isn't loaded or on screen.
// Only the focused occurrence's timer can be running.
function focusedItem(state) {
 const task = state.taskByRecordId(state.active.taskId);
 if (!task) return null;
 const occurrenceDate = state.active.occurrenceDate;
 const occurrence = state.findOccurrence(task, occurrenceDate);
 const completed = state.isCompleted(task, occurrenceDate, occurrence);
 const { overdue, failed } = completed ? { overdue: false, failed: false } : state.pastDueStatus(task, occurrenceDate, false);
 return toItem(state, { task, occurrenceDate, completed, overdue, failed, dismissed: !!(occurrence && occurrence.dismissed) });
}

module.exports = {
 VIEWS,
 sessionItem,
 focusedItem,
 monthKeyOf,
 addMonthsToKey,
 dayView,
 agenda,
 taskOccurrences,
 occurrenceDates,
 averageFocusedMinutes,
 pendingItems,
 allItems,
 nextRecurrenceItems,
 toItem,
};
