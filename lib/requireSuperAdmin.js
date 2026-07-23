module.exports = function requireSuperAdmin(req, res, next) {
 if (!req.auth) return res.status(401).send('Authentication required');
 if (!req.auth.isSuperAdmin) return res.status(403).send('Super admin access required');
 next();
};
