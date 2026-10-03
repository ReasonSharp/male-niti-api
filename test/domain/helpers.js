// Shared by the domain tests: an AccountState on a simulated clock.
const { AccountState } = require('../../lib/atodo/domain/account');
const { makeClock } = require('../../lib/atodo/domain/clock');

// A moment as Zagreb wall time ('2026-10-05T09:00'), in ms.
function zagreb(wall) {
 const { zonedInstant } = require('../../lib/atodo/domain/clock');
 const [date, time] = wall.split('T');
 return zonedInstant(date, time, 'Europe/Zagreb');
}

function makeState({ tasks = [], occurrences = [], at = '2026-10-05T09:00', timeZone = 'Europe/Zagreb', subscriptionActive = true, active } = {}) {
 const ms = timeZone === 'Europe/Zagreb' ? zagreb(at) : require('../../lib/atodo/domain/clock').zonedInstant(...at.split('T'), timeZone);
 return new AccountState({ tasks, occurrences, clock: makeClock(timeZone, ms), subscriptionActive, active });
}

// Moves a state's clock (same zone) to another wall time.
function advance(state, at) {
 const { zonedInstant } = require('../../lib/atodo/domain/clock');
 state.clock = makeClock(state.clock.timeZone, zonedInstant(...at.split('T'), state.clock.timeZone));
 state.expiredTimers = [];
}

let counter = 0;
// A task as createTask would make it, with sensible defaults.
function task(fields = {}) {
 const id = fields.id || `t${++counter}`;
 return {
  id,
  taskId: fields.taskId || id,
  seriesId: fields.seriesId || `s-${id}`,
  seriesName: null,
  name: fields.name || id,
  description: '',
  details: '',
  dueDate: '2026-10-01',
  dueTime: '18:00',
  allDay: false,
  appointment: false,
  passive: false,
  recurUntilCompleted: false,
  endDate: null,
  frequency: { type: 'days', interval: 1 },
  timeZone: null,
  createdAt: counter,
  statsResetAt: null,
  log: [],
  comments: [],
  ...fields,
 };
}

const itemsOf = (day) => day.items.map((i) => `${i.taskId}@${i.occurrenceDate}${i.completed ? '+done' : ''}${i.failed ? '+failed' : ''}${i.overdue ? '+overdue' : ''}${i.dismissed ? '+dismissed' : ''}`);

module.exports = { makeState, advance, task, zagreb, itemsOf };
