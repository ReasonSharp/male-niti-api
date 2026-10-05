// One account's tasks and occurrences, as loaded for one request, and the
// rules that read and change them -- ported from the A-To-Do client's app.js,
// which used to run all of this in the browser over its own copy of the
// whole task list. The functions keep their client names (and their
// reasoning, shortened -- the client's comments explain each at length) so
// behaviour can be compared line by line with the client's history.
//
// What changed in the port:
//  - state lives on an AccountState instead of module globals, and "now" /
//    "today" come from its clock (clock.js) -- per task, since a task with a
//    fixed time zone runs on a clock in that zone (clockFor);
//  - nothing renders or saves here: the store (store.js) loads the state,
//    a route calls these, and the store writes back whatever changed;
//  - UI-only state (the side panel's selection, the 5-second linger timers)
//    stays in the client, and a refusal the client used to show as a modal
//    is thrown as a DomainError with a code instead;
//  - the focused task's focus-only session start is kept with the account
//    (active.focusSince) instead of in page memory, so it survives reloads;
//  - the subscription reminder task is no longer stored -- see views.js.

const crypto = require('crypto');
const Recurrence = require('./recurrence');
const Occurrence = require('./occurrence');
const { clockForTask, zonedInstant, wallDateTime } = require('./clock');

class DomainError extends Error {
 constructor(code, message, status = 409) {
  super(message || code);
  this.code = code;
  this.status = status;
 }
}

// A passive task is never completed, so it can't recur until it is. (Older
// data with both is left as it is: neither flag is refused unless it's the
// one being turned on.)
const PASSIVE_RECURS = () => new DomainError('VALIDATION_ERROR', "A passive task can't recur until completed.", 400);

// Same shape as the client's own ids (opaque strings).
const uid = () => crypto.randomBytes(9).toString('base64url');

const nextDay = (iso, n = 1) => Recurrence.dateToISO(Recurrence.addDays(new Date(iso + 'T00:00:00'), n));

const FREE_TASK_LIMITS = { once: 10, recurring: 5 };
const NOTES_PER_TASK_LIMIT = 5;
const MAX_TIMER_MINUTES = 360;
const MAX_TIMER_SECONDS = MAX_TIMER_MINUTES * 60;
const FOCUS_TOGGLE_LOG_WINDOW_MS = 10 * 1000;
const RESOLVE_WITH_UNFOCUS_MESSAGES = { 'Marked done': 'Unfocused and marked done' };
const RESOLVE_WITH_UNFOCUS_WINDOW_MS = 1000;
// The id the client's stored reminder task had -- such rows are dropped now
// (see dropStoredSubscriptionPrompt).
const SUBSCRIPTION_PROMPT_TASK_ID = 'subscription-prompt';

class AccountState {
 // tasks/occurrences: plain objects (see store.js for their shape);
 // clock: the user's (clock.js); active: { taskId, occurrenceDate,
 // focusSince } -- taskId is a task record's `id`; subscriptionActive:
 // whether the account has a live trial or plan.
 constructor({ tasks, occurrences, clock, active, subscriptionActive }) {
  this.tasks = tasks;
  this.occurrences = occurrences;
  this.clock = clock;
  this.active = { taskId: null, occurrenceDate: null, focusSince: null, ...(active || {}) };
  this.subscriptionActive = !!subscriptionActive;
  this.activeChanged = false;
  // Timers that ran out during this request (for the client's chime).
  this.expiredTimers = [];
 }

 get nowMs() {
  return this.clock.nowMs;
 }

 clockFor(task) {
  return clockForTask(task, this.clock);
 }

 todayFor(task) {
  return this.clockFor(task).todayISO;
 }

 taskByRecordId(id) {
  return this.tasks.find((t) => t.id === id) || null;
 }

 // The task record for a taskId (one record per task since the
 // single-record migration).
 taskByTaskId(taskId) {
  return this.tasks.find((t) => t.taskId === taskId) || null;
 }

 requireTask(taskId) {
  const task = this.taskByTaskId(taskId);
  if (!task) throw new DomainError('TASK_NOT_FOUND', 'No such task.', 404);
  return task;
 }

 // ---------------------------------------------------------------------------
 // Finding occurrences (client: findOccurrence/ensureOccurrence and friends)
 // ---------------------------------------------------------------------------

 // For an ordinary task, an exact (taskId, date) match. For a
 // recurUntilCompleted task an exact match is tried first too (so "the same
 // occurrence" is still found by its date after its status changes), then
 // chain membership -- the live pending chain, else a resolved occurrence
 // whose frozen chain covers the date. The live chain is the latest-starting
 // pending row, and none is live if it predates the latest resolved
 // occurrence (stale rows from a plain-recurring past). date == null means
 // "the live pending one, wherever it is".
 findOccurrence(task, occurrenceDate) {
  if (!task.recurUntilCompleted) return Occurrence.findOccurrence(this.occurrences, task.taskId, occurrenceDate);
  let pending = null;
  let latestResolvedDate = null;
  for (const o of this.occurrences) {
   if (o.taskId !== task.taskId) continue;
   if (o.status !== 'pending') {
    if (!latestResolvedDate || o.occurrenceDate > latestResolvedDate) latestResolvedDate = o.occurrenceDate;
   } else if (!pending || o.occurrenceDate > pending.occurrenceDate) {
    pending = o;
   }
  }
  if (pending && latestResolvedDate && pending.occurrenceDate < latestResolvedDate) pending = null;
  if (occurrenceDate == null) return pending;
  const exact = Occurrence.findOccurrence(this.occurrences, task.taskId, occurrenceDate);
  if (exact) return exact;
  if (pending && (pending.pendingReschedules || []).includes(occurrenceDate)) return pending;
  return this.occurrences.find((o) => o.taskId === task.taskId && o.status !== 'pending' && (o.pendingReschedules || []).includes(occurrenceDate)) || null;
 }

 ensureOccurrence(task, occurrenceDate) {
  const existing = this.findOccurrence(task, occurrenceDate);
  if (existing) return existing;
  const occurrence = Occurrence.createOccurrence({ id: uid(), taskId: task.taskId, occurrenceDate });
  this.occurrences.push(occurrence);
  return occurrence;
 }

 removeOccurrence(occurrence) {
  const index = this.occurrences.indexOf(occurrence);
  if (index >= 0) this.occurrences.splice(index, 1);
 }

 occurrenceScanShape(task) {
  if (!task.recurUntilCompleted) return task;
  const occurrence = this.findOccurrence(task, null);
  return occurrence ? Occurrence.recurrenceShim(task, occurrence) : null;
 }

 // A task's recorded rows are its occurrences whatever its pattern says;
 // otherwise its pattern decides, minus dates a reschedule vacated.
 occursOnDate(task, dateISO) {
  if (this.findOccurrence(task, dateISO)) return true;
  if (task.recurUntilCompleted) return false;
  return Recurrence.occursOn(task, dateISO) && !Occurrence.isDateExcluded(this.occurrences, task.taskId, dateISO);
 }

 taskRowDates(taskId) {
  return this.occurrences.filter((o) => o.taskId === taskId).map((o) => o.occurrenceDate).sort();
 }

 previousOccurrenceBeforeDate(task, dateISO) {
  if (task.recurUntilCompleted) {
   const shape = this.occurrenceScanShape(task);
   return shape ? Recurrence.previousOccurrenceBefore(shape, dateISO) : null;
  }
  let patternPrev = null;
  let cursor = dateISO;
  for (let i = 0; i < 3660; i++) {
   const prev = Recurrence.previousOccurrenceBefore(task, cursor);
   if (!prev) break;
   if (!Occurrence.isDateExcluded(this.occurrences, task.taskId, prev)) {
    patternPrev = prev;
    break;
   }
   cursor = prev;
  }
  const rowPrev = this.taskRowDates(task.taskId).filter((d) => d < dateISO).pop() || null;
  return [patternPrev, rowPrev].filter(Boolean).sort().pop() || null;
 }

