// AccountState's actions, against the rules the client used to apply itself.
const assert = require('node:assert');
const { dayView } = require('../../lib/atodo/domain/views');
const { makeState, advance, task, itemsOf } = require('./helpers');

const itemsOn = (state, view, date) => {
 const day = dayView(state, view, date);
 return day.date === date ? itemsOf(day) : [];
};
const throwsCode = (fn, code, message) => assert.throws(fn, (err) => err.code === code, message);

// --- A pattern change that alters the past is the user's to resolve ---------------

const everyOtherDay = { dueDate: '2026-10-01', frequency: { type: 'days', interval: 2 }, endDate: null, recurUntilCompleted: false };
const needsChoice = (fn, message) => {
 let details = null;
 assert.throws(fn, (err) => {
  details = err.details;
  return err.code === 'PATTERN_CHANGE_NEEDS_CHOICE';
 }, message);
 return details;
};

{
 const daily = task({ id: 'daily', dueDate: '2026-10-01' });
 const state = makeState({ tasks: [daily], at: '2026-10-05T09:00' });
 state.complete('daily', '2026-10-02');
 const details = needsChoice(() => state.applyPatternChange('daily', everyOtherDay), 'every day -> every other day changes the past: refused');
 assert.strictEqual(details.today, '2026-10-05', 'with today');
 assert.ok(details.recordedDates.includes('2026-10-02'), 'and the past occurrences with something recorded');
 assert.strictEqual(daily.frequency.interval, 1, 'nothing changed');
 assert.strictEqual(state.findOccurrence(daily, '2026-10-03'), null, 'nothing saved');

 state.applyPatternChange('daily', everyOtherDay, { mode: 'from', date: '2026-10-05' });
 // Every date the old pattern produced before today is now a row.
 for (const d of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) assert.ok(state.findOccurrence(daily, d), `${d} kept as a row`);
 assert.strictEqual(daily.frequency.startsOn, '2026-10-05', 'new pattern bounded to today on');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-06'), [], 'every other day from today: not the 6th');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-07'), ['daily@2026-10-07'], '...the 7th');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-02'), ['daily@2026-10-02+done'], 'the past stays as it was');
 assert.strictEqual(daily.log[daily.log.length - 1].message, 'Recurrence pattern edited', 'logged');
}

{
 // Recalculating: the past follows the new pattern; every past occurrence goes.
 const daily = task({ id: 'daily', dueDate: '2026-10-01' });
 const state = makeState({ tasks: [daily], at: '2026-10-05T09:00' });
 state.complete('daily', '2026-10-02');
 state.addOccurrenceNote('daily', '2026-10-03', 'a note');
 state.applyPatternChange('daily', everyOtherDay, { mode: 'recalculate' });
 assert.ok(!state.occurrences.some((o) => o.occurrenceDate < '2026-10-05'), 'every past occurrence deleted');
 assert.strictEqual(daily.dueDate, '2026-10-01', 'the due date is the user\'s');
 assert.ok(!daily.frequency.startsOn, 'the new pattern from its due date');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-03'), ['daily@2026-10-03+overdue'], 'the past follows it: the 3rd (not done)');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-02'), [], '...not the 2nd');
}

{
 // From a date in the past: earlier dates keep the old pattern; occurrences from it on go.
 const daily = task({ id: 'daily', dueDate: '2026-10-01' });
 const state = makeState({ tasks: [daily], at: '2026-10-08T09:00' });
 state.complete('daily', '2026-10-02');
 state.complete('daily', '2026-10-06');
 state.applyPatternChange('daily', everyOtherDay, { mode: 'from', date: '2026-10-04' });
 assert.ok(state.findOccurrence(daily, '2026-10-02').status === 'completed', 'before it: kept');
 assert.ok(state.findOccurrence(daily, '2026-10-03'), 'the old pattern\'s dates before it, kept');
 assert.strictEqual(state.findOccurrence(daily, '2026-10-06'), null, 'from it on: deleted, done or not');
 assert.strictEqual(daily.frequency.startsOn, '2026-10-04', 'the new pattern starts on it');
 assert.strictEqual(daily.dueDate, '2026-10-01', 'the due date is the user\'s');
 assert.throws(() => state.applyPatternChange('daily', { ...everyOtherDay, frequency: { type: 'days', interval: 3 } }, { mode: 'from', date: '2026-10-20' }), (err) => err.code === 'VALIDATION_ERROR', 'a date after today is refused');
}

