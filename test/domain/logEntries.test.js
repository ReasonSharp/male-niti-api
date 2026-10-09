const assert = require('node:assert');
const { describeLogMessage, describeLog } = require('../../lib/atodo/domain/logEntries');

assert.deepStrictEqual(describeLogMessage('Marked done'), { key: 'log.markedDone', params: {} }, 'a plain message');
assert.deepStrictEqual(describeLogMessage('Unfocused and marked done'), { key: 'log.unfocusedAndMarkedDone', params: {} }, 'not mistaken for "Unfocused"');
assert.deepStrictEqual(describeLogMessage('Rescheduled to 2026-10-12'), { key: 'log.rescheduledTo', params: { date: '2026-10-12' } }, 'a date parameter');
assert.deepStrictEqual(
 describeLogMessage('Recurrence resumed (was paused until 2026-11-01)'),
 { key: 'log.recurrenceResumed', params: { date: '2026-11-01' } },
 'parentheses around a date',
);
assert.deepStrictEqual(
 describeLogMessage('Recurrence edited (only this occurrence)'),
 { key: 'log.recurrenceEditedThisOnly', params: {} },
 'an older client wording, parentheses taken literally',
);
assert.strictEqual(describeLogMessage('Something nobody wrote'), null, 'unrecognised');
assert.strictEqual(describeLogMessage('Marked done!'), null, 'whole message only');
assert.strictEqual(describeLogMessage(undefined), null, 'no message');

const described = describeLog([{ message: 'Timer set', timestamp: 1 }, { message: '???', timestamp: 2, occurrenceDate: '2026-10-01' }]);
assert.deepStrictEqual(described[0], { message: 'Timer set', timestamp: 1, key: 'log.timerSet', params: {} }, 'stored fields kept, key added');
assert.deepStrictEqual(described[1], { message: '???', timestamp: 2, occurrenceDate: '2026-10-01', key: null, params: {} }, 'unrecognised: no key');
assert.deepStrictEqual(describeLog(null), [], 'no log');

console.log('logEntries.test.js: all assertions passed');