 nextOccurrenceAfterDate(task, afterISO) {
  if (task.recurUntilCompleted) {
   const shape = this.occurrenceScanShape(task);
   return shape ? Recurrence.nextOccurrenceAfter(shape, afterISO) : null;
  }
  let patternNext = null;
  let cursor = afterISO;
  for (let i = 0; i < 3660; i++) {
   const next = Recurrence.nextOccurrenceAfter(task, cursor);
   if (!next) break;
   if (!Occurrence.isDateExcluded(this.occurrences, task.taskId, next)) {
    patternNext = next;
    break;
   }
   cursor = next;
  }
  const rowNext = this.taskRowDates(task.taskId).find((d) => d > afterISO) || null;
  return [patternNext, rowNext].filter(Boolean).sort()[0] || null;
 }

 earliestOccurrenceScanStart(task) {
  const firstRow = this.taskRowDates(task.taskId)[0];
  return firstRow && firstRow < task.dueDate ? firstRow : task.dueDate;
 }

 // Every resolved occurrence's own date, plus the live pending one's whole
 // chain -- what a recurUntilCompleted task shows over a range.
 allRecurUntilCompletedDatesInRange(task, startISO, cutoffISO, fn) {
  const live = this.findOccurrence(task, null);
  for (const occurrence of this.occurrences.slice()) {
   if (occurrence.taskId !== task.taskId) continue;
   const dates = occurrence === live ? [occurrence.occurrenceDate, ...(occurrence.pendingReschedules || [])] : [occurrence.occurrenceDate];
   for (const date of dates) if (date >= startISO && date < cutoffISO) fn(date);
  }
 }

 forEachOccurrenceBefore(task, cutoffISO, fn) {
  if (task.recurUntilCompleted) return this.allRecurUntilCompletedDatesInRange(task, '', cutoffISO, fn);
  let cursor = this.earliestOccurrenceScanStart(task);
  for (let i = 0; i < 3660 && cursor < cutoffISO; i++) {
   if (this.occursOnDate(task, cursor)) fn(cursor);
   cursor = nextDay(cursor);
  }
 }

 forEachOccurrenceInRange(task, startISO, cutoffISO, fn) {
  if (task.recurUntilCompleted) return this.allRecurUntilCompletedDatesInRange(task, startISO, cutoffISO, fn);
  const scanStart = this.earliestOccurrenceScanStart(task);
  let cursor = scanStart > startISO ? scanStart : startISO;
  for (let i = 0; i < 3660 && cursor < cutoffISO; i++) {
   if (this.occursOnDate(task, cursor)) fn(cursor);
   cursor = nextDay(cursor);
  }
 }

 // Overdue (carries over) vs. failed (an appointment past due, or a passive
 // task marked failed) vs. neither. An appointment being worked on right now
 // (this very occurrence focused) is exempt from failing.
 // A timed passive task is done once its due time has passed -- a reminder
 // that was there when it mattered -- unless it's been marked failed: after
 // its time it's either done or failed, before it pending or failed. Derived,
 // not stored, so every past occurrence counts without a row. (Not a
 // recurUntilCompleted one: its chain carries on until it's marked.)
 isPassiveDoneByTime(task, occurrenceDate, occurrence = this.findOccurrence(task, occurrenceDate)) {
  if (!task.passive || task.allDay || task.recurUntilCompleted) return false;
  if (occurrence && occurrence.status === 'failed') return false;
  return Recurrence.isOverdue(task, occurrenceDate, this.clockFor(task).now);
 }

 // Whether an occurrence is done: checked off, or a timed passive task past
 // its time (isPassiveDoneByTime).
 isCompleted(task, occurrenceDate, occurrence = this.findOccurrence(task, occurrenceDate)) {
  return !!(occurrence && occurrence.status === 'completed') || this.isPassiveDoneByTime(task, occurrenceDate, occurrence);
 }

 pastDueStatus(task, occurrenceDate, completed) {
  if (task.recurUntilCompleted) return { overdue: false, failed: false };
  const now = this.clockFor(task).now;
  if (task.passive) {
   const occurrence = this.findOccurrence(task, occurrenceDate);
   if (occurrence && occurrence.status === 'failed') return { overdue: false, failed: true };
   // A timed one is done once its time has passed (isCompleted), not overdue.
   if (this.isPassiveDoneByTime(task, occurrenceDate, occurrence)) return { overdue: false, failed: false };
   return { overdue: Recurrence.isOverdue(task, occurrenceDate, now), failed: false };
  }
  if (completed || !Recurrence.isOverdue(task, occurrenceDate, now)) return { overdue: false, failed: false };
  if (task.appointment && task.id === this.active.taskId && occurrenceDate === this.active.occurrenceDate) return { overdue: false, failed: false };
  return task.appointment ? { overdue: false, failed: true } : { overdue: true, failed: false };
 }

 // ---------------------------------------------------------------------------
 // Series
 // ---------------------------------------------------------------------------

 tasksInSeries(seriesId) {
  return this.tasks.filter((t) => t.seriesId === seriesId);
 }

 isMixedSeries(seriesId) {
  return new Set(this.tasksInSeries(seriesId).map((t) => t.taskId)).size > 1;
 }

 getSeriesName(seriesId) {
  const members = this.tasksInSeries(seriesId);
  const named = members.find((t) => t.seriesName);
  if (named) return named.seriesName;
  const sorted = members.slice().sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return sorted.length ? sorted[0].name : '';
 }

 // "[series]: [task]" for a task in a mixed series (unless it's the series'
 // own name), the task's own name otherwise.
 displayName(task) {
  if (!this.isMixedSeries(task.seriesId)) return task.name;
  const seriesName = this.getSeriesName(task.seriesId);
  return seriesName.trim().toLocaleLowerCase() === task.name.trim().toLocaleLowerCase() ? task.name : `${seriesName}: ${task.name}`;
 }

 // ---------------------------------------------------------------------------
 // Logs and notes
 // ---------------------------------------------------------------------------

 logTaskEvent(task, message, occurrenceDate) {
  if (!task.log) task.log = [];
  task.log.push({ message, timestamp: this.nowMs, occurrenceDate: occurrenceDate || null });
 }

 logOccurrenceEvent(task, occurrenceDate, message) {
  this.ensureOccurrence(task, occurrenceDate).log.push({ message, timestamp: this.nowMs });
 }

 // A focus toggled straight back within the window is a misclick: neither
 // entry stays. An "Unfocused" that's only the side effect of a resolution a
 // moment ago is folded into its entry.
 logFocusToggle(task, occurrenceDate, message, oppositeMessage) {
  const log = this.ensureOccurrence(task, occurrenceDate).log;
  const last = log[log.length - 1];
  if (last && last.message === oppositeMessage && this.nowMs - last.timestamp < FOCUS_TOGGLE_LOG_WINDOW_MS) {
   log.pop();
   return;
  }
  const combined = message === 'Unfocused' && last && RESOLVE_WITH_UNFOCUS_MESSAGES[last.message];
  if (combined && this.nowMs - last.timestamp < RESOLVE_WITH_UNFOCUS_WINDOW_MS) {
   last.message = combined;
   return;
  }
  this.logOccurrenceEvent(task, occurrenceDate, message);
 }

 // Undoing a resolution straight back after making it takes its log entry
 // back instead of adding an opposite one -- unless something was noted or
 // logged against the occurrence since.
 takeBackResolutionLogEntry(task, occurrence, resolvedMessage) {
  const log = occurrence.log;
  const last = log[log.length - 1];
  const combined = RESOLVE_WITH_UNFOCUS_MESSAGES[resolvedMessage];
  if (!last || (last.message !== resolvedMessage && last.message !== combined)) return false;
  if ((occurrence.comments || []).some((c) => c.timestamp >= last.timestamp)) return false;
  const taskLevelSince = this.tasks.some(
   (t) => t.taskId === task.taskId && (t.log || []).some((e) => e && e.occurrenceDate === occurrence.occurrenceDate && e.timestamp >= last.timestamp)
  );
  if (taskLevelSince) return false;
  if (last.message === combined) last.message = 'Unfocused';
  else log.pop();
  return true;
 }

