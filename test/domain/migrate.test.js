const assert = require('node:assert');
const { prepareImport } = require('../../lib/atodo/domain/migrate');

// --- The oldest exports: per-date state as maps on the task records ------------

{
 // A first-Friday task with a "this occurrence only" edit, as a September
 // export had it: a one-off fragment (done) and the recurring record.
 const tasks = [
  {
   id: 'acg9wzn', taskId: 'w2wunr5', seriesId: 't2666ka', name: 'Confession', dueDate: '2026-09-08', dueTime: '19:00',
   allDay: false, appointment: false, passive: false, frequency: { type: 'once', interval: 1 }, endDate: null,
   completions: { '2026-09-08': true }, dismissed: { '2026-09-08': true }, markedFailed: {},
   log: [{ message: 'Marked done', timestamp: 1 }],
  },
  {
   id: '3jwfip6', taskId: 'w2wunr5', seriesId: 't2666ka', name: 'Confession', dueDate: '2026-10-02', dueTime: '11:00',
   allDay: false, appointment: false, passive: false, frequency: { type: 'months', interval: 1, dayMode: 'weekday', weekday: 5, ordinal: 1 },
   endDate: null, completions: {}, dismissed: {}, markedFailed: {},
   focusLog: { '2026-10-02': { focusedSeconds: 4.6, timerSeconds: 2674.559 } },
   timer: { mode: 'countup', runningSince: null, totalSeconds: 0, occurrenceDate: '2026-10-02', continuePastZero: true, remainingSeconds: -12 },
  },
  {
   id: 'ruc', taskId: 'ruc', seriesId: 'ruc', name: 'Shave', dueDate: '2026-09-17', dueTime: null, allDay: true,
   appointment: false, passive: false, recurUntilCompleted: true, frequency: { type: 'days', interval: 7 }, endDate: null,
   completions: { '2026-09-10': true }, dismissed: { '2026-09-10': true }, markedFailed: {}, pendingReschedules: ['2026-09-18', '2026-09-19'],
  },
  {
   id: 'reminder', taskId: 'reminder', seriesId: 'reminder', name: 'Reminder', dueDate: '2026-09-15', dueTime: null, allDay: true,
   appointment: false, passive: true, frequency: { type: 'days', interval: 1 }, endDate: null,
   completions: {}, dismissed: {}, markedFailed: { '2026-09-15': true },
  },
 ];
 const { tasks: kept, occurrences } = prepareImport(tasks, []);
 const rows = (taskId) => occurrences.filter((o) => o.taskId === taskId).sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));
 const legacy = ['completions', 'dismissed', 'markedFailed', 'focusLog', 'timer', 'pendingReschedules'];

 assert.strictEqual(kept.filter((t) => t.taskId === 'w2wunr5').length, 1, 'fragments merged into one task');
 assert.ok(kept.every((t) => legacy.every((field) => !(field in t))), 'no maps left on any task');
 const confession = rows('w2wunr5');
 const sept8 = confession.find((o) => o.occurrenceDate === '2026-09-08');
 assert.strictEqual(sept8.status, 'completed', "the one-off fragment's completion survives");
 assert.strictEqual(sept8.dismissed, true, 'and its dismissal');
 const oct2 = confession.find((o) => o.occurrenceDate === '2026-10-02');
 assert.deepStrictEqual([oct2.focusedSeconds, oct2.timerSeconds], [5, 2675], 'measured time, in whole seconds');
 assert.strictEqual(oct2.timer.mode, 'countup', 'the timer moves onto its occurrence');
 assert.ok(!('occurrenceDate' in oct2.timer), 'without its old date field');

 const shave = rows('ruc');
 assert.deepStrictEqual(shave.map((o) => `${o.occurrenceDate} ${o.status}`), ['2026-09-10 completed', '2026-09-17 pending'], 'a recur-until-completed task: its completed cycle and its live occurrence');
 assert.deepStrictEqual(shave[1].pendingReschedules, ['2026-09-18', '2026-09-19'], 'the live one keeps the days it was carried');

 assert.strictEqual(rows('reminder')[0].status, 'failed', "a passive task's failed mark");
}

// --- Current exports pass through as they are ------------------------------------

{
 const task = { id: 'a', taskId: 'a', seriesId: 's', name: 'A', dueDate: '2026-10-01', dueTime: null, allDay: true, frequency: { type: 'days', interval: 1 }, createdAt: 5 };
 const row = { id: 'o', taskId: 'a', occurrenceDate: '2026-10-02', status: 'completed', resolvedAt: 9, dismissed: false, manual: false, pendingReschedules: [], comments: [] };
 const { occurrences } = prepareImport([task], [row]);
 assert.deepStrictEqual(occurrences, [row], 'occurrence rows untouched');
}

