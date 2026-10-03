const express = require('express');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const rateLimiter = require('../../lib/rateLimiter');
const jwt = require('../../lib/atodo/jwt');
const { toPasswordVersion } = require('../../lib/atodo/token');
const { notifyOwner } = require('../../lib/atodo/ownerAlerts');

// POST /atodo/v1/support -- A-To-Do's support form (the client's
// support.html): billing questions, account trouble, bugs, suggestions,
// complaints. Public -- someone who can't log in needs it most -- but a
// valid session token, if sent, files the message under its account.
// Stored with the website's own contact submissions (source 'atodo',
// migration 007; the admin app's Contact tab) and emailed to the owner.

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KINDS = ['billing', 'account', 'bug', 'feature', 'complaint', 'other'];
const MAX_MESSAGE = 10000;

// The account behind a bearer token, or null -- never rejects the request
// (unlike lib/atodo/authenticate.js), since the form works logged out too.
async function optionalAccount(req) {
 const [scheme, token] = (req.get('Authorization') || '').split(' ');
 if (scheme !== 'Bearer' || !token) return null;
 const payload = jwt.verify(token);
 if (!payload || !payload.sub || payload.purpose) return null;
 const { rows } = await db.query('SELECT id, email, password_changed_at FROM atodo.accounts WHERE id = $1', [payload.sub]);
 if (rows.length === 0 || toPasswordVersion(rows[0]) !== (payload.pwv ?? null)) return null;
 return rows[0];
}

// What the client sends to help diagnose a report -- kept small and flat.
function cleanContext(context) {
 if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
 const out = {};
 for (const key of ['appVersion', 'page', 'language', 'userAgent']) {
  if (typeof context[key] === 'string') out[key] = context[key].slice(0, 500);
 }
 return Object.keys(out).length ? out : null;
}

router.post('/', rateLimiter.strict, asyncHandler(async (req, res) => {
 const { name, email, kind, msg, context } = req.body || {};
 if (typeof name !== 'string' || !name.trim()) {
  return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'name is required' });
 }
 if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
  return res.status(400).json({ code: 'INVALID_EMAIL', message: 'Enter a valid email address.' });
 }
 if (!KINDS.includes(kind)) {
  return res.status(400).json({ code: 'VALIDATION_ERROR', message: `kind must be one of ${KINDS.join(', ')}` });
 }
 if (typeof msg !== 'string' || !msg.trim() || msg.length > MAX_MESSAGE) {
  return res.status(400).json({ code: 'VALIDATION_ERROR', message: `msg is required (at most ${MAX_MESSAGE} characters)` });
 }

 const account = await optionalAccount(req);
 const cleaned = cleanContext(context);
 const { rows: [row] } = await db.query(
  `INSERT INTO contact_submissions (name, email, kind, msg, source, atodo_account_id, context)
   VALUES ($1, $2, $3, $4, 'atodo', $5, $6)
   RETURNING id, received_at`,
  [name.trim(), email.trim(), kind, msg.trim(), account ? account.id : null, cleaned]
 );

 notifyOwner(
  `support request: ${kind}`,
  [msg.trim()],
  [
   ['From', `${name.trim()} <${email.trim()}>`],
   ['Account', account ? `${account.email} (${account.id})` : 'not logged in'],
   ...(cleaned ? Object.entries(cleaned).map(([k, v]) => [k, v]) : []),
   ['Submission', row.id],
  ]
 );

 res.status(201).json({ id: row.id, receivedAt: row.received_at });
}));

module.exports = router;
