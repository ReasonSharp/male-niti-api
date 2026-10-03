// Time zones for the domain rules. The rules (recurrence.js and friends) work
// in JavaScript's "local" time as a plain wall clock -- new Date('2026-10-05
// T00:00:00'), getHours() -- so the API runs with TZ=UTC (no daylight-saving
// jumps; server.js sets it) and this module turns a real moment into the wall
// clock of a given zone:
//
//   makeClock(timeZone, nowMs) -> { timeZone, nowMs, now, todayISO, hour }
//
// where `now` is a Date whose local (UTC) fields ARE that zone's wall time --
// what the rules expect to receive as `now`. Each request gets the user's
// clock (their X-Timezone); a task with a fixed time zone is evaluated on a
// clock in its own zone (clockForTask), and its due moments converted to the
// user's local day and time for display (zonedToLocal).

const DEFAULT_TIME_ZONE = 'Europe/Zagreb';

const formatters = new Map();
function formatterFor(timeZone) {
 if (!formatters.has(timeZone)) {
  formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
   timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }));
 }
 return formatters.get(timeZone);
}

function isValidTimeZone(timeZone) {
 if (typeof timeZone !== 'string' || !timeZone) return false;
 try {
  formatterFor(timeZone);
  return true;
 } catch {
  return false;
 }
}

// A request's zone, or the default for a missing/unknown one.
function resolveTimeZone(timeZone) {
 return isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
}

// The wall-clock fields of moment `ms` in `timeZone`.
function wallParts(timeZone, ms) {
 const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
 return {
  year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
  hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
 };
}

const pad2 = (n) => String(n).padStart(2, '0');

function makeClock(timeZone, nowMs = Date.now()) {
 const zone = resolveTimeZone(timeZone);
 const p = wallParts(zone, nowMs);
 const now = new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, nowMs % 1000));
 return {
  timeZone: zone,
  nowMs,
  now,
  todayISO: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
  hour: p.hour,
 };
}

// The moment a wall time ('YYYY-MM-DD', 'HH:MM') names in `timeZone`. A wall
// time skipped by a spring-forward lands just after the gap; one repeated by
// a fall-back resolves to its first occurrence.
function zonedInstant(dateISO, hhmm, timeZone) {
 const [y, m, d] = dateISO.split('-').map(Number);
 const [h, mi] = (hhmm || '00:00').split(':').map(Number);
 const wanted = Date.UTC(y, m - 1, d, h, mi);
 // The zone's offset half a day either side covers any one transition: a
 // wall time valid under one of them is a real moment (the earlier one, if
 // both -- a repeated hour); valid under neither, it's in a gap, and the
 // offset from before the gap puts it just after.
 const offsetAt = (ms) => {
  const p = wallParts(timeZone, ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
 };
 const before = wanted - offsetAt(wanted - 43200000);
 const after = wanted - offsetAt(wanted + 43200000);
 const shows = (ms) => {
  const p = wallParts(timeZone, ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) === wanted;
 };
 const valid = [before, after].filter(shows);
 return valid.length ? Math.min(...valid) : before;
}

// Wall date and time ('YYYY-MM-DD', 'HH:MM') of moment `ms` in `timeZone`.
function wallDateTime(timeZone, ms) {
 const p = wallParts(timeZone, ms);
 return { dateISO: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`, time: `${pad2(p.hour)}:${pad2(p.minute)}` };
}

// A fixed-zone task's due time on its own date, as the user's local date and
// time -- which local day it shows on, and when.
function zonedToLocal(dateISO, hhmm, fromZone, toZone) {
 return wallDateTime(toZone, zonedInstant(dateISO, hhmm, fromZone));
}

// The clock a task's rules run on: its own zone if it has one (timed tasks
// only -- an all-day task never does), else the user's.
function clockForTask(task, userClock) {
 if (!task.timeZone || task.allDay || task.timeZone === userClock.timeZone) return userClock;
 return makeClock(task.timeZone, userClock.nowMs);
}

module.exports = {
 DEFAULT_TIME_ZONE,
 isValidTimeZone,
 resolveTimeZone,
 makeClock,
 zonedInstant,
 wallDateTime,
 zonedToLocal,
 clockForTask,
};
