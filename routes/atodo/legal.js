const express = require('express');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');
const { publishedDocument } = require('../../lib/maleniti/legal');

// Mounted at /atodo/v1, public: the Privacy Policy and Terms of Service as
// published (migration 011, edited in the admin app's Legal tab) -- what
// the client's privacy.html/terms.html show.
//
//   GET /legal/:kind?lang=hr   (kind: privacy | terms)
//     -> { kind, language, title, body, publishedAt }
//
// In the language asked for, else English (`language` says which). The body
// is HTML. A new version is live the moment it's published, so no-cache.

const router = express.Router();

router.get('/legal/:kind', asyncHandler(async (req, res) => {
 const doc = await publishedDocument(db, 'atodo', req.params.kind, req.query.lang);
 if (!doc) return res.status(404).json({ code: 'NOT_FOUND', message: 'No such document.' });
 res.setHeader('Cache-Control', 'no-cache');
 res.json(doc);
}));

module.exports = router;