 // ---------------------------------------------------------------------------
 // Free-tier limits (client: unlockedTaskIds and friends)
 // ---------------------------------------------------------------------------

 isTaskIdRecurring(taskId) {
  return this.tasks.some((t) => t.taskId === taskId && t.frequency.type !== 'once');
 }

 distinctTaskIds() {
  return new Set(this.tasks.map((t) => t.taskId));
 }

 taskIdCreatedAt(taskId) {
  let earliest = Infinity;
  for (const t of this.tasks) if (t.taskId === taskId && t.createdAt < earliest) earliest = t.createdAt;
  return earliest;
 }

 // null = unlimited. Otherwise the taskIds still usable: the first ones ever
 // created, up to the free limits (a lapsed plan's extra tasks are frozen,
 // not deleted).
 unlockedTaskIds() {
  if (this.subscriptionActive) return null;
  if (!this._unlocked) {
   const once = [];
   const recurring = [];
   for (const taskId of this.distinctTaskIds()) (this.isTaskIdRecurring(taskId) ? recurring : once).push(taskId);
   const byCreated = (a, b) => this.taskIdCreatedAt(a) - this.taskIdCreatedAt(b);
   once.sort(byCreated);
   recurring.sort(byCreated);
   this._unlocked = new Set([...once.slice(0, FREE_TASK_LIMITS.once), ...recurring.slice(0, FREE_TASK_LIMITS.recurring)]);
  }
  return this._unlocked;
 }

 canCompleteOrNoteTask(task) {
  const unlocked = this.unlockedTaskIds();
  return unlocked === null || unlocked.has(task.taskId);
 }

 canCreateTaskOfKind(isRecurring) {
  if (this.subscriptionActive) return true;
  const limit = isRecurring ? FREE_TASK_LIMITS.recurring : FREE_TASK_LIMITS.once;
  let count = 0;
  for (const taskId of this.distinctTaskIds()) if (this.isTaskIdRecurring(taskId) === isRecurring) count++;
  return count < limit;
 }

 notesUsedFor(task) {
  return Occurrence.notesCount(this.tasks, this.occurrences, task.taskId);
 }

 canAddNoteToTask(task) {
  if (!this.canCompleteOrNoteTask(task)) return false;
  if (this.subscriptionActive) return true;
  return this.notesUsedFor(task) < NOTES_PER_TASK_LIMIT;
 }

 requireUnlocked(task) {
  if (!this.canCompleteOrNoteTask(task)) throw new DomainError('TASK_LOCKED', "This task is beyond the free plan's limits.", 402);
 }

 // ---------------------------------------------------------------------------
 // Focus and timers (client: setActiveTaskId, flush*, timers)
 // ---------------------------------------------------------------------------

 // Credits whole seconds of focus or timer time to the occurrence it was
 // earned against.
 addFocusStat(task, kind, seconds, occurrenceDate) {
  const wholeSeconds = Math.round(seconds);
  if (!(wholeSeconds > 0)) return;
  const date = occurrenceDate || Recurrence.mostRecentOccurrenceOnOrBefore(task, this.todayFor(task)) || task.dueDate;
  this.ensureOccurrence(task, date)[kind] += wholeSeconds;
 }

 flushTimerElapsed(task, occurrenceDate) {
  const occurrence = this.findOccurrence(task, occurrenceDate);
  if (occurrence && occurrence.timer && occurrence.timer.runningSince != null) {
   this.addFocusStat(task, 'timerSeconds', (this.nowMs - occurrence.timer.runningSince) / 1000, occurrenceDate);
  }
 }

 flushFocusOnlyElapsed(task, occurrenceDate) {
  if (this.active.focusSince != null) {
   this.addFocusStat(task, 'focusedSeconds', (this.nowMs - this.active.focusSince) / 1000, occurrenceDate);
   this.active.focusSince = null;
   this.activeChanged = true;
  }
 }

 currentTimerRemaining(timer) {
  if (timer.runningSince == null) return timer.remainingSeconds;
  return timer.remainingSeconds - (this.nowMs - timer.runningSince) / 1000;
 }

 timerElapsedSeconds(timer) {
  return timer.totalSeconds - this.currentTimerRemaining(timer);
 }

 freezeTimer(timer) {
  timer.remainingSeconds = this.currentTimerRemaining(timer);
  timer.runningSince = null;
 }

 // Every change of the focused occurrence goes through here, so the
 // outgoing one's timer (or focus-only session) is checkpointed and the
 // incoming one's starts, uniformly. recordId: a task record's `id`, or
 // null to unfocus.
 setActiveTaskId(recordId, occurrenceDate) {
  if (recordId === this.active.taskId && (recordId === null || occurrenceDate === this.active.occurrenceDate)) return;
  const prevTask = this.taskByRecordId(this.active.taskId);
  if (prevTask) {
   const prevOccurrence = this.findOccurrence(prevTask, this.active.occurrenceDate);
   if (prevOccurrence && prevOccurrence.timer) {
    this.flushTimerElapsed(prevTask, this.active.occurrenceDate);
    this.freezeTimer(prevOccurrence.timer);
   } else {
    this.flushFocusOnlyElapsed(prevTask, this.active.occurrenceDate);
   }
   this.logFocusToggle(prevTask, this.active.occurrenceDate, 'Unfocused', 'Focused');
  }
  this.active.taskId = recordId;
  this.active.occurrenceDate = recordId ? occurrenceDate : null;
  this.active.focusSince = null;
  this.activeChanged = true;
  const nextTask = this.taskByRecordId(this.active.taskId);
  if (nextTask) {
   const nextOccurrence = this.findOccurrence(nextTask, this.active.occurrenceDate);
   if (nextOccurrence && nextOccurrence.timer) nextOccurrence.timer.runningSince = this.nowMs;
   else this.active.focusSince = this.nowMs;
   this.logFocusToggle(nextTask, this.active.occurrenceDate, 'Focused', 'Unfocused');
  }
 }

 // Whether an occurrence can be focused/timed now: not passive, today's or
 // a carried-over one, not resolved, not locked.
 canWorkOn(task, occurrenceDate) {
  if (task.passive || !this.canCompleteOrNoteTask(task)) return false;
  if (occurrenceDate > this.todayFor(task)) return false;
  if (!this.occursOnDate(task, occurrenceDate)) return false;
  const completed = this.isCompleted(task, occurrenceDate);
  if (completed) return false;
  return !this.pastDueStatus(task, occurrenceDate, completed).failed;
 }

 focus(taskId, occurrenceDate) {
  const task = this.requireTask(taskId);
  if (!this.canWorkOn(task, occurrenceDate)) throw new DomainError('NOT_FOCUSABLE', "This occurrence can't be focused now.");
  this.setActiveTaskId(task.id, occurrenceDate);
 }

 unfocus() {
  this.setActiveTaskId(null);
 }

