const crypto = require('crypto');

// Only the hash is ever stored or queried against — the plaintext key exists
// only in the client's hands and briefly in memory during a request.
module.exports = function hashApiKey(key) {
 return crypto.createHash('sha256').update(key).digest('hex');
};
