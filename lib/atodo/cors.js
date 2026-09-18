// Only /atodo/v1 needs this -- the CMS routes are never called from a
// browser origin other than their own. Wide open (not an allow-list)
// because auth here is a bearer token in the client's localStorage, not a
// cookie: a third-party page can't read another origin's localStorage, so
// there's no session for a wildcard origin to ride along on. Lets atodo be
// reached directly on its own port/host (e.g. local dev) as well as
// same-origin behind nginx in prod, with nothing to keep in sync either way.
module.exports = function atodoCors(req, res, next) {
 res.setHeader('Access-Control-Allow-Origin', '*');
 res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
 res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
 if (req.method === 'OPTIONS') {
  res.sendStatus(204);
  return;
 }
 next();
};