 // "Timer…": start = focus it now with the timer running; otherwise just
 // attach it (paused) to start on the next focus.
 startTimer(taskId, occurrenceDate, { countUp, minutes, continuePastZero, start }) {
  const task = this.requireTask(taskId);
  if (!this.canWorkOn(task, occurrenceDate)) throw new DomainError('NOT_FOCUSABLE', "This occurrence can't be timed now.");
  let totalSeconds = 0;
  if (!countUp) {
   const wholeMinutes = Math.min(MAX_TIMER_MINUTES, Math.max(1, Math.round(Number(minutes)) || 0));
   totalSeconds = wholeMinutes * 60;
  }
  const occurrence = this.ensureOccurrence(task, occurrenceDate);
  const timer = { mode: countUp ? 'countup' : 'countdown', continuePastZero: !!continuePastZero, totalSeconds, remainingSeconds: totalSeconds, runningSince: null };
  if (!start) {
   occurrence.timer = timer;
   this.logOccurrenceEvent(task, occurrenceDate, 'Timer set');
   return;
  }
  const isActiveHere = task.id === this.active.taskId && this.active.occurrenceDate === occurrenceDate;
  if (isActiveHere && !occurrence.timer) this.flushFocusOnlyElapsed(task, occurrenceDate);
  timer.runningSince = this.nowMs;
  occurrence.timer = timer;
  this.logOccurrenceEvent(task, occurrenceDate, 'Timer set');
  this.setActiveTaskId(task.id, occurrenceDate);
 }

 cancelTimer(taskId, occurrenceDate) {
  const task = this.requireTask(taskId);
  this.flushTimerElapsed(task, occurrenceDate);
  this.ensureOccurrence(task, occurrenceDate).timer = null;
  this.logOccurrenceEvent(task, occurrenceDate, 'Timer cancelled');
  if (task.id === this.active.taskId && this.active.occurrenceDate === occurrenceDate) {
   this.active.focusSince = this.nowMs;
   this.activeChanged = true;
  }
 }

 // ---------------------------------------------------------------------------
 // Maintenance -- what the client used to do on every render, now at the
 // start of every read (see routes): expire timers, sweep stale carried-over
 // occurrences, carry recurUntilCompleted chains forward, and clear a focus
 // that's no longer eligible.
 // ---------------------------------------------------------------------------

 expireFinishedTimers() {
  const activeTask = this.taskByRecordId(this.active.taskId);
  for (const occurrence of this.occurrences) {
   if (!occurrence.timer) continue;
   const remaining = this.currentTimerRemaining(occurrence.timer);
   const ranPastCap = this.timerElapsedSeconds(occurrence.timer) >= MAX_TIMER_SECONDS;
   const countdownDone = occurrence.timer.mode !== 'countup' && !occurrence.timer.continuePastZero && remaining <= 0;
   if (!(countdownDone || ranPastCap)) continue;
   // Credited up to the moment it actually ran out -- noticed only on the
   // next request, which can be long after (the client checked every second).
   const timer = occurrence.timer;
   let endMs = this.nowMs;
   if (timer.runningSince != null) {
    const ranSeconds = (this.nowMs - timer.runningSince) / 1000;
    const untilZero = countdownDone ? timer.remainingSeconds : Infinity;
    const untilCap = MAX_TIMER_SECONDS - (timer.totalSeconds - timer.remainingSeconds);
    const creditedSeconds = Math.max(0, Math.min(ranSeconds, untilZero, untilCap));
    occurrence.timerSeconds += Math.round(creditedSeconds);
    endMs = timer.runningSince + creditedSeconds * 1000;
   }
   occurrence.timer = null;
   occurrence.log.push({ message: 'Timer elapsed', timestamp: Math.round(endMs) });
   this.expiredTimers.push({ taskId: occurrence.taskId, occurrenceDate: occurrence.occurrenceDate });
   if (activeTask && activeTask.taskId === occurrence.taskId && this.active.occurrenceDate === occurrence.occurrenceDate) {
    // The time set aside is over -- nothing left to stay focused on. Its
    // timer time was just credited; no focus-only session was running.
    this.active.taskId = null;
    this.active.occurrenceDate = null;
    this.active.focusSince = null;
    this.activeChanged = true;
   }
  }
 }

 // Any carried-over occurrence of a plain task gets one extra day shown,
 // then is dismissed on its own.
 autoDismissStaleCarriedOverOccurrences() {
  for (const task of this.tasks) {
   if (task.recurUntilCompleted) continue;
   const todayISO = this.todayFor(task);
   const yesterdayISO = nextDay(todayISO, -1);
   const priorDate = Recurrence.previousOccurrenceBefore(task, todayISO);
   const priorOccurrence = priorDate ? this.findOccurrence(task, priorDate) : null;
   if (!priorDate || (priorOccurrence && priorOccurrence.dismissed)) continue;
   if (priorDate < yesterdayISO) this.ensureOccurrence(task, priorDate).dismissed = true;
  }
 }

 // A missed recurUntilCompleted occurrence is pushed forward a day at a
 // time (one chain entry per day since it was due).
 advanceRecurUntilCompletedTasks() {
  for (const task of this.tasks) {
   if (!task.recurUntilCompleted) continue;
   const occurrence = this.findOccurrence(task, null);
   if (!occurrence) continue;
   const grown = Recurrence.advanceRecurUntilCompletedChain(Occurrence.recurrenceShim(task, occurrence), this.todayFor(task));
   if (grown !== occurrence.pendingReschedules) occurrence.pendingReschedules = grown;
  }
 }

 // The focused occurrence stops being focused once it's no longer workable
 // (done, failed, rolled past, deleted).
 clearIneligibleFocus() {
  const task = this.taskByRecordId(this.active.taskId);
  if (this.active.taskId && (!task || !this.canWorkOn(task, this.active.occurrenceDate))) this.setActiveTaskId(null);
 }

 runMaintenance() {
  this.expireFinishedTimers();
  this.autoDismissStaleCarriedOverOccurrences();
  this.advanceRecurUntilCompletedTasks();
  this.clearIneligibleFocus();
 }

 // ---------------------------------------------------------------------------
 // Completing, failing, dismissing (client: toggleTaskCompletion & co.)
 // ---------------------------------------------------------------------------

 // Marks an occurrence done. For a recurUntilCompleted task that resolves
 // its chain on the checked date and creates the next cycle. For a plain one,
 // every earlier occurrence missed without being resolved is dismissed (it
 // would otherwise linger and resurface after pattern edits) -- the client
 // keeps the list as it was, check mark showing, for a moment before it
 // re-fetches. (A completed carried-over occurrence itself is dismissed by
 // the "next recurrence" view, as the client's was -- see views.js.)
 complete(taskId, occurrenceDate) {
  const task = this.requireTask(taskId);
  this.requireUnlocked(task);
  if (task.passive) throw new DomainError('NOT_COMPLETABLE', 'A passive task is marked failed, not done.');
  if (occurrenceDate > this.todayFor(task)) throw new DomainError('NOT_DUE', "This occurrence isn't due yet.");
  const occurrence = this.ensureOccurrence(task, occurrenceDate);
  if (occurrence.status === 'completed') return;
  occurrence.status = 'completed';
  occurrence.resolvedAt = this.nowMs;
  this.logOccurrenceEvent(task, occurrenceDate, 'Marked done');
  if (task.recurUntilCompleted) {
   this.resolveRecurUntilCompletedOccurrence(task, occurrence, occurrenceDate);
  } else {
   this.forEachOccurrenceBefore(task, occurrenceDate, (date) => {
    this.ensureOccurrence(task, date).dismissed = true;
   });
  }
  if (occurrence.timer) {
   this.flushTimerElapsed(task, occurrenceDate);
   occurrence.timer = null;
  }
  this.clearIneligibleFocus();
 }

 reopen(taskId, occurrenceDate) {
  const task = this.requireTask(taskId);
  const occurrence = this.findOccurrence(task, occurrenceDate);
  if (!occurrence || occurrence.status !== 'completed') return;
  if (task.recurUntilCompleted && !this.reopenRecurUntilCompletedOccurrence(task, occurrence)) {
   throw new DomainError('REOPEN_BLOCKED', 'A later cycle of this task has been resolved since.');
  }
  occurrence.status = 'pending';
  occurrence.resolvedAt = null;
  if (!this.takeBackResolutionLogEntry(task, occurrence, 'Marked done')) this.logOccurrenceEvent(task, occurrenceDate, 'Marked not done');
 }