{
 // A change that leaves the past alone applies at once.
 const daily = task({ id: 'daily', dueDate: '2026-10-01' });
 const state = makeState({ tasks: [daily], at: '2026-10-05T09:00' });
 state.applyPatternChange('daily', { dueDate: '2026-10-01', frequency: { type: 'days', interval: 1 }, endDate: '2026-12-31', recurUntilCompleted: false });
 assert.strictEqual(daily.endDate, '2026-12-31', 'an end date in the future: applied');
}

// --- Moving a one-off moves its row ---------------------------------------------

{
 const once = task({ id: 'once', dueDate: '2026-10-05', frequency: { type: 'once', interval: 1 } });
 const state = makeState({ tasks: [once], at: '2026-10-05T09:00' });
 state.addOccurrenceNote('once', '2026-10-05', 'remember this');
 state.applyPatternChange('once', { dueDate: '2026-10-08', frequency: { type: 'once', interval: 1 }, endDate: null, recurUntilCompleted: false });
 assert.strictEqual(state.findOccurrence(once, '2026-10-08').comments[0].text, 'remember this', 'the row moved with the date');
 assert.strictEqual(state.findOccurrence(once, '2026-10-05'), null, 'nothing left behind');
}

// --- Pause and resume ----------------------------------------------------------

{
 const daily = task({ id: 'daily', dueDate: '2026-10-01' });
 const state = makeState({ tasks: [daily], at: '2026-10-05T09:00' });
 state.pause('daily', '2026-10-05', '2026-10-10');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-07'), [], 'paused span is empty');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-10'), ['daily@2026-10-10'], 'resumes on the date');
 assert.deepStrictEqual(daily.frequency.pause, { from: '2026-10-05', until: '2026-10-10' }, 'pause recorded');
 assert.ok(dayView(state, 'all', '2026-10-10').items[0].actions.includes('resume'), 'resume offered while paused');
 state.resumeNow('daily');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-06'), ['daily@2026-10-06'], 'resumed today on');
 assert.strictEqual(daily.frequency.pause, undefined, 'pause ended');
 throwsCode(() => state.resumeNow('daily'), 'NOT_PAUSED', 'resuming twice is refused');
}

{
 // A recurUntilCompleted task's live occurrence just moves.
 const ruc = task({ id: 'ruc', dueDate: '2026-10-05', recurUntilCompleted: true, frequency: { type: 'days', interval: 7 } });
 const state = makeState({ tasks: [ruc], at: '2026-10-05T09:00' });
 state.ensureOccurrence(ruc, '2026-10-05');
 state.pause('ruc', '2026-10-05', '2026-10-09');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-09'), ['ruc@2026-10-09'], 'live occurrence moved to the resume date');
}

// --- Reschedule, delete, manual occurrences --------------------------------------

{
 const daily = task({ id: 'daily', dueDate: '2026-10-01' });
 const state = makeState({ tasks: [daily], at: '2026-10-05T09:00' });
 state.addOccurrenceNote('daily', '2026-10-05', 'n');
 state.rescheduleOccurrence('daily', '2026-10-05', '2026-10-08');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-06'), [], 'moving forward skips the days in between');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-08'), ['daily@2026-10-08'], 'the moved one is there');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-09'), ['daily@2026-10-09'], 'recurrence continues after');
 throwsCode(() => state.rescheduleOccurrence('daily', '2026-10-12', '2026-10-13'), 'NOT_RESCHEDULABLE', 'only a recorded row can be rescheduled');

 state.deleteOccurrence('daily', '2026-10-09');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-09'), [], 'deleted');
 assert.ok(daily.frequency.skipDates.includes('2026-10-09'), '...and skipped by the pattern');

 state.addManualOccurrence('daily', '2026-09-20');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-09-20'), ['daily@2026-09-20+overdue'], 'an extra occurrence before the task started');
 throwsCode(() => state.addManualOccurrence('daily', '2026-10-10'), 'OCCURRENCE_EXISTS', 'not on a date it already occurs on');
}

// --- Focus and timers ------------------------------------------------------------

