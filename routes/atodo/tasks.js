const express = require('express');
const asyncHandler = require('../../lib/asyncHandler');
const { withState } = require('../../lib/atodo/domain/request');
const { taskOccurrences, occurrenceDates, autoTimerSeconds } = require('../../lib/atodo/domain/views');
const { DomainError } = require('../../lib/atodo/domain/account');
const { taskSummary } = require('../../lib/atodo/domain/reports');
const { describeLog } = require('../../lib/atodo/domain/logEntries');
const v = require('../../lib/atodo/domain/validate');

// Mounted at /atodo/v1/tasks behind requireAtodoAuth (see routes/atodo/index.js).
//
// One task at a time: reading it (with its notes, log and occurrences) and
// every action on it or one of its occurrences. Each action is applied by the
// server's rules (lib/atodo/domain/account.js) in a transaction and answers
// { changed: { taskIds, all }, active } -- which tasks changed, so the client
// re-fetches what it shows of them, and the focused occurrence -- plus
// whatever the action itself returns.

const router = express.Router();

// A task with everything about it: its fields, notes and activity, and its
// occurrences (the editor's list, plus every recorded row's notes and log).
router.get('/:taskId', asyncHandler(async (req, res) => {
 await withState(req, res, { fullTaskIds: [req.params.taskId] }, (state) => {
  const task = state.requireTask(req.params.taskId);
  const extraDates = [].concat(req.query.extraDate || []).map((d) => v.date(d, 'extraDate'));
  return {
   task: { ...taskSummary(state, task), comments: task.comments, log: describeLog(task.log), notesUsed: state.notesUsedFor(task), canAddNote: state.canAddNoteToTask(task) },
   occurrenceList: taskOccurrences(state, task, extraDates),
   occurrences: state.occurrences
    .filter((o) => o.taskId === task.taskId)
    .map((o) => ({
     occurrenceDate: o.occurrenceDate,
     status: o.status,
     dismissed: o.dismissed,
     manual: o.manual,
     details: o.details,
     comments: o.comments,
     log: describeLog(o.log),
     focusedSeconds: o.focusedSeconds,
     timerSeconds: o.timerSeconds,
    })),
   series: { seriesId: task.seriesId, name: state.getSeriesName(task.seriesId), mixed: state.isMixedSeries(task.seriesId) },
  };
 });
}));

// The dates a task occurs on in [from, to] -- the pause and "Find
// occurrence" calendars only offer these.
router.get('/:taskId/dates', asyncHandler(async (req, res) => {
 await withState(req, res, {}, (state) => {
  const task = state.requireTask(req.params.taskId);
  const from = v.date(req.query.from, 'from');
  const to = v.date(req.query.to, 'to');
  if (to < from) v.fail('to must not be before from');
  if (Date.parse(to) - Date.parse(from) > 400 * 86400000) v.fail('to must be at most about a year after from');
  return { dates: occurrenceDates(state, task, from, to), last: state.lastPossibleOccurrenceDate(task) };
 });
}));

// An action on one task: handler(req, state) applies it (and may return
// extra response fields). The task's notes and log are loaded in full.
function action(handler, { status = 200, full = (req) => [req.params.taskId] } = {}) {
 return asyncHandler(async (req, res) => {
  await withState(req, res, { reportChanges: true, status, fullTaskIds: full(req) }, (state) => handler(req, state) || {});
 });
}

const body = (req) => req.body || {};
const occurrenceDate = (req) => v.date(req.params.date, 'date');

// Create. seriesId joins an existing series.
router.post('/', action((req, state) => {
 const b = body(req);
 const task = state.createTask({ ...v.taskDetails(b), ...v.pattern(b), seriesId: typeof b.seriesId === 'string' ? b.seriesId : null });
 return { taskId: task.taskId };
}, { status: 201, full: () => [] }));

// The Details tab: name, description, details, time, zone, flags.
router.patch('/:taskId', action((req, state) => {
 state.editDetails(req.params.taskId, v.taskDetails(body(req)));
}));

// The Recurrence tab: the pattern, from today on.
router.put('/:taskId/pattern', action((req, state) => {
 state.applyPatternChange(req.params.taskId, v.pattern(body(req)));
}));

router.delete('/:taskId', action((req, state) => {
 state.deleteTask(req.params.taskId);
}));

// The agenda's drag-to-reschedule: dueTime in the user's local time, on
// `date` (the agenda's day, default today).
router.put('/:taskId/due-time', action((req, state) => {
 const b = body(req);
 state.setDueTime(req.params.taskId, v.time(b.dueTime, 'dueTime'), b.date ? v.date(b.date, 'date') : undefined);
}));