 resolveRecurUntilCompletedOccurrence(task, occurrence, completedISO) {
  const chain = occurrence.pendingReschedules || [];
  if (completedISO === occurrence.occurrenceDate) occurrence.pendingReschedules = [];
  else if (chain.includes(completedISO)) occurrence.pendingReschedules = chain.slice(0, chain.indexOf(completedISO) + 1);
  occurrence.status = 'completed';
  occurrence.resolvedAt = this.nowMs;
  const nextDate = Recurrence.nextRecurUntilCompletedDueDate(task, completedISO) || null;
  if (nextDate) this.ensureOccurrence(task, nextDate);
 }

 // Takes back the next cycle completing `occurrence` created, moving
 // anything recorded on it onto `occurrence`; refused once a later cycle has
 // been resolved.
 reopenRecurUntilCompletedOccurrence(task, occurrence) {
  const laterResolved = this.occurrences.some(
   (o) => o !== occurrence && o.taskId === task.taskId && o.status !== 'pending' && o.occurrenceDate > occurrence.occurrenceDate
  );
  if (laterResolved) return false;
  const successor = this.findOccurrence(task, null);
  if (successor && successor !== occurrence) {
   const byTimestamp = (a, b) => a.timestamp - b.timestamp;
   occurrence.comments = [...(occurrence.comments || []), ...(successor.comments || [])].sort(byTimestamp);
   occurrence.log = [...(occurrence.log || []), ...(successor.log || [])].sort(byTimestamp);
   occurrence.focusedSeconds = (occurrence.focusedSeconds || 0) + (successor.focusedSeconds || 0);
   occurrence.timerSeconds = (occurrence.timerSeconds || 0) + (successor.timerSeconds || 0);
   if (!occurrence.timer) occurrence.timer = successor.timer;
   if (successor.details) occurrence.details = occurrence.details ? `${occurrence.details}\n\n${successor.details}` : successor.details;
   const successorDates = [successor.occurrenceDate, ...(successor.pendingReschedules || [])];
   if (this.active.taskId === task.id && successorDates.includes(this.active.occurrenceDate)) {
    this.active.occurrenceDate = Occurrence.effectiveDueDate(occurrence);
    this.activeChanged = true;
   }
   this.removeOccurrence(successor);
  }
  occurrence.dismissed = false;
  return true;
 }

 // A passive task's checkbox: marked failed or not.
 fail(taskId, occurrenceDate) {
  const task = this.requireTask(taskId);
  this.requireUnlocked(task);
  if (!task.passive) throw new DomainError('NOT_FAILABLE', 'Only a passive task is marked failed.');
  if (occurrenceDate > this.todayFor(task)) throw new DomainError('NOT_DUE', "This occurrence isn't due yet.");
  const occurrence = this.ensureOccurrence(task, occurrenceDate);
  if (occurrence.status === 'failed') return;
  occurrence.status = 'failed';
  occurrence.resolvedAt = this.nowMs;
  this.logOccurrenceEvent(task, occurrenceDate, 'Marked failed');
 }

 unfail(taskId, occurrenceDate) {
  const task = this.requireTask(taskId);
  const occurrence = this.findOccurrence(task, occurrenceDate);
  if (!occurrence || occurrence.status !== 'failed') return;
  occurrence.status = 'pending';
  occurrence.resolvedAt = null;
  if (!this.takeBackResolutionLogEntry(task, occurrence, 'Marked failed')) this.logOccurrenceEvent(task, occurrenceDate, 'Marked not failed');
 }

 dismiss(taskId, occurrenceDate) {
  const task = this.requireTask(taskId);
  this.ensureOccurrence(task, occurrenceDate).dismissed = true;
 }

 restore(taskId, occurrenceDate) {
  const task = this.requireTask(taskId);
  this.ensureOccurrence(task, occurrenceDate).dismissed = false;
 }

 // ---------------------------------------------------------------------------
 // Notes and details
 // ---------------------------------------------------------------------------

 requireCanAddNote(task) {
  if (!this.canAddNoteToTask(task)) {
   throw this.canCompleteOrNoteTask(task)
    ? new DomainError('NOTE_LIMIT', "This task has as many notes as the free plan allows.", 402)
    : new DomainError('TASK_LOCKED', "This task is beyond the free plan's limits.", 402);
  }
 }

 addTaskNote(taskId, text) {
  const task = this.requireTask(taskId);
  this.requireCanAddNote(task);
  if (!task.comments) task.comments = [];
  task.comments.push({ text, timestamp: this.nowMs });
 }

 addOccurrenceNote(taskId, occurrenceDate, text) {
  const task = this.requireTask(taskId);
  this.requireCanAddNote(task);
  this.ensureOccurrence(task, occurrenceDate).comments.push({ text, timestamp: this.nowMs });
 }

 // A note is identified by its owner and timestamp (notes have no ids).
 findNote(taskId, occurrenceDate, timestamp) {
  const task = this.requireTask(taskId);
  const owner = occurrenceDate ? this.findOccurrence(task, occurrenceDate) : task;
  const note = owner && (owner.comments || []).find((c) => c.timestamp === timestamp);
  if (!note) throw new DomainError('NOTE_NOT_FOUND', 'No such note.', 404);
  return { owner, note };
 }

 editNote(taskId, occurrenceDate, timestamp, text) {
  this.findNote(taskId, occurrenceDate, timestamp).note.text = text;
 }

 deleteNote(taskId, occurrenceDate, timestamp) {
  const { owner, note } = this.findNote(taskId, occurrenceDate, timestamp);
  owner.comments.splice(owner.comments.indexOf(note), 1);
 }

 setOccurrenceDetails(taskId, occurrenceDate, details) {
  const task = this.requireTask(taskId);
  const value = (details || '').trim() || null;
  const current = this.findOccurrence(task, occurrenceDate);
  if ((current ? current.details || null : null) === value) return;
  (current || this.ensureOccurrence(task, occurrenceDate)).details = value;
 }

 // ---------------------------------------------------------------------------
 // Creating, editing and deleting tasks
 // ---------------------------------------------------------------------------

 // fields: name, description, details, dueDate, dueTime, allDay,
 // appointment, passive, recurUntilCompleted, endDate, frequency, timeZone,
 // seriesId (to join an existing series).
 createTask(fields) {
  if (fields.passive && fields.recurUntilCompleted) throw PASSIVE_RECURS();
  const isRecurring = fields.frequency.type !== 'once';
  if (!this.canCreateTaskOfKind(isRecurring)) throw new DomainError('TASK_LIMIT', 'The free plan allows no more tasks of this kind.', 402);
  const recurUntilCompleted = !!fields.recurUntilCompleted;
  // A recurUntilCompleted task starts on the first date its pattern lands on.
  const dueDate = recurUntilCompleted
   ? Recurrence.firstRecurUntilCompletedDueDate({ dueDate: fields.dueDate, frequency: fields.frequency, endDate: fields.endDate }) || fields.dueDate
   : fields.dueDate;
  const id = uid();
  const task = {
   id,
   taskId: id,
   seriesId: fields.seriesId || uid(),
   seriesName: null,
   name: fields.name,
   description: fields.description || '',
   details: fields.details || '',
   dueDate,
   dueTime: fields.allDay ? null : fields.dueTime,
   allDay: !!fields.allDay,
   appointment: !!fields.appointment,
   passive: !!fields.passive,
   recurUntilCompleted,
   endDate: fields.frequency.type === 'once' ? null : fields.endDate || null,
   frequency: fields.frequency,
   timeZone: fields.allDay ? null : fields.timeZone || null,
   createdAt: this.nowMs,
   statsResetAt: null,
   log: [],
   comments: [],
  };
  // Joining an explicitly named series carries its name over.
  if (fields.seriesId) {
   const namedMember = this.tasksInSeries(fields.seriesId).find((t) => t.seriesName);
   if (namedMember) task.seriesName = namedMember.seriesName;
  }
  this.tasks.push(task);
  this._unlocked = null;
  if (recurUntilCompleted) this.ensureOccurrence(task, dueDate);
  return task;
 }