{
 const daily = task({ id: 'daily', dueDate: '2026-10-01', dueTime: '18:00' });
 const state = makeState({ tasks: [daily], at: '2026-10-05T09:00' });
 state.focus('daily', '2026-10-05');
 assert.ok(state.active.focusSince, 'a focus-only session starts');
 advance(state, '2026-10-05T09:30');
 state.unfocus();
 assert.strictEqual(state.findOccurrence(daily, '2026-10-05').focusedSeconds, 1800, 'its time is credited on unfocus');
 const log = state.findOccurrence(daily, '2026-10-05').log.map((e) => e.message);
 assert.deepStrictEqual(log, ['Focused', 'Unfocused'], 'focus logged');

 state.startTimer('daily', '2026-10-05', { minutes: 25, start: true });
 assert.strictEqual(state.active.taskId, 'daily', 'starting a timer focuses');
 advance(state, '2026-10-05T09:40');
 const item = dayView(state, 'all', '2026-10-05').items[0];
 assert.ok(item.timer && item.timer.runningSince, 'the item carries its running timer');
 assert.ok(item.actions.includes('pauseTimer') && item.actions.includes('cancelTimer'), 'timer actions');
 advance(state, '2026-10-05T10:00');
 state.runMaintenance();
 assert.strictEqual(state.findOccurrence(daily, '2026-10-05').timer, null, 'a finished countdown expires');
 assert.strictEqual(state.findOccurrence(daily, '2026-10-05').timerSeconds, 1500, 'its 25 minutes are credited');
 assert.strictEqual(state.active.taskId, null, '...and unfocuses');
 assert.deepStrictEqual(state.expiredTimers, [{ taskId: 'daily', occurrenceDate: '2026-10-05' }], 'reported for the chime');

 // Completing the focused occurrence unfocuses it.
 state.focus('daily', '2026-10-05');
 state.complete('daily', '2026-10-05');
 assert.strictEqual(state.active.taskId, null, 'completing unfocuses');
 const last = state.findOccurrence(daily, '2026-10-05').log.slice(-1)[0].message;
 assert.strictEqual(last, 'Marked done', 'what the user did: marked it done (the unfocus follows from it)');
 throwsCode(() => state.focus('daily', '2026-10-05'), 'NOT_FOCUSABLE', 'a done occurrence can\'t be focused');
 state.reopen('daily', '2026-10-05');
 assert.notStrictEqual(state.findOccurrence(daily, '2026-10-05').log.slice(-1)[0].message, 'Marked done', 'reopening straight back takes the entry back');
}

// --- The activity log: one entry per user action, only what the user did -------

{
 const a = task({ id: 'a', dueDate: '2026-10-05' });
 const b = task({ id: 'b', dueDate: '2026-10-05' });
 const state = makeState({ tasks: [a, b], at: '2026-10-05T09:00' });
 const logOf = (t) => (state.findOccurrence(t, '2026-10-05') || { log: [] }).log.map((e) => e.message);

 state.focus('a', '2026-10-05');
 assert.deepStrictEqual(logOf(a), ['Focused'], 'focusing: "Focused"');
 advance(state, '2026-10-05T09:01');
 state.startTimer('b', '2026-10-05', { minutes: 25, start: true });
 assert.deepStrictEqual(logOf(b), ['Timer set'], 'setting a timer: only "Timer set" (not "Focused" too)');
 assert.deepStrictEqual(logOf(a), ['Focused', 'Unfocused by another task'], 'the one it took the focus from is told');
 advance(state, '2026-10-05T09:05');
 state.unfocus();
 assert.deepStrictEqual(logOf(b), ['Timer set', 'Timer paused'], 'pausing the timer: "Timer paused"');
 advance(state, '2026-10-05T09:20');
 state.focus('b', '2026-10-05');
 assert.deepStrictEqual(logOf(b), ['Timer set', 'Timer paused', 'Timer resumed'], 'resuming it: "Timer resumed"');
 advance(state, '2026-10-05T09:22');
 state.complete('b', '2026-10-05');
 assert.deepStrictEqual(logOf(b), ['Timer set', 'Timer paused', 'Timer resumed', 'Marked done'], 'marking it done while timed: only "Marked done"');

 state.startTimer('a', '2026-10-05', { minutes: 1, start: true });
 advance(state, '2026-10-05T09:30');
 state.runMaintenance();
 assert.strictEqual(state.findOccurrence(a, '2026-10-05').timer, null, 'the timer ran out');
 assert.deepStrictEqual(logOf(a), ['Focused', 'Unfocused by another task', 'Timer set', 'Timer expired'], 'a timer stopping by itself: "Timer expired"');
 assert.strictEqual(state.findOccurrence(a, '2026-10-05').log.slice(-1)[0].timestamp, require('./helpers').zagreb('2026-10-05T09:23'), 'at the moment it ran out (its minute from 09:22)');

 state.focus('a', '2026-10-05');
 advance(state, '2026-10-05T09:30:05');
 state.unfocus();
 assert.deepStrictEqual(logOf(a), ['Focused', 'Unfocused by another task', 'Timer set', 'Timer expired'], 'a focus toggled straight back (a misclick): neither entry stays');

 const c = task({ id: 'c', dueDate: '2026-10-05' });
 state.tasks.push(c);
 state.startTimer('c', '2026-10-05', { minutes: 1, continuePastZero: true, start: true });
 advance(state, '2026-10-05T09:40');
 state.runMaintenance();
 assert.ok(state.findOccurrence(c, '2026-10-05').timer, 'a countdown that continues past zero keeps counting');
 assert.deepStrictEqual(logOf(c), ['Timer set'], '...and writes nothing yet');
}

