// When a price change may take effect, and until when it may still be
// edited. A service provider publishes a changed price list "najkasnije do
// 8:00 sati ujutro dana kada objavljuje izmjenu cjenika" (Odluka o objavi
// cjenika, NN 101/2026): a change taking effect at some moment has to be
// published by 08:00 Zagreb time that day. So at 09:00 a change can't be
// added for 21:00 the same day any more, but one for 01:00 tomorrow can --
// it's published straight away, long before tomorrow's 08:00. Until its
// deadline a change can still be edited (or withdrawn), even once it's
// taken effect that morning; after it, it's part of the published record.

const ZAGREB = 'Europe/Zagreb';

function zagrebParts(date) {
 const parts = Object.fromEntries(
  new Intl.DateTimeFormat('en-CA', {
   timeZone: ZAGREB, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, Number(p.value)])
 );
 return parts;
}

// The instant a Zagreb wall-clock time names (y, m 1-12, d, h, min).
function zagrebInstant(year, month, day, hour, minute) {
 const wanted = Date.UTC(year, month - 1, day, hour, minute);
 let guess = wanted;
 // Correct by the zone's offset at the guess; twice settles DST edges.
 for (let i = 0; i < 2; i++) {
  const p = zagrebParts(new Date(guess));
  const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  guess += wanted - shown;
 }
 return new Date(guess);
}

// 08:00 Zagreb on the day `moment` falls on (Zagreb time).
function publicationDeadline(moment) {
 const p = zagrebParts(moment);
 return zagrebInstant(p.year, p.month, p.day, 8, 0);
}

// Whether a change at `moment` can still be written (added, edited,
// withdrawn) at `now`.
function isEditable(moment, now = new Date()) {
 return now.getTime() <= publicationDeadline(moment).getTime();
}

// The earliest moment a new change can take effect at `now`: right away
// until 08:00, from midnight on afterwards.
function earliestNewChange(now = new Date()) {
 if (isEditable(now, now)) return now;
 const p = zagrebParts(now);
 const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
 return zagrebInstant(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), 0, 0);
}

module.exports = { publicationDeadline, isEditable, earliestNewChange, zagrebInstant };
