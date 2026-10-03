// The three list views and dayView, against the rules the client used to
// apply itself (see views.js for where each comes from).
const assert = require('node:assert');
const { dayView } = require('../../lib/atodo/domain/views');
const { makeState, advance, task, itemsOf } = require('./helpers');

// The items of exactly that day (dayView itself moves on to the nearest
// day with items when the requested one has none).
const itemsOn = (state, view, date) => {
 const day = dayView(state, view, date);
 return day.date === date ? itemsOf(day) : [];
};

// --- A daily task: today, tomorrow, carried over -----------------------------

{
 const daily = task({ id: 'daily', dueDate: '2026-10-01', dueTime: '18:00' });
 const state = makeState({ tasks: [daily], at: '2026-10-05T09:00' });

 // Pending view: overdue since the 1st (dismissal ignored), today, tomorrow.
 const today = dayView(state, 'pending', '2026-10-05');
 assert.deepStrictEqual(itemsOf(today), ['daily@2026-10-05'], 'pending: today');
 assert.strictEqual(today.previousDate, '2026-10-04', 'pending: previous day with items');
 assert.strictEqual(today.nextDate, '2026-10-06', 'pending: tomorrow');
 assert.deepStrictEqual(itemsOn(state, 'pending', '2026-10-02'), ['daily@2026-10-02+overdue'], 'pending: a missed day is overdue');
 assert.strictEqual(dayView(state, 'pending', '2026-10-06').items[0].kind, 'tomorrow', 'pending: tomorrow\'s kind');
 assert.strictEqual(dayView(state, 'pending', '2026-10-06').nextDate, null, 'pending: nothing after tomorrow');

 // Next recurrence: today's plus the previous (still pending) one.
 const next = dayView(state, 'next-recurrence', '2026-10-05');
 assert.deepStrictEqual(itemsOf(next), ['daily@2026-10-05'], 'next-recurrence: today');
 assert.deepStrictEqual(itemsOn(state, 'next-recurrence', '2026-10-04'), ['daily@2026-10-04+overdue'], 'next-recurrence: yesterday carried over');

 // All tasks: every day of the month.
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-31'), ['daily@2026-10-31'], 'all: end of month');
 assert.strictEqual(dayView(state, 'all', '2026-10-31').nextDate, '2026-11-01', 'all: next day crosses into November');
}

// --- Completing, and the next-recurrence linger -------------------------------

{
 const daily = task({ id: 'daily', dueDate: '2026-10-01', dueTime: '08:00' });
 const state = makeState({ tasks: [daily], at: '2026-10-05T09:00' });


 state.complete('daily', '2026-10-05');
 // Completing today's dismisses the missed yesterday (and before).
 assert.strictEqual(state.findOccurrence(daily, '2026-10-04').dismissed, true, 'completing sweeps earlier missed occurrences');
 assert.deepStrictEqual(itemsOn(state, 'next-recurrence', '2026-10-05'), ['daily@2026-10-05+done'], 'next-recurrence: done today stays shown');
 assert.deepStrictEqual(itemsOn(state, 'pending', '2026-10-05'), ['daily@2026-10-05+done'], 'pending: today\'s shown done');
 assert.strictEqual(dayView(state, 'next-recurrence', '2026-10-05').nextDate, '2026-10-06', 'next-recurrence previews what\'s next once today is done');

 // A day later, yesterday's completed occurrence is dismissed, not shown.
 advance(state, '2026-10-06T09:00');
 assert.deepStrictEqual(itemsOn(state, 'next-recurrence', '2026-10-05'), [], 'next-recurrence: completed prior done a while ago isn\'t shown');
 assert.strictEqual(state.findOccurrence(daily, '2026-10-05').dismissed, true, '...and is dismissed');
}

// --- Checking off a carried-over occurrence in next-recurrence: shown a moment, then gone ---

