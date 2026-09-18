const crypto = require('crypto');

const KEY_LEN = 64;

// scrypt is built into Node's own crypto module, so this needs no extra
// dependency (bcrypt would mean another native module to build in Docker,
// on top of canvas -- see the Dockerfile notes in CLAUDE.md).
function hashPassword(password) {
 const salt = crypto.randomBytes(16).toString('hex');
 const hash = crypto.scryptSync(password, salt, KEY_LEN).toString('hex');
 return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
 const [salt, hash] = (stored || '').split(':');
 if (!salt || !hash) return false;

 const candidate = crypto.scryptSync(password, salt, KEY_LEN);
 const expected = Buffer.from(hash, 'hex');
 if (candidate.length !== expected.length) return false;
 return crypto.timingSafeEqual(candidate, expected);
}

module.exports = { hashPassword, verifyPassword };
