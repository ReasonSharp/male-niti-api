// AccountState's actions, against the rules the client used to apply itself.
const assert = require('node:assert');
const { dayView } = require('../../lib/atodo/domain/views');
const { makeState, advance, task, itemsOf } = require('./helpers');

const itemsOn = (state, view, date) => {
 const day = dayView(state, view, date);
 return day.date === date ? itemsOf(day) : [];
};
const throwsCode = (fn, code, message) => assert.throws(fn, (err) => err.code === code, message);

// --- A pattern change keeps the past --------------------------------------------

{
 const daily = task({ id: 'daily', dueDate: '2026-10-01' });
 const state = makeState({ tasks: [daily], at: '2026-10-05T09:00' });
 state.complete('daily', '2026-10-02');
 state.applyPatternChange('daily', { dueDate: '2026-10-01', frequency: { type: 'days', interval: 2 }, endDate: null, recurUntilCompleted: false });
 // Every date the old pattern produced before today is now a row.
 for (const d of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) assert.ok(state.findOccurrence(daily, d), `${d} kept as a row`);
 assert.strictEqual(daily.frequency.startsOn, '2026-10-05', 'new pattern bounded to today on');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-06'), [], 'every other day from today: not the 6th');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-07'), ['daily@2026-10-07'], '...the 7th');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-02'), ['daily@2026-10-02+done'], 'the past stays as it was');
 assert.strictEqual(daily.log[daily.log.length - 1].message, 'Recurrence pattern edited', 'logged');
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
 assert.strictEqual(last, 'Unfocused and marked done', 'one combined log entry');
 throwsCode(() => state.focus('daily', '2026-10-05'), 'NOT_FOCUSABLE', 'a done occurrence can\'t be focused');
 state.reopen('daily', '2026-10-05');
 assert.strictEqual(state.findOccurrence(daily, '2026-10-05').log.slice(-1)[0].message, 'Unfocused', 'reopening straight back takes the entry back');
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

console.log('account.test.js: all assertions passed');
