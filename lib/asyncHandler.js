module.exports = (fn) => (req, res, next) => {
 Promise.resolve(fn(req, res, next)).catch((error) => {
  console.error('Error: ', error.message);
  console.error('Stack: ', error.stack);
  if (error.code === '23505') {
   // {code, message} JSON -- this handler is shared by every router, CMS
   // and atodo alike (see CLAUDE.md), so this now changes the CMS's own
   // duplicate-slug 409 shape too, not just atodo's; no CMS caller in this
   // repo depends on the old plain-text body, and JSON matches every other
   // atodo error response's own contract, which is the one that actually
   // matters here: the atodo client's apiFetch only ever reads err.code off
   // a JSON body, so this 409 was previously indistinguishable from any
   // other failure client-side. Was plain text harmlessly until the atodo
   // client started offering a direct occurrence reschedule, which can now
   // hit atodo.occurrences' own (account_id, task_id, occurrence_date)
   // unique constraint from an ordinary user action, not just a
   // hypothetical bulk-import bug.
   return res.status(409).json({ code: 'CONFLICT', message: error.detail || error.message });
  }
  res.status(500).send(error.message);
 });
};
