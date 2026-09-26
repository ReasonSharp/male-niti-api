const jwt = require('./jwt');
const db = require('../../db');
const asyncHandler = require('../asyncHandler');
const { toPasswordVersion } = require('./token');

// Unlike lib/authenticate.js (the CMS's API-key auth, which never rejects),
// every atodo route except register/verify-email/login requires a valid
// bearer token per api-spec.yaml's global `security: bearerAuth` -- so this
// middleware rejects outright instead of just annotating req.
//
// Also the one place this integration's "tokens are a snapshot, not live
// truth" rule (see CLAUDE.md) doesn't hold: it checks the token's `pwv`
// (password version) claim against the account's live password_changed_at
// on every request, not just at /auth/me, so POST /users/me/change-password
// can actually end every *other* outstanding session immediately, per
// atodo-api-spec.yaml's own description of that endpoint -- a stale JWT
// alone can't self-invalidate.
module.exports = asyncHandler(async (req, res, next) => {
 const [scheme, token] = (req.get('Authorization') || '').split(' ');
 if (scheme !== 'Bearer' || !token) {
  return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Missing or invalid bearer token.' });
 }

 const payload = jwt.verify(token);
 // A token with a `purpose` (an email-change undo link's, a password-reset
 // one -- see routes/atodo/auth.js) is signed with the same key but is never
 // a session: those carry no `sub` anyway, and this check keeps it that way
 // even if one ever did.
 if (!payload || !payload.sub || payload.purpose) {
  return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Missing or invalid bearer token.' });
 }

 const { rows } = await db.query('SELECT password_changed_at FROM atodo.accounts WHERE id = $1', [payload.sub]);
 if (rows.length === 0 || toPasswordVersion(rows[0]) !== (payload.pwv ?? null)) {
  return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Missing or invalid bearer token.' });
 }

 req.atodoAuth = { id: payload.sub };
 next();
});
