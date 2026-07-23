const db = require('../db');
const asyncHandler = require('./asyncHandler');

const checkBanned = asyncHandler(async (req, res, next) => {
 const { rows } = await db.query(
  'SELECT 1 FROM banned_ips WHERE ip = $1 AND (expires_at IS NULL OR expires_at > now())',
  [req.ip]
 );
 if (rows.length > 0) {
  return res.status(403).send('Forbidden');
 }
 next();
});

async function banIp(ip, reason, durationMs) {
 const expiresAt = durationMs ? new Date(Date.now() + durationMs) : null;
 await db.query(
  `INSERT INTO banned_ips (ip, reason, expires_at)
   VALUES ($1, $2, $3)
   ON CONFLICT (ip) DO UPDATE SET reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at, banned_at = now()`,
  [ip, reason, expiresAt]
 );
}

module.exports = { checkBanned, banIp };