{
 // The editor's Save changing both the details and the pattern: one entry.
 const t = task({ id: 'ed', dueDate: '2026-10-05', name: 'Before' });
 const state = makeState({ tasks: [t], at: '2026-10-05T09:00' });
 const details = { name: 'After', description: '', details: '', dueTime: '18:00', allDay: false, appointment: false, passive: false, timeZone: null };
 state.editTask('ed', details, { dueDate: '2026-10-05', frequency: { type: 'days', interval: 1 }, endDate: '2026-12-31', recurUntilCompleted: false });
 assert.deepStrictEqual(t.log.map((e) => e.message), ['Edited'], 'details and pattern in one Save: one "Edited"');
 assert.strictEqual(t.name, 'After', 'the details saved');
 assert.strictEqual(t.endDate, '2026-12-31', 'and the pattern');
 state.editTask('ed', details, { dueDate: '2026-10-05', frequency: { type: 'days', interval: 1 }, endDate: '2026-12-31', recurUntilCompleted: false });
 assert.strictEqual(t.log.length, 1, 'nothing changed: nothing logged');
}

// --- Tomorrow's tasks today: future occurrences can be worked on and done ---------

{
 const daily = task({ id: 'daily', dueDate: '2026-10-01' });
 const state = makeState({ tasks: [daily], at: '2026-10-05T09:00' });
 const tomorrow = () => dayView(state, 'all', '2026-10-06').items[0];
 for (const action of ['timer', 'focus', 'complete']) assert.ok(tomorrow().actions.includes(action), `tomorrow's occurrence offers ${action}`);
 state.focus('daily', '2026-10-06');
 assert.strictEqual(state.active.occurrenceDate, '2026-10-06', 'it can be focused');
 state.runMaintenance();
 assert.strictEqual(state.active.occurrenceDate, '2026-10-06', '...and stays focused (upkeep no longer drops a future one)');
 state.startTimer('daily', '2026-10-06', { minutes: 20, start: true });
 assert.ok(state.findOccurrence(daily, '2026-10-06').timer, 'it can be timed');
 advance(state, '2026-10-05T09:10');
 state.complete('daily', '2026-10-06');
 assert.strictEqual(state.findOccurrence(daily, '2026-10-06').status, 'completed', 'it can be marked done');
 assert.ok(state.findOccurrence(daily, '2026-10-06').timerSeconds >= 600, 'its timed time credited');
 const today = state.findOccurrence(daily, '2026-10-05');
 assert.ok(!today || (!today.dismissed && today.status === 'pending'), "today's own occurrence is left be -- not swept off as an earlier one");
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-05'), ['daily@2026-10-05'], 'today still shows, to do');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-06'), ['daily@2026-10-06+done'], 'tomorrow shows done');
 const { stats } = require('../../lib/atodo/domain/reports');
 const taskStats = stats(state, { kind: 'task', taskId: 'daily' });
 assert.ok(taskStats.completionRate <= 100, 'the completion rate counts the early one as an occurrence to date');
 state.reopen('daily', '2026-10-06');
 assert.strictEqual(state.findOccurrence(daily, '2026-10-06').status, 'pending', 'and taken back');
}