 // Freezes a mixed series' displayed (fallback) name the first time a
 // member's rename would otherwise change it.
 freezeMixedSeriesNameIfRenaming(task, newName) {
  if (newName === task.name || !this.isMixedSeries(task.seriesId)) return;
  const members = this.tasksInSeries(task.seriesId);
  if (!members.some((t) => t.seriesName)) {
   const frozenName = this.getSeriesName(task.seriesId);
   for (const t of members) t.seriesName = frozenName;
  }
 }

 // Name/description/details/time/flags -- every occurrence, past and future.
 editDetails(taskId, fields) {
  const task = this.requireTask(taskId);
  if (fields.passive && !task.passive && task.recurUntilCompleted) throw PASSIVE_RECURS();
  const allDay = !!fields.allDay;
  const details = {
   name: fields.name,
   description: fields.description || '',
   details: fields.details || '',
   dueTime: allDay ? null : fields.dueTime,
   allDay,
   appointment: !!fields.appointment,
   passive: !!fields.passive,
   timeZone: allDay ? null : fields.timeZone || null,
  };
  if (!Object.keys(details).some((k) => (details[k] || null) !== (task[k] || null))) return false;
  this.freezeMixedSeriesNameIfRenaming(task, details.name);
  Object.assign(task, details);
  this.logTaskEvent(task, 'Edited');
  return true;
 }

 // The agenda's drag-to-reschedule: the task's due time, every occurrence.
 // dueTime is the user's local time (the agenda's drag); a task fixed to
 // another zone keeps its own, so it's converted -- on the given local date
 // (default today), which matters across a DST difference between the two.
 setDueTime(taskId, dueTime, localDate = this.clock.todayISO) {
  const task = this.requireTask(taskId);
  if (task.allDay) return;
  if (task.timeZone && task.timeZone !== this.clock.timeZone) {
   dueTime = wallDateTime(task.timeZone, zonedInstant(localDate, dueTime, this.clock.timeZone)).time;
  }
  if (task.dueTime === dueTime) return;
  task.dueTime = dueTime;
  this.logTaskEvent(task, 'Edited');
 }

 deleteTask(taskId) {
  const task = this.requireTask(taskId);
  this.tasks.splice(this.tasks.indexOf(task), 1);
  this.occurrences = this.occurrences.filter((o) => o.taskId !== task.taskId);
  this._unlocked = null;
  if (this.active.taskId === task.id) {
   this.active = { taskId: null, occurrenceDate: null, focusSince: null };
   this.activeChanged = true;
  }
 }

 // ---------------------------------------------------------------------------
 // Patterns (client: materializePatternOccurrences, applyPatternChange...)
 // ---------------------------------------------------------------------------

 materializePatternOccurrences(task, beforeISO) {
  if (task.recurUntilCompleted || task.frequency.type === 'once') return;
  let cursor = task.frequency.startsOn && task.frequency.startsOn > task.dueDate ? task.frequency.startsOn : task.dueDate;
  for (let i = 0; i < 3660 && cursor < beforeISO; i++) {
   if (Recurrence.occursOn(task, cursor) && !Occurrence.isDateExcluded(this.occurrences, task.taskId, cursor) && !this.findOccurrence(task, cursor)) {
    this.occurrences.push(Occurrence.createOccurrence({ id: uid(), taskId: task.taskId, occurrenceDate: cursor }));
   }
   cursor = nextDay(cursor);
  }
 }

 rollPatternForward(task, cutoffISO) {
  this.materializePatternOccurrences(task, cutoffISO);
  if (task.recurUntilCompleted || task.frequency.type === 'once' || cutoffISO <= task.dueDate) return;
  const frequency = { ...task.frequency, startsOn: cutoffISO };
  if (frequency.skipDates) {
   frequency.skipDates = frequency.skipDates.filter((d) => d >= cutoffISO);
   if (!frequency.skipDates.length) delete frequency.skipDates;
  }
  task.frequency = frequency;
 }

 dropBlankOccurrences(taskId, fromISO, beforeISO = null) {
  this.occurrences = this.occurrences.filter(
   (o) => !(o.taskId === taskId && o.occurrenceDate >= fromISO && (!beforeISO || o.occurrenceDate < beforeISO) && Occurrence.isBlankOccurrence(o))
  );
 }

 // startsOn/skipDates are bookkeeping, not part of what the form edits.
 patternDiffers(task, { dueDate, frequency, endDate, recurUntilCompleted }) {
  const strip = (f) => {
   const copy = { ...f };
   delete copy.startsOn;
   delete copy.skipDates;
   delete copy.pause;
   if (copy.type === 'once') return { type: 'once' };
   return copy;
  };
  return (
   dueDate !== task.dueDate ||
   (endDate || null) !== (task.endDate || null) ||
   !!recurUntilCompleted !== !!task.recurUntilCompleted ||
   JSON.stringify(strip(frequency)) !== JSON.stringify(strip(task.frequency))
  );
 }

 // A new pattern applies from today on; everything before stays as it was
 // (saved as rows first). See the client's applyPatternChange for the cases.
 applyPatternChange(taskId, pattern) {
  const task = this.requireTask(taskId);
  if (!this.patternDiffers(task, pattern)) return false;
  const { dueDate, frequency, endDate, recurUntilCompleted } = pattern;
  if (recurUntilCompleted && !task.recurUntilCompleted && task.passive) throw PASSIVE_RECURS();
  // Turning a one-off into a recurring task (or back) makes it count
  // against the other kind's free-plan limit -- the same as creating one.
  const willRecur = frequency.type !== 'once';
  if (willRecur !== (task.frequency.type !== 'once') && !this.canCreateTaskOfKind(willRecur)) {
   throw new DomainError('TASK_LIMIT', 'The free plan allows no more tasks of this kind.', 402);
  }
  const todayISO = this.todayFor(task);
  const wasRecurUntilCompleted = task.recurUntilCompleted;
  const newFrequency = { ...frequency };
  delete newFrequency.startsOn;
  delete newFrequency.skipDates;
  delete newFrequency.pause;
  const logMessage = 'Recurrence pattern edited';

  if (wasRecurUntilCompleted && recurUntilCompleted) {
   if (task.frequency.pause) newFrequency.pause = task.frequency.pause;
   Object.assign(task, { dueDate, frequency: newFrequency, endDate });
   this.recomputeUntouchedNextCycle(task);
   this.logTaskEvent(task, logMessage);
   return true;
  }

  if (!wasRecurUntilCompleted && task.frequency.type === 'once' && newFrequency.type === 'once' && !recurUntilCompleted) {
   const row = this.findOccurrence(task, task.dueDate);
   if (row && dueDate !== task.dueDate && !this.findOccurrence(task, dueDate)) row.occurrenceDate = dueDate;
   Object.assign(task, { dueDate, frequency: newFrequency, endDate: null });
   this.logTaskEvent(task, logMessage);
   return true;
  }

  if (wasRecurUntilCompleted) {
   const live = this.findOccurrence(task, null);
   if (live) {
    live.pendingReschedules = [];
    if (Occurrence.isBlankOccurrence(live)) this.removeOccurrence(live);
   }
  } else {
   this.materializePatternOccurrences(task, todayISO);
  }
  this.dropBlankOccurrences(task.taskId, todayISO);

  if (recurUntilCompleted) {
   const startISO = dueDate > todayISO ? dueDate : todayISO;
   const firstDate = Recurrence.firstRecurUntilCompletedDueDate({ dueDate: startISO, frequency: newFrequency, endDate }) || startISO;
   Object.assign(task, { dueDate: firstDate, frequency: newFrequency, endDate, recurUntilCompleted: true });
   this.logTaskEvent(task, logMessage);
   this.ensureOccurrence(task, firstDate);
   return true;
  }

  if (dueDate < todayISO && newFrequency.type !== 'once') newFrequency.startsOn = todayISO;
  Object.assign(task, { dueDate, frequency: newFrequency, endDate: newFrequency.type === 'once' ? null : endDate, recurUntilCompleted: false });
  this.logTaskEvent(task, logMessage);
  this._unlocked = null;
  return true;
 }