{
 const daily = task({ id: 'daily', dueDate: '2026-10-01', dueTime: '08:00' });
 const state = makeState({ tasks: [daily], at: '2026-10-05T09:00' });
 assert.deepStrictEqual(itemsOn(state, 'next-recurrence', '2026-10-04'), ['daily@2026-10-04+overdue'], 'yesterday carried over');
 state.complete('daily', '2026-10-04');
 const { makeClock } = require('../../lib/atodo/domain/clock');
 const later = (ms) => {
  state.clock = makeClock(state.clock.timeZone, state.clock.nowMs + ms);
 };
 later(2000);
 assert.deepStrictEqual(itemsOn(state, 'next-recurrence', '2026-10-04'), ['daily@2026-10-04+done'], 'just checked off: still shown, done');
 assert.strictEqual(state.findOccurrence(daily, '2026-10-04').dismissed, false, '...not dismissed yet');
 later(4000);
 assert.deepStrictEqual(itemsOn(state, 'next-recurrence', '2026-10-04'), [], 'a few seconds later: gone');
 assert.strictEqual(state.findOccurrence(daily, '2026-10-04').dismissed, true, '...dismissed');
}

// --- Stale carried-over occurrences are dismissed on their own ----------------

{
 // Every 3 days from the 1st: its latest occurrence before the 5th is the
 // 4th... and before the 4th, the 1st -- two days old by the 3rd.
 const every3 = task({ id: 'e3', dueDate: '2026-10-01', frequency: { type: 'days', interval: 3 } });
 const state = makeState({ tasks: [every3], at: '2026-10-03T09:00' });
 state.runMaintenance();
 assert.strictEqual(state.findOccurrence(every3, '2026-10-01').dismissed, true, 'a carried-over occurrence two days old is dismissed');
 assert.deepStrictEqual(itemsOn(state, 'next-recurrence', '2026-10-01'), [], '...and no longer shown as next');
 assert.deepStrictEqual(itemsOn(state, 'pending', '2026-10-01'), ['e3@2026-10-01+overdue+dismissed'], '...though the pending view still lists it');
}

// --- Appointments fail, passive tasks don't ----------------------------------

{
 const appointment = task({ id: 'appt', frequency: { type: 'once', interval: 1 }, dueDate: '2026-10-05', dueTime: '08:00', appointment: true });
 const passive = task({ id: 'passive', frequency: { type: 'once', interval: 1 }, dueDate: '2026-10-05', dueTime: '08:00', passive: true });
 const state = makeState({ tasks: [appointment, passive], at: '2026-10-05T09:00' });
 const items = dayView(state, 'all', '2026-10-05').items;
 const appt = items.find((i) => i.taskId === 'appt');
 const pass = items.find((i) => i.taskId === 'passive');
 assert.strictEqual(appt.failed, true, 'appointment past its time fails');
 assert.ok(!appt.actions.includes('focus'), 'a failed appointment can\'t be focused');
 assert.strictEqual(pass.failed, false, 'passive task isn\'t failed by time');
 assert.strictEqual(pass.overdue, true, 'passive task is overdue');
 assert.ok(pass.actions.includes('fail') && !pass.actions.includes('complete'), 'passive: fail, not complete');
 state.fail('passive', '2026-10-05');
 assert.strictEqual(dayView(state, 'all', '2026-10-05').items.find((i) => i.taskId === 'passive').failed, true, 'passive marked failed');
}

// --- Focus exempts an appointment from failing --------------------------------

{
 const appointment = task({ id: 'appt', frequency: { type: 'once', interval: 1 }, dueDate: '2026-10-05', dueTime: '10:00', appointment: true });
 const state = makeState({ tasks: [appointment], at: '2026-10-05T09:00' });
 state.focus('appt', '2026-10-05');
 advance(state, '2026-10-05T11:00');
 const item = dayView(state, 'all', '2026-10-05').items[0];
 assert.strictEqual(item.failed, false, 'the focused appointment doesn\'t fail');
 assert.strictEqual(item.active, true, 'it\'s the active one');
 assert.ok(item.actions.includes('unfocus'), 'can be unfocused');
}

// --- Recur until completed -----------------------------------------------------

