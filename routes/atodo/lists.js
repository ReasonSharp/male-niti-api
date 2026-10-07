const express = require('express');
const asyncHandler = require('../../lib/asyncHandler');
const { withState } = require('../../lib/atodo/domain/request');
const { DomainError } = require('../../lib/atodo/domain/account');
const { dayView, agenda, focusedItem, sessionItem, VIEWS } = require('../../lib/atodo/domain/views');
const { zonedInstant } = require('../../lib/atodo/domain/clock');
const { nextDay } = require('../../lib/atodo/domain/account');
const { stats, statsRecords, manageMonths, seriesDetail, exportData } = require('../../lib/atodo/domain/reports');
const { toUser } = require('../../lib/atodo/token');
const v = require('../../lib/atodo/domain/validate');

// Mounted at /atodo/v1 behind requireAtodoAuth (see routes/atodo/index.js):
// the to-do list one day at a time, the agenda, the focused occurrence,
// Manage Tasks (months, series), stats and the data export. See
// routes/atodo/tasks.js for actions on one task.

const router = express.Router();

// One local day of a view -- or, if it has nothing, the nearest day that
// does in `direction` -- with the nearest non-empty days either side, and
// the focused occurrence (`focused`, wherever it is).
router.get('/days', asyncHandler(async (req, res) => {
 await withState(req, res, {}, (state) => {
  const view = req.query.view || 'pending';
  if (!VIEWS.includes(view)) v.fail(`view must be one of ${VIEWS.join(', ')}`);
  const date = req.query.date ? v.date(req.query.date, 'date') : state.clock.todayISO;
  const direction = req.query.direction === 'before' ? 'before' : 'after';
  return { ...dayView(state, view, date, direction), today: state.clock.todayISO, focused: focusedItem(state) };
 });
}));

// Everything on a local day (default today), with how long each usually
// takes -- the side panel's timeline -- and every focus/timer session that
// ran that day, where it ran (`sessions`): stored ones, ones that ended in
// this request (a timer that ran out) and the one still running.
router.get('/agenda', asyncHandler(async (req, res) => {
 await withState(req, res, {}, async (state, { client }) => {
  const date = req.query.date ? v.date(req.query.date, 'date') : state.clock.todayISO;
  const dayStart = zonedInstant(date, '00:00', state.clock.timeZone);
  const dayEnd = zonedInstant(nextDay(date), '00:00', state.clock.timeZone);
  const overlaps = (startMs, endMs) => startMs < dayEnd && endMs > dayStart;
  const occurrenceById = new Map(state.occurrences.map((o) => [o.id, o]));
  const sessions = [];
  const { rows } = await client.query(
   `SELECT id, occurrence_id, kind, started_at, ended_at FROM atodo.focus_sessions
    WHERE account_id = $1 AND started_at < $3 AND ended_at > $2 ORDER BY started_at`,
   [req.atodoAuth.id, dayStart, dayEnd]
  );
  for (const row of rows) {
   const occurrence = occurrenceById.get(row.occurrence_id);
   const task = occurrence && state.taskByTaskId(occurrence.taskId);
   if (task) sessions.push(sessionItem(state, { id: row.id, task, occurrenceDate: occurrence.occurrenceDate, kind: row.kind, startMs: Number(row.started_at), endMs: Number(row.ended_at) }));
  }
  for (const s of state.newSessions) {
   const task = state.taskByTaskId(s.occurrence.taskId);
   if (task && overlaps(s.startMs, s.endMs)) sessions.push(sessionItem(state, { id: null, task, occurrenceDate: s.occurrence.occurrenceDate, kind: s.kind, startMs: s.startMs, endMs: s.endMs }));
  }
  const live = state.liveSession();
  if (live && overlaps(live.startMs, state.nowMs)) {
   sessions.push(sessionItem(state, { id: null, task: live.task, occurrenceDate: state.active.occurrenceDate, kind: live.kind, startMs: live.startMs, endMs: null }));
  }
  return { date, items: agenda(state, date), sessions, focused: focusedItem(state), now: state.nowMs };
 });
}));

// Deletes one recorded focus/timer session (a bad measurement): its time
// comes off the occurrence's totals too.
router.delete('/focus-sessions/:sessionId', asyncHandler(async (req, res) => {
 await withState(req, res, { reportChanges: true }, async (state, { client }) => {
  if (!/^\d{1,18}$/.test(req.params.sessionId)) throw new DomainError('SESSION_NOT_FOUND', 'No such measurement.', 404);
  const { rows } = await client.query('SELECT * FROM atodo.focus_sessions WHERE account_id = $1 AND id = $2', [req.atodoAuth.id, req.params.sessionId]);
  if (!rows[0]) throw new DomainError('SESSION_NOT_FOUND', 'No such measurement.', 404);
  state.deleteFocusSession(rows[0]);
  return {};
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