{
 // A recur-until-completed task's next cycle, done ahead of its date.
 const weekly = task({ id: 'weekly', dueDate: '2026-10-05', recurUntilCompleted: true, frequency: { type: 'weeks', interval: 1 } });
 const state = makeState({ tasks: [weekly], occurrences: [{ id: 'w1', taskId: 'weekly', occurrenceDate: '2026-10-05', status: 'completed', resolvedAt: 1, dismissed: false, manual: false, pendingReschedules: [], comments: [], log: [] }, { id: 'w2', taskId: 'weekly', occurrenceDate: '2026-10-12', status: 'pending', resolvedAt: null, dismissed: false, manual: false, pendingReschedules: [], comments: [], log: [] }], at: '2026-10-05T12:00' });
 assert.ok(dayView(state, 'all', '2026-10-12').items[0].actions.includes('complete'), 'next week\'s cycle offers complete');
 state.complete('weekly', '2026-10-12');
 assert.strictEqual(state.findOccurrence(weekly, '2026-10-12').status, 'completed', 'done early');
 assert.strictEqual(state.findOccurrence(weekly, null).occurrenceDate, '2026-10-19', 'the cycle after it is next');
}

{
 // A passive reminder for tomorrow can be marked failed already.
 const reminder = task({ id: 'rem', dueDate: '2026-10-06', passive: true, frequency: { type: 'once', interval: 1 } });
 const state = makeState({ tasks: [reminder], at: '2026-10-05T12:00' });
 state.fail('rem', '2026-10-06');
 assert.strictEqual(state.findOccurrence(reminder, '2026-10-06').status, 'failed', 'marked failed ahead of its day');
}

// --- Notes, limits, locked tasks ------------------------------------------------

{
 const tasks = Array.from({ length: 11 }, (_, i) => task({ id: `o${i}`, frequency: { type: 'once', interval: 1 }, dueDate: '2026-10-06', createdAt: i }));
 const state = makeState({ tasks, at: '2026-10-05T09:00', subscriptionActive: false });
 for (let i = 0; i < 5; i++) state.addTaskNote('o0', `note ${i}`);
 throwsCode(() => state.addTaskNote('o0', 'one too many'), 'NOTE_LIMIT', 'five notes per task on the free plan');
 throwsCode(() => state.addTaskNote('o10', 'x'), 'TASK_LOCKED', 'the eleventh one-off task is locked');
 advance(state, '2026-10-06T09:00');
 throwsCode(() => state.complete('o10', '2026-10-06'), 'TASK_LOCKED', '...and can\'t be completed');
 throwsCode(() => state.createTask({ name: 'x', dueDate: '2026-10-07', frequency: { type: 'once', interval: 1 } }), 'TASK_LIMIT', 'no new one-off task beyond the limit');
 const recurring = state.createTask({ name: 'r', dueDate: '2026-10-07', frequency: { type: 'days', interval: 1 } });
 assert.ok(recurring.taskId, 'a recurring one is still allowed');
}

// --- Editing details; series ----------------------------------------------------

{
 const a = task({ id: 'a', name: 'Alpha', seriesId: 'S' });
 const b = task({ id: 'b', name: 'Beta', seriesId: 'S', dueDate: '2026-10-02' });
 const state = makeState({ tasks: [a, b], at: '2026-10-05T09:00' });
 assert.strictEqual(state.displayName(b), 'Alpha: Beta', 'a mixed series shows its name');
 state.editDetails('a', { name: 'Alpha 2', description: '', details: '', dueTime: '18:00', allDay: false, appointment: false, passive: false });
 assert.strictEqual(state.getSeriesName('S'), 'Alpha', 'renaming the first member froze the series name');
 assert.strictEqual(state.displayName(b), 'Alpha: Beta', '...so the label didn\'t change');
 state.leaveSeries('b');
 assert.strictEqual(state.displayName(b), 'Beta', 'out of the series');
 state.joinSeries(b.seriesId, 'S');
 assert.strictEqual(b.seriesId, 'S', 'pulled back in');
 state.renameSeries('S', 'Greek');
 assert.strictEqual(state.displayName(b), 'Greek: Beta', 'renamed series');

 state.deleteTask('a');
 assert.strictEqual(state.taskByTaskId('a'), null, 'deleted');
}

