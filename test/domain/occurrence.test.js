const assert = require('node:assert');
const O = require('../../lib/atodo/domain/occurrence');

// -- findOccurrence / pendingOccurrenceFor ----------------------------------
const occurrences = [
  { id: 'o1', taskId: 't1', occurrenceDate: '2026-09-23', status: 'completed' },
  { id: 'o2', taskId: 't1', occurrenceDate: '2026-09-29', status: 'pending' },
  { id: 'o3', taskId: 't2', occurrenceDate: '2026-09-23', status: 'pending' },
];
assert.strictEqual(O.findOccurrence(occurrences, 't1', '2026-09-23'), occurrences[0]);
assert.strictEqual(O.findOccurrence(occurrences, 't1', '2026-09-29'), occurrences[1]);
assert.strictEqual(O.findOccurrence(occurrences, 't1', '2026-10-05'), null, 'no row for that date');
assert.strictEqual(O.findOccurrence(occurrences, 't2', '2026-09-23'), occurrences[2], 'keyed by taskId, not which Task record you happen to be looking at');

assert.strictEqual(O.pendingOccurrenceFor(occurrences, 't1'), occurrences[1], "the one still-'pending' row, not the completed one");
assert.strictEqual(O.pendingOccurrenceFor(occurrences, 't3'), null, 'no occurrences at all for this taskId');

// -- createOccurrence --------------------------------------------------------
const fresh = O.createOccurrence({ id: 'o9', taskId: 't9', occurrenceDate: '2026-01-01' });
assert.deepStrictEqual(fresh, {
  id: 'o9',
  taskId: 't9',
  occurrenceDate: '2026-01-01',
  pendingReschedules: [],
  status: 'pending',
  resolvedAt: null,
  dismissed: false,
  manual: false,
  overrides: null,
  details: null,
  comments: [],
  log: [],
  focusedSeconds: 0,
  timerSeconds: 0,
  timer: null,
});
const manualOne = O.createOccurrence({ id: 'o10', taskId: 't9', occurrenceDate: '2026-01-05', manual: true });
assert.strictEqual(manualOne.manual, true);

// -- effectiveDueDate ---------------------------------------------------
assert.strictEqual(O.effectiveDueDate({ occurrenceDate: '2026-09-23', pendingReschedules: [] }), '2026-09-23', 'never pushed -- still its own occurrenceDate');
assert.strictEqual(
  O.effectiveDueDate({ occurrenceDate: '2026-09-23', pendingReschedules: ['2026-09-24', '2026-09-25'] }),
  '2026-09-25',
  'pushed twice -- the chain\'s own last entry, not occurrenceDate'
);

// -- recurrenceShim -----------------------------------------------------
const task = { frequency: { type: 'days', interval: 6 }, endDate: '2026-12-31' };
const occurrence = { occurrenceDate: '2026-09-23', pendingReschedules: ['2026-09-24'] };
assert.deepStrictEqual(O.recurrenceShim(task, occurrence), {
  dueDate: '2026-09-23',
  pendingReschedules: ['2026-09-24'],
  recurUntilCompleted: true,
  frequency: task.frequency,
  endDate: task.endDate,
});
// no pendingReschedules at all on the occurrence -- shim still gets a real array, not undefined
assert.deepStrictEqual(O.recurrenceShim(task, { occurrenceDate: '2026-09-23' }).pendingReschedules, []);

// -- applyOverrides -------------------------------------------------------
const plainTask = { name: 'Water plants', dueTime: '09:00', appointment: false };
assert.strictEqual(O.applyOverrides(plainTask, null), plainTask, 'no occurrence at all -- task fields as-is');
assert.strictEqual(O.applyOverrides(plainTask, { overrides: null }), plainTask, 'occurrence exists but carries no override');
assert.deepStrictEqual(
  O.applyOverrides(plainTask, { overrides: { name: 'Water plants (extra today)' } }),
  { name: 'Water plants (extra today)', dueTime: '09:00', appointment: false },
  'only the overridden field changes, everything else still comes from the task'
);

// -- canManageOccurrenceDirectly --------------------------------------------
assert.strictEqual(
  O.canManageOccurrenceDirectly({ recurUntilCompleted: true }, { status: 'pending' }),
  false,
  "the one live pending slot of a recurUntilCompleted task's chain"
);
assert.strictEqual(
  O.canManageOccurrenceDirectly({ recurUntilCompleted: true }, { status: 'completed' }),
  true,
  'a resolved recurUntilCompleted occurrence is frozen history'
);
assert.strictEqual(
  O.canManageOccurrenceDirectly({ recurUntilCompleted: false }, { status: 'pending' }),
  true,
  'an ordinary task self-recomputes its pattern regardless'
);

// -- isDateExcluded ---------------------------------------------------------
const rescheduled = [
  // Moved from 2026-09-24 to 2026-09-25 -- the vacated date is recorded in
  // its own pendingReschedules.
  { id: 'r1', taskId: 't1', occurrenceDate: '2026-09-25', pendingReschedules: ['2026-09-24'] },
  { id: 'r2', taskId: 't2', occurrenceDate: '2026-09-20', pendingReschedules: [] },
];
assert.strictEqual(O.isDateExcluded(rescheduled, 't1', '2026-09-24'), true, 'vacated by a reschedule -- excluded from regenerating');
assert.strictEqual(O.isDateExcluded(rescheduled, 't1', '2026-09-25'), false, "the occurrence's own current date is never excluded");
assert.strictEqual(O.isDateExcluded(rescheduled, 't1', '2026-09-26'), false, 'an untouched date is not excluded');
assert.strictEqual(O.isDateExcluded(rescheduled, 't2', '2026-09-24'), false, 'scoped by taskId -- another task vacating a date has no effect here');
assert.strictEqual(
  O.isDateExcluded(
    [{ id: 'r3', taskId: 't1', occurrenceDate: '2026-09-24', pendingReschedules: ['2026-09-24'] }],
    't1',
    '2026-09-24'
  ),
  false,
  'moved back onto a date still lingering in its own history -- current occupant, not an exclusion'
);