{
 const ruc = task({ id: 'ruc', dueDate: '2026-10-03', dueTime: '08:00', recurUntilCompleted: true, frequency: { type: 'days', interval: 7 } });
 const state = makeState({ tasks: [ruc], at: '2026-10-05T09:00' });
 state.ensureOccurrence(ruc, '2026-10-03');
 state.runMaintenance();
 // Missed on the 3rd: carried day by day, shown on each day, never overdue.
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-04'), ['ruc@2026-10-04'], 'carried to the 4th');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-05'), ['ruc@2026-10-05'], 'carried to today');
 state.complete('ruc', '2026-10-05');
 // Done: shown on the occurrence's own date (its carried days are over).
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-03'), ['ruc@2026-10-03+done'], 'done, on its own date');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-05'), [], 'no longer carried today');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-12'), ['ruc@2026-10-12'], 'next cycle a week after completion');
 state.reopen('ruc', '2026-10-05');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-12'), [], 'reopening takes the next cycle back');
}

// --- A fixed time zone ---------------------------------------------------------

{
 // Daily 23:00 New York; the user is in Zagreb: shows at 05:00 the next day.
 const ny = task({ id: 'ny', dueDate: '2026-10-01', dueTime: '23:00', timeZone: 'America/New_York', frequency: { type: 'once', interval: 1 } });
 const state = makeState({ tasks: [ny], at: '2026-10-02T04:00' });
 const day = dayView(state, 'all', '2026-10-02');
 assert.deepStrictEqual(itemsOf(day), ['ny@2026-10-01'], 'a New York task\'s 1 Oct occurrence shows on the user\'s 2 Oct');
 assert.strictEqual(day.items[0].dueTime, '05:00', 'at the user\'s local time');
 assert.strictEqual(day.items[0].zoneDueTime, '23:00', 'with its own zone\'s time');
 assert.strictEqual(dayView(state, 'all', '2026-10-01').date, '2026-10-02', 'nothing on the 1st locally');
 // 05:00 local has passed by 09:00: overdue, by its own moment.
 advance(state, '2026-10-02T09:00');
 assert.deepStrictEqual(itemsOn(state, 'all', '2026-10-02'), ['ny@2026-10-01+overdue'], 'overdue once its moment has passed');

 // An all-day task never has a zone.
 const allDay = task({ id: 'ad', dueDate: '2026-10-02', allDay: true, dueTime: null, timeZone: 'America/New_York', frequency: { type: 'once', interval: 1 } });
 const state2 = makeState({ tasks: [allDay], at: '2026-10-02T09:00' });
 assert.deepStrictEqual(itemsOn(state2, 'all', '2026-10-02'), ['ad@2026-10-02'], 'all-day stays on its date');
}

// --- The subscription reminder -------------------------------------------------

{
 const state = makeState({ tasks: [], at: '2026-10-05T09:00', subscriptionActive: false });
 const day = dayView(state, 'pending', '2026-10-05');
 assert.strictEqual(day.items.length, 1, 'a free account sees the reminder today');
 assert.strictEqual(day.items[0].virtual, 'subscription-prompt', '...as a virtual item');
 assert.deepStrictEqual(day.items[0].actions, [], '...that can\'t be acted on');
 assert.strictEqual(dayView(makeState({ tasks: [], subscriptionActive: true }), 'pending', '2026-10-05').date, null, 'a subscriber has nothing to see');
}

// --- Free-tier locking ---------------------------------------------------------

{
 const tasks = Array.from({ length: 12 }, (_, i) => task({ id: `once${i}`, frequency: { type: 'once', interval: 1 }, dueDate: '2026-10-06', createdAt: i }));
 const state = makeState({ tasks, at: '2026-10-05T09:00', subscriptionActive: false });
 const items = dayView(state, 'all', '2026-10-06').items.filter((i) => !i.virtual);
 assert.strictEqual(items.filter((i) => i.locked).length, 2, 'beyond 10 one-off tasks, the newest are locked');
 assert.deepStrictEqual(items.find((i) => i.locked).actions, ['stats'], 'a locked item only offers stats');
}

console.log('views.test.js: all assertions passed');
