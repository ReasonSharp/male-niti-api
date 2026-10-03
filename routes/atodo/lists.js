const express = require('express');
const asyncHandler = require('../../lib/asyncHandler');
const { withState } = require('../../lib/atodo/domain/request');
const { DomainError } = require('../../lib/atodo/domain/account');
const { dayView, agenda, VIEWS } = require('../../lib/atodo/domain/views');
const { stats, statsRecords, manageMonths, seriesDetail, exportData } = require('../../lib/atodo/domain/reports');
const { toUser } = require('../../lib/atodo/token');
const v = require('../../lib/atodo/domain/validate');

// Mounted at /atodo/v1 behind requireAtodoAuth (see routes/atodo/index.js):
// the to-do list one day at a time, the agenda, the focused occurrence,
// Manage Tasks (months, series), stats and the data export. See
// routes/atodo/tasks.js for actions on one task.

const router = express.Router();

// One local day of a view -- or, if it has nothing, the nearest day that
// does in `direction` -- with the nearest non-empty days either side.
router.get('/days', asyncHandler(async (req, res) => {
 await withState(req, res, {}, (state) => {
  const view = req.query.view || 'pending';
  if (!VIEWS.includes(view)) v.fail(`view must be one of ${VIEWS.join(', ')}`);
  const date = req.query.date ? v.date(req.query.date, 'date') : state.clock.todayISO;
  const direction = req.query.direction === 'before' ? 'before' : 'after';
  return { ...dayView(state, view, date, direction), today: state.clock.todayISO };
 });
}));

// Everything on a local day (default today), with how long each usually
// takes -- the side panel's timeline.
router.get('/agenda', asyncHandler(async (req, res) => {
 await withState(req, res, {}, (state) => {
  const date = req.query.date ? v.date(req.query.date, 'date') : state.clock.todayISO;
  return { date, items: agenda(state, date) };
 });
}));

// The focused occurrence: focus one (PUT) or none (DELETE). Focusing
// checkpoints the previously focused one's timer or focus time.
router.put('/focus', asyncHandler(async (req, res) => {
 const b = req.body || {};
 await withState(req, res, { reportChanges: true, fullTaskIds: [b.taskId] }, (state) => {
  if (typeof b.taskId !== 'string') v.fail('taskId is required');
  state.focus(b.taskId, v.date(b.occurrenceDate, 'occurrenceDate'));
  return {};
 });
}));
router.delete('/focus', asyncHandler(async (req, res) => {
 await withState(req, res, { reportChanges: true }, (state) => {
  state.unfocus();
  return {};
 });
}));

// Manage Tasks: which series have occurrences in which months.
router.get('/manage', asyncHandler(async (req, res) => {
 await withState(req, res, {}, (state) => ({ months: manageMonths(state) }));
}));

// A series and its tasks. ?notes=1 adds every member's notes and activity
// and their occurrences' (the side panel's series scope).
router.get('/series/:seriesId', asyncHandler(async (req, res) => {
 const withNotes = req.query.notes === '1';
 await withState(req, res, { fullTaskIds: withNotes ? 'all' : [] }, (state) => {
  const members = state.tasksInSeries(req.params.seriesId);
  if (!members.length) throw new DomainError('SERIES_NOT_FOUND', 'No such series.', 404);
  const detail = seriesDetail(state, req.params.seriesId);
  if (withNotes) {
   const taskIds = new Set(members.map((t) => t.taskId));
   detail.notes = members.map((t) => ({ taskId: t.taskId, name: t.name, dueDate: t.dueDate, comments: t.comments, log: t.log }));
   detail.occurrences = state.occurrences
    .filter((o) => taskIds.has(o.taskId) && (o.comments.length || o.log.length))
    .map((o) => ({ taskId: o.taskId, occurrenceDate: o.occurrenceDate, comments: o.comments, log: o.log }));
  }
  return detail;
 });
}));

// Renaming a series; pulling a single task's series into this one.
router.patch('/series/:seriesId', asyncHandler(async (req, res) => {
 await withState(req, res, { reportChanges: true }, (state) => {
  state.renameSeries(req.params.seriesId, v.text((req.body || {}).name, 'name', { required: true, max: 500 }).trim());
  return {};
 });
}));
router.post('/series/:seriesId/members', asyncHandler(async (req, res) => {
 await withState(req, res, { reportChanges: true }, (state) => {
  const source = (req.body || {}).seriesId;
  if (typeof source !== 'string') v.fail('seriesId is required');
  state.joinSeries(source, req.params.seriesId);
  return {};
 });
}));

// scope=task:<taskId> | series:<seriesId> | all
function parseScope(value) {
 const [kind, id] = String(value || 'all').split(/:(.*)/s);
 if (kind === 'all') return { kind: 'all' };
 if (kind === 'task' && id) return { kind: 'task', taskId: id };
 if (kind === 'series' && id) return { kind: 'series', seriesId: id };
 return v.fail('scope must be task:<taskId>, series:<seriesId> or all');
}

router.get('/stats', asyncHandler(async (req, res) => {
 await withState(req, res, {}, (state) => {
  const scope = parseScope(req.query.scope);
  if (scope.kind === 'task') state.requireTask(scope.taskId);
  return stats(state, scope);
 });
}));

// "Reset stats": the scope's stats start over now.
router.post('/stats/reset', asyncHandler(async (req, res) => {
 await withState(req, res, { reportChanges: true, fullTaskIds: 'all' }, (state) => {
  const scope = parseScope((req.body || {}).scope);
  state.resetStats(statsRecords(state, scope));
  return {};
 });
}));

// Deletes one date's measured focus time across the scope (a bad
// measurement).
router.delete('/stats/focus-time', asyncHandler(async (req, res) => {
 await withState(req, res, { reportChanges: true, fullTaskIds: 'all' }, (state) => {
  const scope = parseScope(req.query.scope);
  const date = v.date(req.query.date, 'date');
  state.clearFocusTime(statsRecords(state, scope).map((t) => t.taskId), date);
  return {};
 });
}));

// Download my data: the whole account, as the file the client used to
// build itself (activity logs left out).
router.get('/export', asyncHandler(async (req, res) => {
 await withState(req, res, { fullTaskIds: 'all' }, (state, { account }) => {
  const user = toUser(account);
  const profile = {
   nickname: user.nickname,
   avatar: user.avatar,
   timeFormat: user.timeFormat,
   background: user.background,
   language: user.language,
   theme: user.theme,
   weekStart: user.weekStart,
  };
  return exportData(state, account, profile);
 });
}));

module.exports = router;
