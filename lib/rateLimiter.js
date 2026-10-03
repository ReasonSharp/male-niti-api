const rateLimit = require('express-rate-limit');
const { banIp } = require('./ipBan');

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const GENERAL_MAX = Number(process.env.RATE_LIMIT_GENERAL_MAX) || 300;
const STRICT_MAX = Number(process.env.RATE_LIMIT_STRICT_MAX) || 10;
// A-To-Do's reads (GET /atodo/v1/...): the client loads its list a day at a
// time as it scrolls, plus the side panel and agenda after every change --
// far more requests than the general limit is meant for, in short bursts.
// They get their own short window instead (100 per 10 s by default), and
// hitting it is no strike: it's an ordinary client backing off, not abuse.
const ATODO_READS_WINDOW_MS = Number(process.env.RATE_LIMIT_ATODO_READS_WINDOW_MS) || 10 * 1000;
const ATODO_READS_MAX = Number(process.env.RATE_LIMIT_ATODO_READS_MAX) || 100;

// Repeatedly getting rate-limited (not just hitting it once) is what earns an IP ban.
const STRIKE_LIMIT = Number(process.env.RATE_LIMIT_STRIKE_LIMIT) || 5;
const STRIKE_WINDOW_MS = Number(process.env.RATE_LIMIT_STRIKE_WINDOW_MS) || 60 * 60 * 1000;
const BAN_DURATION_MS = Number(process.env.RATE_LIMIT_BAN_DURATION_MS) || 24 * 60 * 60 * 1000;

const strikes = new Map();

function recordStrike(ip) {
 const now = Date.now();
 const entry = strikes.get(ip);

 if (!entry || now - entry.windowStart > STRIKE_WINDOW_MS) {
  strikes.set(ip, { count: 1, windowStart: now });
  return;
 }

 entry.count += 1;
 if (entry.count >= STRIKE_LIMIT) {
  strikes.delete(ip);
  banIp(ip, 'repeated rate limit violations', BAN_DURATION_MS)
   .catch((err) => console.error('Failed to ban IP: ', err.message));
 }
}

function makeLimiter(max, { windowMs = WINDOW_MS, strikes: countStrikes = true, skip = () => false } = {}) {
 return rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  // The super admin (only one person) is exempt so routine admin work never
  // trips rate limiting or, worse, gets that IP auto-banned.
  skip: (req) => Boolean(req.auth && req.auth.isSuperAdmin) || skip(req),
  handler: (req, res) => {
   if (countStrikes) recordStrike(req.ip);
   res.status(429).send('Too many requests');
  },
 });
}

const isAtodoRead = (req) => req.method === 'GET' && req.path.startsWith('/atodo/v1/');

module.exports = {
 general: makeLimiter(GENERAL_MAX, { skip: isAtodoRead }),
 strict: makeLimiter(STRICT_MAX),
 atodoReads: makeLimiter(ATODO_READS_MAX, { windowMs: ATODO_READS_WINDOW_MS, strikes: false, skip: (req) => !isAtodoRead(req) }),
};