router.post('/:taskId/pause', action((req, state) => {
 const b = body(req);
 state.pause(req.params.taskId, v.date(b.from, 'from'), v.date(b.until, 'until'));
}));

router.post('/:taskId/resume', action((req, state) => {
 state.resumeNow(req.params.taskId);
}));

router.post('/:taskId/reset-name', action((req, state) => {
 state.resetNameToSeries(req.params.taskId);
}));

router.post('/:taskId/leave-series', action((req, state) => {
 state.leaveSeries(req.params.taskId);
}));

// Task-level notes; an occurrence's own are under its date below. A note is
// addressed by its timestamp (notes have no ids).
router.post('/:taskId/notes', action((req, state) => {
 state.addTaskNote(req.params.taskId, v.text(body(req).text, 'text', { required: true }).trim());
}));
router.patch('/:taskId/notes/:timestamp', action((req, state) => {
 state.editNote(req.params.taskId, null, Number(req.params.timestamp), v.text(body(req).text, 'text', { required: true }).trim());
}));
router.delete('/:taskId/notes/:timestamp', action((req, state) => {
 state.deleteNote(req.params.taskId, null, Number(req.params.timestamp));
}));

// An extra (manual) occurrence on any date.
router.post('/:taskId/occurrences', action((req, state) => {
 state.addManualOccurrence(req.params.taskId, v.date(body(req).date, 'date'));
}));

// --- One occurrence --------------------------------------------------------------

const OCCURRENCE_ACTIONS = {
 complete: 'complete',
 reopen: 'reopen',
 fail: 'fail',
 unfail: 'unfail',
 dismiss: 'dismiss',
 restore: 'restore',
};

router.post('/:taskId/occurrences/:date/reschedule', action((req, state) => {
 state.rescheduleOccurrence(req.params.taskId, occurrenceDate(req), v.date(body(req).date, 'date'));
}));

router.delete('/:taskId/occurrences/:date', action((req, state) => {
 state.deleteOccurrence(req.params.taskId, occurrenceDate(req));
}));

router.put('/:taskId/occurrences/:date/details', action((req, state) => {
 state.setOccurrenceDetails(req.params.taskId, occurrenceDate(req), v.text(body(req).details, 'details'));
}));

router.post('/:taskId/occurrences/:date/notes', action((req, state) => {
 state.addOccurrenceNote(req.params.taskId, occurrenceDate(req), v.text(body(req).text, 'text', { required: true }).trim());
}));
router.patch('/:taskId/occurrences/:date/notes/:timestamp', action((req, state) => {
 state.editNote(req.params.taskId, occurrenceDate(req), Number(req.params.timestamp), v.text(body(req).text, 'text', { required: true }).trim());
}));
router.delete('/:taskId/occurrences/:date/notes/:timestamp', action((req, state) => {
 state.deleteNote(req.params.taskId, occurrenceDate(req), Number(req.params.timestamp));
}));

// Timer: start it (focusing the occurrence) or just set it for later.
// auto: the auto timer -- a countdown of the task's average measured time
// (see views.autoTimerSeconds), started at once, continuing past zero.
router.post('/:taskId/occurrences/:date/timer', action((req, state) => {
 const b = body(req);
 if (b.auto) {
  const seconds = autoTimerSeconds(state, state.requireTask(req.params.taskId));
  if (!seconds) throw new DomainError('NO_AUTO_TIMER', "This task hasn't been measured yet, or doesn't recur.");
  state.startTimer(req.params.taskId, occurrenceDate(req), { countUp: false, seconds, continuePastZero: b.continuePastZero !== false, start: true });
  return;
 }
 const countUp = !!b.countUp;
 if (!countUp && !(Number(b.minutes) >= 1)) v.fail('minutes must be at least 1');
 state.startTimer(req.params.taskId, occurrenceDate(req), { countUp, minutes: b.minutes, continuePastZero: !!b.continuePastZero, start: b.start !== false });
}));
router.delete('/:taskId/occurrences/:date/timer', action((req, state) => {
 state.cancelTimer(req.params.taskId, occurrenceDate(req));
}));

// complete / reopen / fail / unfail / dismiss / restore -- last, so the
// specific routes above win.
router.post('/:taskId/occurrences/:date/:action', action((req, state) => {
 const method = OCCURRENCE_ACTIONS[req.params.action];
 if (!method) v.fail(`unknown action ${req.params.action}`);
 state[method](req.params.taskId, occurrenceDate(req));
}));

module.exports = router;
