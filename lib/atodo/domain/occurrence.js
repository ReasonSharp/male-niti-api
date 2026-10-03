// Pure helpers over the { tasks, occurrences } data model
// (test/domain/occurrence.test.js). Moved here from the client, like
// recurrence.js.
//
// A Task is one record: its data plus its CURRENT recurrence pattern
// (dueDate/frequency/endDate/...). An Occurrence is one interacted-with
// instance of it, sparse: a pattern-produced date with nothing recorded
// against it yet (still pending, no note, no timer) has no row at all --
// but every row that does exist always counts as an occurrence, whatever
// the current pattern says (a task's recorded past is its rows; see app.js's
// rollPatternForward). Occurrences are addressed by (taskId, occurrenceDate).
//
// recurUntilCompleted tasks keep at most one 'pending' Occurrence alive at a
// time -- see recurrenceShim below for how its pendingReschedules chain
// feeds back into recurrence.js's own chain-membership logic unchanged.
// pendingReschedules is reused for a second, unrelated purpose on a plain
// task's occurrence too: the history of dates it's been manually
// rescheduled AWAY from (see isDateExcluded) -- same "every date this
// occurrence has touched" shape, opposite direction (still-live chain vs.
// dead exclusions), never both meaningful on the same occurrence at once.

function findOccurrence(occurrences, taskId, occurrenceDate) {
  for (const o of occurrences) {
    if (o.taskId === taskId && o.occurrenceDate === occurrenceDate) return o;
  }
  return null;
}

// The (at most one) still-'pending' occurrence for a recurUntilCompleted
// task's taskId -- its current, not-yet-resolved occurrence.
function pendingOccurrenceFor(occurrences, taskId) {
  for (const o of occurrences) {
    if (o.taskId === taskId && o.status === 'pending') return o;
  }
  return null;
}

// A fresh occurrence row in its default (untouched) shape -- callers supply
// `id` themselves (via uid(), same as every other id-minting site in this
// app) since this module stays free of any global/DOM dependency.
function createOccurrence({ id, taskId, occurrenceDate, manual }) {
  return {
    id,
    taskId,
    occurrenceDate,
    pendingReschedules: [],
    // `status` (pending/completed/failed) is this occurrence's OUTCOME,
    // mutually exclusive. `dismissed` is a separate, independent axis --
    // whether it's hidden from the list regardless of outcome. An occurrence
    // can be 'completed' and not yet dismissed (the brief linger before it
    // visually disappears), or still 'pending' and already dismissed (a
    // genuinely missed occurrence swept off the list without ever being
    // resolved) -- see toggleTaskCompletion/scheduleDismissal/
    // markOccurrencesDismissedBefore in app.js for where each comes from.
    status: 'pending',
    resolvedAt: null,
    dismissed: false,
    manual: !!manual,
    overrides: null,
    details: null, // this occurrence's own details -- Task.details applies to all of them alike
    comments: [],
    log: [],
    focusedSeconds: 0,
    timerSeconds: 0,
    timer: null,
  };
}

// Which date a recurUntilCompleted occurrence is *currently* due on --
// wherever its reschedule chain has last pushed it, or its own
// occurrenceDate if it hasn't been pushed at all yet. Mirrors the old
// task.dueDate-as-live-pointer read, now off the occurrence itself.
function effectiveDueDate(occurrence) {
  const chain = occurrence.pendingReschedules || [];
  return chain.length ? chain[chain.length - 1] : occurrence.occurrenceDate;
}

// Builds the plain-object shape recurrence.js's own recurUntilCompleted
// handling expects (occursOn/advanceRecurUntilCompletedChain) -- these
// operate on a generic { dueDate, pendingReschedules, recurUntilCompleted,
// frequency, endDate } shape, not literally a Task record, so a
// recurUntilCompleted task's live state (now split across a Task and its
// current pending Occurrence) can be fed straight in without recurrence.js
// itself needing to change at all.
function recurrenceShim(task, occurrence) {
  return {
    dueDate: occurrence.occurrenceDate,
    pendingReschedules: occurrence.pendingReschedules || [],
    recurUntilCompleted: true,
    frequency: task.frequency,
    endDate: task.endDate,
  };
}

// The effective display fields for one occurrence of `task` -- an
// 'instance'-scope override wins field-by-field over the owning task's own
// current values; anything not overridden falls back to the task.
// Deliberately never touches pattern-level fields (frequency/
// recurUntilCompleted/endDate) -- those can't be overridden per-occurrence.
function applyOverrides(task, occurrence) {
  const overrides = occurrence && occurrence.overrides;
  if (!overrides) return task;
  return { ...task, ...overrides };
}

// A still-'pending' occurrence of a recurUntilCompleted task is the one live
// slot its reschedule chain is anchored to (see effectiveDueDate/
// pendingReschedules) -- deleting it or reassigning its occurrenceDate
// directly would orphan that chain, since nothing regenerates a missing
// pending occurrence for such a task the way an ordinary task's pattern
// recomputes on its own. Any resolved (completed/failed) occurrence, or any
// occurrence at all of a plain (non-recurUntilCompleted) task, is safe.
function canManageOccurrenceDirectly(task, occurrence) {
  return !(task.recurUntilCompleted && occurrence.status === 'pending');
}

