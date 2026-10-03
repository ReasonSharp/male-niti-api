const assert = require('node:assert');
const C = require('../../lib/atodo/domain/clock');

// 2026-10-03 22:30 UTC: still the 3rd in New York, already the 4th in Zagreb.
const ms = Date.UTC(2026, 9, 3, 22, 30);
const zg = C.makeClock('Europe/Zagreb', ms);
assert.strictEqual(zg.todayISO, '2026-10-04', 'Zagreb is past midnight');
assert.strictEqual(zg.hour, 0, 'Zagreb hour (CEST, UTC+2)');
assert.strictEqual(zg.now.getHours(), 0, 'now carries wall time in its local fields');
assert.strictEqual(zg.now.getDate(), 4, 'now carries the wall date');
const ny = C.makeClock('America/New_York', ms);
assert.strictEqual(ny.todayISO, '2026-10-03', 'New York is still on the 3rd');
assert.strictEqual(ny.hour, 18, 'New York hour (EDT, UTC-4)');

assert.strictEqual(C.makeClock('Not/AZone', ms).timeZone, C.DEFAULT_TIME_ZONE, 'unknown zone falls back');
assert.strictEqual(C.makeClock(undefined, ms).timeZone, C.DEFAULT_TIME_ZONE, 'missing zone falls back');

// 23:00 New York on the 5th is 05:00 on the 6th in Zagreb.
assert.deepStrictEqual(C.zonedToLocal('2026-10-05', '23:00', 'America/New_York', 'Europe/Zagreb'), { dateISO: '2026-10-06', time: '05:00' }, 'fixed-zone due time on the user\'s local day');
// After Europe falls back (25 Oct) but before the US does (1 Nov), the gap is 5 hours.
assert.deepStrictEqual(C.zonedToLocal('2026-10-28', '09:00', 'America/New_York', 'Europe/Zagreb'), { dateISO: '2026-10-28', time: '14:00' }, 'zones changing summer time on different dates');
assert.deepStrictEqual(C.zonedToLocal('2026-11-05', '09:00', 'America/New_York', 'Europe/Zagreb'), { dateISO: '2026-11-05', time: '15:00' }, 'both on winter time');

// A spring-forward gap (02:30 doesn't exist in Zagreb on 29 March 2026).
assert.deepStrictEqual(C.wallDateTime('Europe/Zagreb', C.zonedInstant('2026-03-29', '02:30', 'Europe/Zagreb')), { dateISO: '2026-03-29', time: '03:30' }, 'skipped wall time lands after the gap');

const user = C.makeClock('Europe/Zagreb', ms);
assert.strictEqual(C.clockForTask({ timeZone: null }, user), user, 'fluid task uses the user clock');
assert.strictEqual(C.clockForTask({ timeZone: 'America/New_York', allDay: true }, user), user, 'all-day task never has its own zone');
assert.strictEqual(C.clockForTask({ timeZone: 'America/New_York' }, user).todayISO, '2026-10-03', 'fixed-zone task runs on its own clock');

console.log('clock.test.js: all assertions passed');
// A repeated hour (02:30 happens twice in Zagreb on 25 October 2026): the first.
const repeated = C.zonedInstant('2026-10-25', '02:30', 'Europe/Zagreb');
assert.strictEqual(new Date(repeated).toISOString(), '2026-10-25T00:30:00.000Z', 'repeated wall time resolves to its first occurrence (still CEST)');
console.log('clock.test.js: repeated-hour assertion passed');
