// Checks on what A-To-Do's action requests send, before the domain sees it.
// Each throws a DomainError (400 VALIDATION_ERROR) naming the field.

const { DomainError } = require('./account');
const { isValidTimeZone } = require('./clock');

const fail = (message) => {
 throw new DomainError('VALIDATION_ERROR', message, 400);
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function date(value, field) {
 if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) fail(`${field} must be a date (YYYY-MM-DD)`);
 return value;
}

function optionalDate(value, field) {
 return value === null || value === undefined || value === '' ? null : date(value, field);
}

function time(value, field) {
 if (typeof value !== 'string' || !TIME_RE.test(value)) fail(`${field} must be a time (HH:MM)`);
 return value;
}

function text(value, field, { required = false, max = 10000 } = {}) {
 if (value === undefined || value === null) {
  if (required) fail(`${field} is required`);
  return '';
 }
 if (typeof value !== 'string') fail(`${field} must be text`);
 const trimmed = value.trim();
 if (required && !trimmed) fail(`${field} is required`);
 if (trimmed.length > max) fail(`${field} is too long (at most ${max} characters)`);
 return field === 'name' ? trimmed : value;
}

function timeZone(value) {
 if (value === null || value === undefined || value === '') return null;
 if (!isValidTimeZone(value)) fail('timeZone must be an IANA time zone, e.g. Europe/Zagreb');
 return value;
}

const FREQUENCY_TYPES = ['once', 'days', 'weeks', 'months'];

// The pattern's shape is recurrence.js's (see its top-of-file comment);
// only what's needed to evaluate it safely is checked here. Bookkeeping
// fields (startsOn, skipDates, pause) are the server's, never the client's.
function frequency(value) {
 if (!value || typeof value !== 'object' || Array.isArray(value)) fail('frequency must be an object');
 if (!FREQUENCY_TYPES.includes(value.type)) fail(`frequency.type must be one of ${FREQUENCY_TYPES.join(', ')}`);
 const interval = Number(value.interval ?? 1);
 if (!Number.isInteger(interval) || interval < 1 || interval > 1000) fail('frequency.interval must be a whole number from 1');
 const { startsOn, skipDates, pause, ...rest } = value;
 if (rest.weekdays !== undefined && (!Array.isArray(rest.weekdays) || rest.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) fail('frequency.weekdays must be weekday numbers 0-6');
 if (rest.days !== undefined && (!Array.isArray(rest.days) || rest.days.some((d) => !Number.isInteger(d) || d < 1 || d > 31))) fail('frequency.days must be days of the month 1-31');
 return { ...rest, interval };
}

// The task form's fields (create and edit).
function taskDetails(body) {
 const allDay = !!body.allDay;
 return {
  name: text(body.name, 'name', { required: true, max: 500 }),
  description: text(body.description, 'description', { max: 2000 }),
  details: text(body.details, 'details'),
  allDay,
  dueTime: allDay ? null : time(body.dueTime, 'dueTime'),
  appointment: !!body.appointment,
  passive: !!body.passive,
  timeZone: allDay ? null : timeZone(body.timeZone),
 };
}

function pattern(body) {
 const freq = frequency(body.frequency);
 return {
  dueDate: date(body.dueDate, 'dueDate'),
  frequency: freq,
  endDate: freq.type === 'once' ? null : optionalDate(body.endDate, 'endDate'),
  recurUntilCompleted: !!body.recurUntilCompleted,
 };
}

module.exports = { date, optionalDate, time, text, timeZone, frequency, taskDetails, pattern, fail };
