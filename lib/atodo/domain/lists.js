// Notes and activity logs of rows loaded "light" (see store.js): every other
// task in the account is loaded with only its state, so an action doesn't
// pull the whole account's notes and logs out of the database just to
// change one task. A light row's `comments`/`log` is a LightList: as long as
// the real one (the rules only ever look at `.length` -- is this occurrence
// blank? how many notes does this task have?), holding nulls, and anything
// pushed onto it is remembered as an append for the store to write
// (`log = log || appended`). Reading an actual entry of a light list is a
// bug -- the store loads a task "full" whenever an action needs its notes
// or log entries themselves -- so entries read as null and the store
// refuses to write a light list that was changed in any other way.

class LightList extends Array {
 static fromCount(count) {
  const list = new LightList();
  for (let i = 0; i < count; i++) Array.prototype.push.call(list, null);
  list.appended = [];
  list.loadedLength = count;
  return list;
 }

 push(...entries) {
  this.appended.push(...entries);
  return super.push(...entries);
 }

 // Array methods creating new arrays (map, filter, slice...) make plain
 // arrays, not LightLists.
 static get [Symbol.species]() {
  return Array;
 }
}

const isLight = (list) => list instanceof LightList;

// What a light list asks the store to append, or null if it's unchanged.
// Anything but appends since loading means a rule changed a light row's
// notes or log in place.
function lightAppends(list) {
 if (list.length !== list.loadedLength + list.appended.length) {
  throw new Error('A light row\'s notes or log were changed other than by appending -- load its task "full" for this action');
 }
 return list.appended.length ? list.appended : null;
}

module.exports = { LightList, isLight, lightAppends };
