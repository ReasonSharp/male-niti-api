const db = require('../db');
const asyncHandler = require('./asyncHandler');
const hashApiKey = require('./apiKeyHash');

// Optional auth: never rejects. Populates req.auth with { id, label, isSuperAdmin }
// for a valid Bearer key, or null otherwise, so downstream routes/middleware can
// decide for themselves whether auth is required at all.
module.exports = asyncHandler(async (req, res, next) => {
 const [scheme, token] = (req.get('Authorization') || '').split(' ');

 if (scheme !== 'Bearer' || !token) {
  req.auth = null;
  return next();
 }

 const { rows } = await db.query(
  'SELECT id, label, is_super_admin FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL',
  [hashApiKey(token)]
 );

 req.auth = rows[0]
  ? { id: rows[0].id, label: rows[0].label, isSuperAdmin: rows[0].is_super_admin }
  : null;

 next();

 if (req.auth) {
  db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [req.auth.id])
   .catch((err) => console.error('Failed to update api_keys.last_used_at: ', err.message));
 }
});