// -- isBlankOccurrence -----------------------------------------------------
const blank = O.createOccurrence({ id: 'b1', taskId: 't1', occurrenceDate: '2026-09-23' });
assert.strictEqual(O.isBlankOccurrence(blank), true, 'a freshly created row carries nothing');
assert.strictEqual(O.isBlankOccurrence({ ...blank, dismissed: true }), true, 'dismissal alone is not content');
assert.strictEqual(O.isBlankOccurrence({ ...blank, status: 'completed' }), false, 'an outcome is content');
assert.strictEqual(O.isBlankOccurrence({ ...blank, comments: [{ text: 'x' }] }), false, 'a note is content');
assert.strictEqual(O.isBlankOccurrence({ ...blank, details: 'bring towel' }), false, 'occurrence details are content');
assert.strictEqual(O.isBlankOccurrence({ ...blank, details: '  ' }), true, 'whitespace-only details are not');
assert.strictEqual(O.isBlankOccurrence({ ...blank, log: [{ message: 'Focused' }] }), false, 'activity is content');
assert.strictEqual(O.isBlankOccurrence({ ...blank, manual: true }), false, 'a manually added occurrence is not the pattern\'s to drop');
assert.strictEqual(O.isBlankOccurrence({ ...blank, pendingReschedules: ['2026-09-22'] }), false, 'a rescheduled row is not the pattern\'s to drop');
assert.strictEqual(O.isBlankOccurrence({ ...blank, focusedSeconds: 5 }), false, 'measured time is content');

// -- statusOf -------------------------------------------------------------
assert.strictEqual(O.statusOf(occurrences, 't1', '2026-09-23'), 'completed');
assert.strictEqual(O.statusOf(occurrences, 't1', '2026-10-05'), 'pending', 'no row at all -- still pending, not an error');

// -- notesCount -----------------------------------------------------------
const taskRecords = [
  { taskId: 'tA', comments: [{ text: 'a' }, { text: 'b' }] },
  { taskId: 'tA', comments: [{ text: 'c' }] }, // a second fragment sharing the same taskId (post-split)
  { taskId: 'tB', comments: [{ text: 'z' }] },
];
const occForNotes = [
  { taskId: 'tA', comments: [{ text: 'd' }] },
  { taskId: 'tA', comments: [] },
  { taskId: 'tB', comments: [{ text: 'y' }, { text: 'x' }] },
];
assert.strictEqual(O.notesCount(taskRecords, occForNotes, 'tA'), 4, '2 + 1 task-level across both fragments, plus 1 occurrence-level');
assert.strictEqual(O.notesCount(taskRecords, occForNotes, 'tB'), 3, '1 task-level plus 2 occurrence-level');
assert.strictEqual(O.notesCount(taskRecords, occForNotes, 'tC'), 0, 'no records at all for this taskId');

// missingLiveOccurrences: a recurUntilCompleted task with no rows at all
// (from before the Occurrence model) gets its live occurrence back, at its
// dueDate; nothing else is touched.
{
  let n = 0;
  const newId = () => `seed${++n}`;
  const monthly = { type: 'months', interval: 1, dayMode: 'weekday', ordinal: 1, weekday: 1 };
  const seedTasks = [
    { taskId: 'untouched', dueDate: '2026-10-05', recurUntilCompleted: true, frequency: monthly },
    { taskId: 'live', dueDate: '2026-09-01', recurUntilCompleted: true, frequency: monthly },
    { taskId: 'finished', dueDate: '2026-01-05', recurUntilCompleted: true, frequency: monthly, endDate: '2026-03-01' },
    { taskId: 'plain', dueDate: '2026-10-05', recurUntilCompleted: false, frequency: monthly },
  ];
  const seedOccurrences = [
    { ...O.createOccurrence({ id: 'a', taskId: 'live', occurrenceDate: '2026-10-05' }) },
    { ...O.createOccurrence({ id: 'b', taskId: 'finished', occurrenceDate: '2026-02-02' }), status: 'completed' },
  ];
  const rows = O.missingLiveOccurrences(seedTasks, seedOccurrences, newId);
  assert.strictEqual(rows.length, 1, 'only the recurUntilCompleted task with no rows at all gets one');
  assert.deepStrictEqual([rows[0].taskId, rows[0].occurrenceDate, rows[0].status, rows[0].id], ['untouched', '2026-10-05', 'pending', 'seed1'], 'pending, at its dueDate');
  assert.strictEqual(O.missingLiveOccurrences(seedTasks, [...seedOccurrences, ...rows], newId).length, 0, 'idempotent once seeded');
  assert.strictEqual(
    O.missingLiveOccurrences([seedTasks[0], { ...seedTasks[0] }], [], newId).length,
    1,
    'one per taskId, even if several records share it'
  );
}

console.log('occurrence.test.js: all assertions passed');