// --- What a file can hold that the database can't take -----------------------------

{
 const base = { seriesId: 's', name: 'A', dueTime: null, allDay: true, frequency: { type: 'days', interval: 1 }, createdAt: 1 };
 const tasks = [
  { ...base, id: 'a', taskId: 'a', dueDate: '2026-10-01' },
  { ...base, id: 'a', taskId: 'a', dueDate: '2026-10-01', name: 'A again' },
 ];
 const row = (fields) => ({ taskId: 'a', occurrenceDate: '2026-10-02', status: 'pending', resolvedAt: null, dismissed: false, manual: false, pendingReschedules: [], comments: [], focusedSeconds: 0, timerSeconds: 0, timer: null, ...fields });
 const occurrences = [
  row({ id: 'o1', comments: [{ text: 'first', timestamp: 1 }], focusedSeconds: 10 }),
  row({ id: 'o2', status: 'completed', resolvedAt: 5, dismissed: true, comments: [{ text: 'second', timestamp: 2 }], focusedSeconds: 20 }),
  row({ id: 'o1', occurrenceDate: '2026-10-03', status: 'bogus' }),
  row({ id: 'o4', occurrenceDate: '2026-10-04', timer: { mode: 'countdown', totalSeconds: 600, remainingSeconds: 300, runningSince: 123, continuePastZero: false } }),
  row({ id: 'o5', taskId: 'ghost' }),
 ];
 const { tasks: kept, occurrences: rows } = prepareImport(tasks, occurrences);
 assert.deepStrictEqual(kept.map((t) => t.name), ['A'], 'a task record twice: the first is kept');
 assert.ok(!rows.some((o) => o.taskId === 'ghost'), "an occurrence of a task the file doesn't have is dropped");
 const merged = rows.filter((o) => o.occurrenceDate === '2026-10-02');
 assert.strictEqual(merged.length, 1, 'two rows for one date are merged');
 assert.strictEqual(merged[0].status, 'completed', 'done over pending');
 assert.strictEqual(merged[0].resolvedAt, 5, 'with when');
 assert.strictEqual(merged[0].dismissed, true, 'dismissed if either is');
 assert.deepStrictEqual(merged[0].comments.map((c) => c.text), ['first', 'second'], 'notes together');
 assert.strictEqual(merged[0].focusedSeconds, 30, 'measured time together');
 const oct3 = rows.find((o) => o.occurrenceDate === '2026-10-03');
 assert.notStrictEqual(oct3.id, 'o1', 'an id used twice gets a fresh one');
 assert.strictEqual(oct3.status, 'pending', 'an unknown status is pending');
 assert.strictEqual(rows.find((o) => o.occurrenceDate === '2026-10-04').timer.runningSince, null, 'a running timer is stopped');
 assert.strictEqual(rows.find((o) => o.occurrenceDate === '2026-10-04').timer.remainingSeconds, 300, 'where it was');
}

// --- A recur-until-completed task always has its live occurrence ---------------------

{
 const ruc = { id: 'r', taskId: 'r', seriesId: 'r', name: 'R', dueDate: '2026-09-04', dueTime: null, allDay: true, recurUntilCompleted: true, frequency: { type: 'months', dayMode: 'weekday', ordinal: 1, weekday: 5, interval: 1 }, createdAt: 1 };
 const doneOn = (date) => ({ id: `d${date}`, taskId: 'r', occurrenceDate: date, status: 'completed', resolvedAt: 1, dismissed: false, manual: false, pendingReschedules: [], comments: [] });
 let { occurrences } = prepareImport([{ ...ruc }], [doneOn('2026-09-04')]);
 assert.deepStrictEqual(occurrences.map((o) => `${o.occurrenceDate} ${o.status}`), ['2026-09-04 completed', '2026-10-02 pending'], 'only a completed cycle: the next one is seeded');
 ({ occurrences } = prepareImport([{ ...ruc }], []));
 assert.deepStrictEqual(occurrences.map((o) => `${o.occurrenceDate} ${o.status}`), ['2026-09-04 pending'], 'no rows: seeded on its due date');
 const live = { ...doneOn('2026-10-02'), id: 'l', status: 'pending', resolvedAt: null };
 ({ occurrences } = prepareImport([{ ...ruc }], [doneOn('2026-09-04'), live]));
 assert.strictEqual(occurrences.length, 2, 'a live occurrence already there: nothing seeded');
}

console.log('migrate.test.js: all assertions passed');