 // A still-blank next cycle created under the old pattern is re-dated under
 // the new one (from the same completion day), or removed if there's none.
 recomputeUntouchedNextCycle(task) {
  const live = this.findOccurrence(task, null);
  if (!live || !Occurrence.isBlankOccurrence(live)) return;
  const previous = this.occurrences
   .filter((o) => o.taskId === task.taskId && o.status !== 'pending' && o.resolvedAt && o.occurrenceDate <= live.occurrenceDate)
   .sort((a, b) => b.resolvedAt - a.resolvedAt)[0];
  if (!previous) return;
  const completedISO = Occurrence.effectiveDueDate(previous);
  const nextDate = Recurrence.nextRecurUntilCompletedDueDate(task, completedISO) || null;
  if (!nextDate) this.removeOccurrence(live);
  else if (nextDate !== live.occurrenceDate && !this.occurrences.some((o) => o !== live && o.taskId === task.taskId && o.occurrenceDate === nextDate)) live.occurrenceDate = nextDate;
 }

 // ---------------------------------------------------------------------------
 // Single occurrences: delete, reschedule, add an extra one
 // ---------------------------------------------------------------------------

 canDeleteOccurrence(task, occurrenceDate) {
  const row = this.findOccurrence(task, occurrenceDate);
  if (task.recurUntilCompleted) return !!row && Occurrence.canManageOccurrenceDirectly(task, row);
  return !!row || this.occursOnDate(task, occurrenceDate);
 }

 deleteOccurrence(taskId, occurrenceDate) {
  const task = this.requireTask(taskId);
  if (!this.canDeleteOccurrence(task, occurrenceDate)) throw new DomainError('NOT_DELETABLE', "This occurrence can't be deleted.");
  const row = this.findOccurrence(task, occurrenceDate);
  const rowDate = row ? row.occurrenceDate : occurrenceDate;
  if (row) {
   if (this.active.taskId === task.id && (this.active.occurrenceDate === rowDate || this.active.occurrenceDate === occurrenceDate)) this.setActiveTaskId(null);
   this.removeOccurrence(row);
  }
  if (!task.recurUntilCompleted && Recurrence.occursOn(task, rowDate)) {
   task.frequency = { ...task.frequency, skipDates: [...(task.frequency.skipDates || []), rowDate].sort() };
  }
  this.logTaskEvent(task, 'Occurrence deleted', rowDate);
 }

 // Moves one occurrence to another date. Moving forward past the task's own
 // later occurrences skips them too (they'd otherwise resurface around the
 // moved one); the vacated dates are recorded so the pattern doesn't
 // regenerate them.
 rescheduleOccurrence(taskId, occurrenceDate, newDate) {
  const task = this.requireTask(taskId);
  const occurrence = this.findOccurrence(task, occurrenceDate);
  if (!occurrence || !Occurrence.canManageOccurrenceDirectly(task, occurrence)) throw new DomainError('NOT_RESCHEDULABLE', "This occurrence can't be rescheduled.");
  if (newDate === occurrence.occurrenceDate) return;
  if (this.findOccurrence(task, newDate)) throw new DomainError('DATE_TAKEN', 'This task already has an occurrence on that date.');
  this.logOccurrenceEvent(task, occurrence.occurrenceDate, `Rescheduled to ${newDate}`);
  if (!occurrence.pendingReschedules) occurrence.pendingReschedules = [];
  if (newDate > occurrence.occurrenceDate) {
   let cursor = occurrence.occurrenceDate;
   for (let i = 0; i < 3660 && cursor && cursor < newDate; i++) {
    occurrence.pendingReschedules.push(cursor);
    cursor = Recurrence.nextOccurrenceAfter(task, cursor);
   }
  } else {
   occurrence.pendingReschedules.push(occurrence.occurrenceDate);
  }
  if (this.active.taskId === task.id && this.active.occurrenceDate === occurrence.occurrenceDate) {
   this.active.occurrenceDate = newDate;
   this.activeChanged = true;
  }
  occurrence.occurrenceDate = newDate;
 }

 addManualOccurrence(taskId, dateISO) {
  const task = this.requireTask(taskId);
  if (this.occursOnDate(task, dateISO)) throw new DomainError('OCCURRENCE_EXISTS', 'The task already occurs on that date.');
  this.occurrences.push(Occurrence.createOccurrence({ id: uid(), taskId: task.taskId, occurrenceDate: dateISO, manual: true }));
  this.logTaskEvent(task, 'Manual occurrence added', dateISO);
 }

 // ---------------------------------------------------------------------------
 // Pausing and resuming recurrence
 // ---------------------------------------------------------------------------

 canPauseRecurrence(task, occurrenceDate, { completed, failed }) {
  if (task.recurUntilCompleted) {
   const occurrence = this.findOccurrence(task, occurrenceDate);
   return !!occurrence && occurrence.status === 'pending';
  }
  return task.frequency.type !== 'once' && !completed && !failed;
 }

 // The pause in effect today, if any.
 currentPause(task) {
  const pause = task.frequency && task.frequency.pause;
  if (!pause) return null;
  const todayISO = this.todayFor(task);
  if (!(pause.from <= todayISO && todayISO < pause.until)) return null;
  if (task.recurUntilCompleted) {
   const live = this.findOccurrence(task, null);
   return live && live.occurrenceDate === pause.until ? pause : null;
  }
  return task.frequency.startsOn === pause.until ? pause : null;
 }

 pauseSpan(task, pauseFromISO, resumeISO) {
  const previous = this.currentPause(task);
  return { from: previous && previous.until === pauseFromISO ? previous.from : pauseFromISO, until: resumeISO };
 }

 lastPossibleOccurrenceDate(task) {
  return task.frequency.type === 'once' ? task.dueDate : task.endDate || null;
 }

 releaseOccurrenceDatesForPause(taskId, fromISO, beforeISO) {
  const activeTask = this.taskByRecordId(this.active.taskId);
  if (activeTask && activeTask.taskId === taskId && this.active.occurrenceDate >= fromISO && this.active.occurrenceDate < beforeISO) this.setActiveTaskId(null);
 }

 // Hides every occurrence from occurrenceDate up to resumeISO; recurrence
 // resumes on exactly that date.
 pause(taskId, occurrenceDate, resumeISO) {
  const task = this.requireTask(taskId);
  if (resumeISO <= occurrenceDate) throw new DomainError('INVALID_RESUME_DATE', 'Recurrence must resume after the paused occurrence.', 400);
  const maxISO = task.recurUntilCompleted ? task.endDate || null : this.lastPossibleOccurrenceDate(task);
  if (maxISO && maxISO < resumeISO) throw new DomainError('NOTHING_AFTER', "The task's recurrence ends before then.");
  return task.recurUntilCompleted
   ? this.pauseRecurUntilCompletedOccurrence(task, occurrenceDate, resumeISO)
   : this.pausePlainRecurrence(task, occurrenceDate, resumeISO);
 }

 pauseRecurUntilCompletedOccurrence(task, occurrenceDate, resumeISO) {
  const occurrence = this.findOccurrence(task, occurrenceDate);
  if (!occurrence || occurrence.status !== 'pending') throw new DomainError('NOT_PAUSABLE', "This occurrence can't be paused.");
  if (this.occurrences.some((o) => o !== occurrence && o.taskId === task.taskId && o.occurrenceDate === resumeISO)) {
   throw new DomainError('DATE_TAKEN', 'This task already has an occurrence on that date.');
  }
  this.releaseOccurrenceDatesForPause(task.taskId, occurrence.occurrenceDate, resumeISO);
  task.frequency = { ...task.frequency, pause: this.pauseSpan(task, occurrenceDate, resumeISO) };
  occurrence.log.push({ message: `Recurrence paused until ${resumeISO}`, timestamp: this.nowMs });
  occurrence.occurrenceDate = resumeISO;
  occurrence.pendingReschedules = [];
  occurrence.dismissed = false;
 }

