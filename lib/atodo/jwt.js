const crypto = require('crypto');

// A minimal hand-rolled HS256 JWT (header.payload.signature, base64url,
// HMAC-SHA256) -- avoids pulling in the `jsonwebtoken` package for a format
// this small, matching the rest of this repo's light dependency footprint.
function getSecret() {
 const secret = process.env.ATODO_JWT_SECRET;
 if (!secret) throw new Error('ATODO_JWT_SECRET is not configured');
 return secret;
}

function base64url(obj) {
 return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function sign(payload, expiresInSeconds) {
 const secret = getSecret();
 const now = Math.floor(Date.now() / 1000);
 const header = base64url({ alg: 'HS256', typ: 'JWT' });
 const body = base64url({ ...payload, iat: now, exp: now + expiresInSeconds });
 const signingInput = `${header}.${body}`;
 const signature = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
 return `${signingInput}.${signature}`;
}

// Returns the decoded payload for a valid, unexpired, correctly-signed
// token, or null for anything else (malformed, tampered, expired).
function verify(token) {
 const secret = getSecret();
 const parts = typeof token === 'string' ? token.split('.') : [];
 if (parts.length !== 3) return null;

 const [headerPart, bodyPart, signaturePart] = parts;
 const expectedSignature = crypto.createHmac('sha256', secret).update(`${headerPart}.${bodyPart}`).digest('base64url');

 const provided = Buffer.from(signaturePart);
 const expected = Buffer.from(expectedSignature);
 if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;

 let payload;
 try {
  payload = JSON.parse(Buffer.from(bodyPart, 'base64url').toString('utf8'));
 } catch {
  return null;
 }

 if (typeof payload.exp === 'number' && Math.floor(Date.now() / 1000) >= payload.exp) return null;
 return payload;
}

module.exports = { sign, verify };