// --- Stats reset ----------------------------------------------------------------

{
 const daily = task({ id: 'daily', dueDate: '2026-10-01' });
 const state = makeState({ tasks: [daily], at: '2026-10-05T09:00' });
 state.focus('daily', '2026-10-05');
 advance(state, '2026-10-05T09:10');
 state.unfocus();
 state.resetStats([daily]);
 assert.strictEqual(state.findOccurrence(daily, '2026-10-05').focusedSeconds, 0, 'measured time cleared');
 assert.ok(daily.statsResetAt, 'reset point recorded');
 assert.strictEqual(state.countsTowardStats(daily, '2026-10-04'), false, 'earlier days no longer count');
 assert.strictEqual(state.countsTowardStats(daily, '2026-10-05'), true, 'today still does');
}

// --- Dragging a fixed-zone task on the agenda ----------------------------------------

{
 const ny = task({ id: 'ny', dueDate: '2026-10-01', allDay: false, dueTime: '09:00', timeZone: 'America/New_York' });
 const state = makeState({ tasks: [ny], at: '2026-10-05T09:00' });
 // Zagreb is 6 hours ahead of New York in October: 16:00 local is 10:00 there.
 state.setDueTime('ny', '16:00');
 assert.strictEqual(ny.dueTime, '10:00', 'local time converted to the task zone');
 const fluid = task({ id: 'fluid', dueDate: '2026-10-01', allDay: false, dueTime: '09:00' });
 const state2 = makeState({ tasks: [fluid], at: '2026-10-05T09:00' });
 state2.setDueTime('fluid', '16:00');
 assert.strictEqual(fluid.dueTime, '16:00', 'a fluid task takes it as is');
}

// --- Changing a task's kind counts against the free plan's limits --------------------

{
 const daily = (id) => task({ id, dueDate: '2026-10-01' });
 const once = (id) => task({ id, dueDate: '2026-10-05', frequency: { type: 'once', interval: 1 } });
 const toDaily = { dueDate: '2026-10-05', frequency: { type: 'days', interval: 1 }, endDate: null, recurUntilCompleted: false };
 const state = makeState({ tasks: ['a', 'b', 'c', 'd', 'e'].map(daily).concat([once('x')]), subscriptionActive: false });
 throwsCode(() => state.applyPatternChange('x', toDaily), 'TASK_LIMIT', 'a sixth recurring task by editing a one-off is refused');
 assert.strictEqual(state.taskByTaskId('x').frequency.type, 'once', '...and the task is left as it was');
 state.applyPatternChange('x', { ...toDaily, dueDate: '2026-10-06', frequency: { type: 'once', interval: 1 } });
 assert.strictEqual(state.taskByTaskId('x').dueDate, '2026-10-06', 'a one-off can still be moved');
 const tenOnce = makeState({ tasks: Array.from({ length: 10 }, (_, i) => once(`o${i}`)).concat([daily('r')]), subscriptionActive: false });
 throwsCode(() => tenOnce.applyPatternChange('r', { ...toDaily, frequency: { type: 'once', interval: 1 } }), 'TASK_LIMIT', 'an eleventh one-off by editing a recurring task is refused');
 const subscribed = makeState({ tasks: ['a', 'b', 'c', 'd', 'e'].map(daily).concat([once('x')]), subscriptionActive: true });
 subscribed.applyPatternChange('x', toDaily);
 assert.strictEqual(subscribed.taskByTaskId('x').frequency.type, 'days', 'a subscriber has no limit');
}

// --- Passive and recur-until-completed don't go together ---------------------------

{
 const state = makeState({ tasks: [task({ id: 'p', passive: true }), task({ id: 'r', recurUntilCompleted: true })] });
 const base = { name: 'x', dueDate: '2026-10-05', frequency: { type: 'days', interval: 1 }, endDate: null };
 throwsCode(() => state.createTask({ ...base, passive: true, recurUntilCompleted: true }), 'VALIDATION_ERROR', 'not created both');
 throwsCode(() => state.applyPatternChange('p', { ...base, recurUntilCompleted: true }), 'VALIDATION_ERROR', 'a passive task can\'t be made to recur until completed');
 throwsCode(() => state.editDetails('r', { name: 'r', allDay: false, dueTime: '18:00', passive: true }), 'VALIDATION_ERROR', 'a recur-until-completed task can\'t be made passive');
}