// Whether a row carries nothing beyond what the task's own pattern would
// produce at that date anyway -- no outcome, notes, activity, timing,
// reschedule history or manual origin. Such a row is safe to drop whenever
// the pattern stops producing its date (a pattern change or a pause, see
// app.js's rollPatternForward and friends): nothing recorded is lost.
// Dismissal doesn't count as content -- it's just "hidden from the list".
function isBlankOccurrence(o) {
  return (
    o.status === 'pending' &&
    !o.manual &&
    !o.timer &&
    !o.overrides &&
    !(o.details && o.details.trim()) &&
    !(o.comments && o.comments.length) &&
    !(o.log && o.log.length) &&
    !(o.pendingReschedules && o.pendingReschedules.length) &&
    !o.focusedSeconds &&
    !o.timerSeconds
  );
}

// A date a plain (non-recurUntilCompleted) task's own pattern might still
// predict, but which some Occurrence for taskId has since been rescheduled
// AWAY from (see app.js's rescheduleOccurrencePrompt, which pushes the
// vacated date onto that occurrence's own pendingReschedules right before
// moving its occurrenceDate) -- excluded from ever being re-treated as a
// fresh, unclaimed pattern date, the same way a date an Occurrence's own
// current occurrenceDate already covers is "excluded" by simply being found
// there instead of synthesized. Reuses pendingReschedules' existing array
// shape rather than a new field: for a recurUntilCompleted task it means
// "every date pushed through since the still-live current occurrenceDate";
// here it means "every date this now-elsewhere occurrence has moved away
// from" -- same "history of dates this occurrence has touched" idea, never
// consulted for the same task at the same time (a recurUntilCompleted task's
// own occursOn short-circuits entirely, see recurrence.js, never reaching
// the pattern math this guards). `o.occurrenceDate !== dateISO` skips an
// occurrence that's since moved back onto this exact date -- it's the
// current, real occupant then, not an exclusion.
function isDateExcluded(occurrences, taskId, dateISO) {
  return occurrences.some((o) => o.taskId === taskId && o.occurrenceDate !== dateISO && (o.pendingReschedules || []).includes(dateISO));
}

// 'pending' for a date with no recorded Occurrence row at all -- same
// meaning as an absent key in the old completions/dismissed/markedFailed
// maps.
function statusOf(occurrences, taskId, occurrenceDate) {
  const occurrence = findOccurrence(occurrences, taskId, occurrenceDate);
  return occurrence ? occurrence.status : 'pending';
}

// Total notes recorded against a taskId -- task-level comments (general
// notes, not tied to one date) plus every occurrence-level comment across
// every Occurrence row for that taskId. Used by the free-tier per-task note
// limit, which counts across both buckets (see notesUsedFor, app.js).
function notesCount(taskRecords, occurrences, taskId) {
  const taskLevel = taskRecords
    .filter((t) => t.taskId === taskId)
    .reduce((sum, t) => sum + (t.comments ? t.comments.length : 0), 0);
  const occurrenceLevel = occurrences
    .filter((o) => o.taskId === taskId)
    .reduce((sum, o) => sum + (o.comments ? o.comments.length : 0), 0);
  return taskLevel + occurrenceLevel;
}

// The live occurrences recurUntilCompleted tasks are missing, as new rows
// (ids from newId). Every such task is created with its first 'pending'
// occurrence, which then carries it: nothing displays, finds or advances
// one without it. Data from before this Occurrence model can lack it,
// though: a task's recorded state lived on the task itself back then, and
// a recurUntilCompleted task nobody had touched yet had none to convert,
// so it came over with no rows at all. Its dueDate was the live "current
// occurrence" pointer then -- which is where that occurrence belongs. Only
// tasks with no rows at all: one with rows but no pending occurrence has
// run its course (e.g. past its endDate) and must stay that way.
function missingLiveOccurrences(tasks, occurrences, newId) {
  const withRows = new Set(occurrences.map((o) => o.taskId));
  const seeded = new Set();
  const rows = [];
  for (const t of tasks) {
    if (!t.recurUntilCompleted || withRows.has(t.taskId) || seeded.has(t.taskId)) continue;
    seeded.add(t.taskId);
    rows.push(createOccurrence({ id: newId(), taskId: t.taskId, occurrenceDate: t.dueDate }));
  }
  return rows;
}

const occurrenceApi = {
  findOccurrence,
  pendingOccurrenceFor,
  createOccurrence,
  effectiveDueDate,
  recurrenceShim,
  applyOverrides,
  canManageOccurrenceDirectly,
  isBlankOccurrence,
  isDateExcluded,
  statusOf,
  notesCount,
  missingLiveOccurrences,
};

module.exports = occurrenceApi;