 pausePlainRecurrence(task, pauseFromISO, resumeISO) {
  if (task.frequency.type === 'once') throw new DomainError('NOT_PAUSABLE', "A one-off task can't be paused.");
  const span = this.pauseSpan(task, pauseFromISO, resumeISO);
  this.releaseOccurrenceDatesForPause(task.taskId, pauseFromISO, resumeISO);
  this.rollPatternForward(task, pauseFromISO);
  const frequency = { ...task.frequency, startsOn: resumeISO, pause: span };
  if (frequency.skipDates) {
   frequency.skipDates = frequency.skipDates.filter((d) => d >= resumeISO);
   if (!frequency.skipDates.length) delete frequency.skipDates;
  }
  task.frequency = frequency;
  this.dropBlankOccurrences(task.taskId, pauseFromISO, resumeISO);
  if (!Recurrence.occursOn(task, resumeISO) && !this.findOccurrence(task, resumeISO)) {
   this.occurrences.push(Occurrence.createOccurrence({ id: uid(), taskId: task.taskId, occurrenceDate: resumeISO, manual: true }));
  }
  this.logTaskEvent(task, `Recurrence paused until ${resumeISO}`, pauseFromISO);
 }

 // Ends the current pause today instead of on its resume date.
 resumeNow(taskId) {
  const task = this.requireTask(taskId);
  const pause = this.currentPause(task);
  if (!pause) throw new DomainError('NOT_PAUSED', "This task isn't paused.");
  const todayISO = this.todayFor(task);
  const message = `Recurrence resumed (was paused until ${pause.until})`;
  const { pause: _ended, ...frequency } = task.frequency;
  if (task.recurUntilCompleted) {
   const live = this.findOccurrence(task, null);
   if (this.occurrences.some((o) => o !== live && o.taskId === task.taskId && o.occurrenceDate === todayISO)) {
    throw new DomainError('DATE_TAKEN', 'This task already has an occurrence today.');
   }
   this.releaseOccurrenceDatesForPause(task.taskId, pause.until, nextDay(pause.until));
   task.frequency = frequency;
   live.log.push({ message, timestamp: this.nowMs });
   live.occurrenceDate = todayISO;
   live.pendingReschedules = [];
   live.dismissed = false;
  } else {
   task.frequency = { ...frequency, startsOn: todayISO };
   const standIn = Occurrence.findOccurrence(this.occurrences, task.taskId, pause.until);
   if (standIn && standIn.manual && Occurrence.isBlankOccurrence({ ...standIn, manual: false }) && !Recurrence.occursOn(task, pause.until)) {
    this.releaseOccurrenceDatesForPause(task.taskId, pause.until, nextDay(pause.until));
    this.removeOccurrence(standIn);
   }
   if (!Recurrence.occursOn(task, todayISO) && !this.findOccurrence(task, todayISO)) {
    this.occurrences.push(Occurrence.createOccurrence({ id: uid(), taskId: task.taskId, occurrenceDate: todayISO, manual: true }));
   }
   this.logTaskEvent(task, message, todayISO);
  }
 }

 // ---------------------------------------------------------------------------
 // Series membership
 // ---------------------------------------------------------------------------

 renameSeries(seriesId, name) {
  const members = this.tasksInSeries(seriesId);
  if (!members.length) throw new DomainError('SERIES_NOT_FOUND', 'No such series.', 404);
  for (const task of members) task.seriesName = name;
 }

 // A member's own name back to the series' saved name.
 resetNameToSeries(taskId) {
  const task = this.requireTask(taskId);
  task.name = this.getSeriesName(task.seriesId);
 }

 leaveSeries(taskId) {
  const task = this.requireTask(taskId);
  task.seriesId = uid();
  task.seriesName = null;
 }

 // Pulls a single task's series into another one (a mixed series can't be
 // pulled in as a unit).
 joinSeries(sourceSeriesId, targetSeriesId) {
  if (sourceSeriesId === targetSeriesId) return;
  const members = this.tasksInSeries(sourceSeriesId);
  if (!members.length || new Set(members.map((t) => t.taskId)).size !== 1) {
   throw new DomainError('NOT_A_SINGLE_TASK', 'Only a single task can be moved into another series.');
  }
  if (!this.tasksInSeries(targetSeriesId).length) throw new DomainError('SERIES_NOT_FOUND', 'No such series.', 404);
  for (const task of members) {
   task.seriesId = targetSeriesId;
   task.seriesName = null;
  }
 }

 // ---------------------------------------------------------------------------
 // Stats
 // ---------------------------------------------------------------------------

 // Counted from the task's last reset; on the reset day, whatever wasn't
 // already resolved before the reset still counts.
 countsTowardStats(task, dateISO) {
  if (!task.statsResetAt) return true;
  const resetISO = Recurrence.dateToISO(this.clockAt(task.statsResetAt, task).now);
  if (dateISO !== resetISO) return dateISO > resetISO;
  const occurrence = this.findOccurrence(task, dateISO);
  return !(occurrence && occurrence.status !== 'pending' && occurrence.resolvedAt && occurrence.resolvedAt < task.statsResetAt);
 }

 clockAt(ms, task) {
  return require('./clock').makeClock(this.clockFor(task).timeZone, ms);
 }

 resetStats(taskRecords) {
  const taskIds = new Set(taskRecords.map((t) => t.taskId));
  for (const task of taskRecords) {
   task.statsResetAt = this.nowMs;
   this.logTaskEvent(task, 'Stats reset');
  }
  for (const occurrence of this.occurrences) {
   if (!taskIds.has(occurrence.taskId)) continue;
   occurrence.focusedSeconds = 0;
   occurrence.timerSeconds = 0;
  }
  const activeTask = this.taskByRecordId(this.active.taskId);
  if (activeTask && taskIds.has(activeTask.taskId)) {
   const activeOccurrence = this.findOccurrence(activeTask, this.active.occurrenceDate);
   if (activeOccurrence && activeOccurrence.timer && activeOccurrence.timer.runningSince != null) activeOccurrence.timer.runningSince = this.nowMs;
   if (this.active.focusSince != null) {
    this.active.focusSince = this.nowMs;
    this.activeChanged = true;
   }
  }
 }

 // Deletes measured focus/timer time on one task's occurrences of a date (a
 // bad measurement); a session running on it restarts its clock.
 clearFocusTime(taskIds, dateISO) {
  for (const occurrence of this.occurrences) {
   if (!taskIds.includes(occurrence.taskId) || occurrence.occurrenceDate !== dateISO) continue;
   if (!occurrence.focusedSeconds && !occurrence.timerSeconds) continue;
   occurrence.focusedSeconds = 0;
   occurrence.timerSeconds = 0;
   const activeTask = this.taskByRecordId(this.active.taskId);
   if (activeTask && this.findOccurrence(activeTask, this.active.occurrenceDate) === occurrence) {
    if (occurrence.timer && occurrence.timer.runningSince != null) occurrence.timer.runningSince = this.nowMs;
    if (this.active.focusSince != null) {
     this.active.focusSince = this.nowMs;
     this.activeChanged = true;
    }
   }
   occurrence.log.push({ message: 'Measured focus time deleted', timestamp: this.nowMs });
  }
 }
}

module.exports = {
 AccountState,
 DomainError,
 uid,
 nextDay,
 FREE_TASK_LIMITS,
 NOTES_PER_TASK_LIMIT,
 MAX_TIMER_MINUTES,
 MAX_TIMER_SECONDS,
 SUBSCRIPTION_PROMPT_TASK_ID,
};