// --- Focus/timer sessions are recorded as they ran -------------------------------

{
 const { makeClock } = require('../../lib/atodo/domain/clock');
 const t = task({ id: 's', dueDate: '2026-10-01', dueTime: '18:00' });
 const state = makeState({ tasks: [t], at: '2026-10-05T09:00' });
 const later = (ms) => {
  state.clock = makeClock(state.clock.timeZone, state.clock.nowMs + ms);
 };
 const t0 = state.nowMs;
 state.focus('s', '2026-10-05');
 assert.ok(state.liveSession() && state.liveSession().kind === 'focus' && state.liveSession().startMs === t0, 'a running focus session is live, not recorded yet');
 assert.strictEqual(state.newSessions.length, 0, '...nothing recorded while it runs');
 later(10 * 60000);
 state.unfocus();
 assert.strictEqual(state.newSessions.length, 1, 'unfocusing records the session');
 const [focusSession] = state.newSessions;
 assert.deepStrictEqual([focusSession.kind, focusSession.startMs, focusSession.endMs, focusSession.seconds], ['focus', t0, t0 + 600000, 600], '...as it ran');
 assert.strictEqual(state.findOccurrence(t, '2026-10-05').focusedSeconds, 600, '...and credits the occurrence');
 assert.strictEqual(state.liveSession(), null, 'nothing running afterwards');

 // A countdown that runs out is recorded only up to the moment it did.
 later(60000);
 const t1 = state.nowMs;
 state.startTimer('s', '2026-10-05', { countUp: false, minutes: 5, continuePastZero: false, start: true });
 assert.strictEqual(state.liveSession().kind, 'timer', 'a running timer is the live session');
 later(20 * 60000);
 state.expireFinishedTimers();
 const timerSession = state.newSessions[1];
 assert.deepStrictEqual([timerSession.kind, timerSession.startMs, timerSession.endMs, timerSession.seconds], ['timer', t1, t1 + 300000, 300], 'an expired timer: recorded up to its end');

 // Deleting a stored session takes its time off the occurrence.
 const occurrence = state.findOccurrence(t, '2026-10-05');
 state.deleteFocusSession({ id: 7, occurrence_id: occurrence.id, kind: 'timer', seconds: 300 });
 assert.strictEqual(occurrence.timerSeconds, 0, 'deleting a measurement subtracts it');
 assert.deepStrictEqual(state.deletedSessionIds, ['7'], '...and deletes it by id');
 throwsCode(() => state.deleteFocusSession({ id: 8, occurrence_id: 'gone', kind: 'focus', seconds: 1 }), 'SESSION_NOT_FOUND', 'a session of no occurrence: not found');

 // A stats reset clears the scope's sessions with its totals.
 state.resetStats([t]);
 assert.ok(state.clearedSessionOccurrenceIds.has(occurrence.id), 'resetting stats clears the sessions too');
}

{
 // Reopening a recur-until-completed cycle takes its successor's sessions.
 const state = makeState({ tasks: [], at: '2026-10-05T09:00' });
 const t = state.createTask({ name: 'r', dueDate: '2026-10-05', dueTime: '18:00', allDay: false, recurUntilCompleted: true, frequency: { type: 'days', interval: 3 }, endDate: null });
 state.complete(t.taskId, '2026-10-05');
 const successor = state.findOccurrence(t, null);
 const reopened = state.occurrences.find((o) => o.status === 'completed');
 state.reopen(t.taskId, '2026-10-05');
 assert.deepStrictEqual(state.sessionMoves, [{ from: successor.id, to: reopened.id }], 'the successor\'s sessions move to the reopened occurrence');
}

// --- Becoming recur-until-completed: the due date stays, the chain starts right --

