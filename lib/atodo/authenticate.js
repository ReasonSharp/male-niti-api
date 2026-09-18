const jwt = require('./jwt');

// Unlike lib/authenticate.js (the CMS's API-key auth, which never rejects),
// every atodo route except register/verify-email/login requires a valid
// bearer token per api-spec.yaml's global `security: bearerAuth` -- so this
// middleware rejects outright instead of just annotating req.
module.exports = function requireAtodoAuth(req, res, next) {
 const [scheme, token] = (req.get('Authorization') || '').split(' ');
 if (scheme !== 'Bearer' || !token) {
  return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Missing or invalid bearer token.' });
 }

 const payload = jwt.verify(token);
 if (!payload || !payload.sub) {
  return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Missing or invalid bearer token.' });
 }

 req.atodoAuth = { id: payload.sub };
 next();
};