{
 const firstFriday = { type: 'months', dayMode: 'weekday', ordinal: 1, weekday: 5, interval: 1 };
 const toRuc = (state, dueDate = '2026-09-04', resolution) => state.applyPatternChange('confess', { dueDate, frequency: firstFriday, endDate: null, recurUntilCompleted: true }, resolution);
 const row = (date, fields = {}) => ({ id: `o${date}`, taskId: 'confess', occurrenceDate: date, status: 'completed', resolvedAt: 1, dismissed: false, manual: false, pendingReschedules: [], comments: [], log: [], ...fields });
 const make = (occurrences) => {
  const t = task({ id: 'confess', dueDate: '2026-09-04', dueTime: '11:00', frequency: firstFriday });
  return { t, state: makeState({ tasks: [t], occurrences, at: '2026-10-06T17:00' }) };
 };

 let { t, state } = make([row('2026-09-04')]);
 toRuc(state);
 assert.strictEqual(t.dueDate, '2026-09-04', 'the due date is never moved');
 const live = state.findOccurrence(t, null);
 assert.strictEqual(live.occurrenceDate, '2026-10-02', 'the missed 2 October occurrence is carried');
 assert.deepStrictEqual(live.pendingReschedules, ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'], 'to today');
 assert.ok(!state.occurrences.some((o) => o.occurrenceDate === '2026-11-06'), 'no jump to the next first Friday');
 assert.deepStrictEqual(itemsOn(state, 'next-recurrence', '2026-10-06'), ['confess@2026-10-06'], 'it shows today, still to do');

 ({ t, state } = make([row('2026-09-04'), row('2026-10-02')]));
 toRuc(state);
 assert.strictEqual(t.dueDate, '2026-09-04', 'the latest one done: the due date stays');
 assert.strictEqual(state.findOccurrence(t, null).occurrenceDate, '2026-11-06', 'and the chain starts at the next date');

 ({ t, state } = make([row('2026-09-04'), row('2026-10-02', { status: 'pending', resolvedAt: null, dismissed: true })]));
 toRuc(state);
 assert.strictEqual(state.findOccurrence(t, null).occurrenceDate, '2026-11-06', 'the latest one dismissed: not revived');

 ({ t, state } = make([]));
 needsChoice(() => toRuc(state), 'two missed dates: only one can be carried, so the past would change -- refused');
 toRuc(state, '2026-09-04', { mode: 'recalculate' });
 assert.strictEqual(state.findOccurrence(t, null).occurrenceDate, '2026-09-04', 'recalculated: the chain from the first date on or after the due date');

 ({ t, state } = make([row('2026-09-04')]));
 needsChoice(() => toRuc(state, '2026-12-01'), 'starting in December would drop the missed 2 October from the past -- refused');
 toRuc(state, '2026-12-01', { mode: 'from', date: '2026-10-06' });
 assert.strictEqual(t.dueDate, '2026-12-01', 'the due date as the user set it');
 assert.strictEqual(state.findOccurrence(t, null).occurrenceDate, '2026-12-04', 'the chain from the first date on or after it');
 assert.ok(state.findOccurrence(t, '2026-10-02'), 'the old pattern\'s 2 October kept');
}

{
 // The reported case: due 1 October, "1 day before the first Friday", done.
 const dayBeforeFirstFriday = { type: 'months', dayMode: 'multi-weekday-offset', ordinal: 1, interval: 1, weekdays: [5], offsetDays: 1, offsetDirection: 'before' };
 const t = task({ id: 'prep', dueDate: '2026-10-01', frequency: dayBeforeFirstFriday });
 const state = makeState({ tasks: [t], at: '2026-10-11T12:00' });
 state.complete('prep', '2026-10-01');
 state.applyPatternChange('prep', { dueDate: '2026-10-01', frequency: dayBeforeFirstFriday, endDate: null, recurUntilCompleted: true });
 assert.strictEqual(t.dueDate, '2026-10-01', 'the due date stays 1 October');
 assert.strictEqual(state.findOccurrence(t, null).occurrenceDate, '2026-11-05', 'the next cycle is the live occurrence');
}

{
 // Created as recur-until-completed off its pattern: the due date as entered.
 const state = makeState({ at: '2026-10-05T09:00' });
 const created = state.createTask({ name: 'x', dueDate: '2026-10-05', dueTime: null, allDay: true, recurUntilCompleted: true, frequency: { type: 'months', dayMode: 'weekday', ordinal: 1, weekday: 5, interval: 1 }, endDate: null });
 assert.strictEqual(created.dueDate, '2026-10-05', 'the due date as entered');
 assert.strictEqual(state.findOccurrence(created, null).occurrenceDate, '2026-11-06', 'the first occurrence on the first pattern date from it');
}

console.log('account.test.js: all assertions passed');
