const express = require('express');
const db = require('../../db');
const asyncHandler = require('../../lib/asyncHandler');

// Mounted at /atodo/v1, public (no account needed: the login screen and the
// marketing pages are translated too). A-To-Do's interface texts and the
// languages they're in, from the maleniti schema (migration 010) -- edited
// in the admin app, so the client fetches them every time a page loads
// (Cache-Control: no-cache, with an ETag: a reload costs a 304 until a text
// changes).
//
//   GET /languages                          -> { languages: [{ id, name }] }
//   GET /translations?lang=hr&bundles=a,b   -> { language, strings: { name: text } }
//
// A text missing in the language falls back to English (an unknown
// language to English altogether, `language` then saying 'en').

const router = express.Router();

const BRAND = 'atodo';
const FALLBACK_LANGUAGE = 'en';
const BUNDLE_RE = /^[a-z][a-z0-9-]{0,39}$/;

function noCache(res) {
 res.setHeader('Cache-Control', 'no-cache');
}

router.get('/languages', asyncHandler(async (req, res) => {
 const { rows } = await db.query('SELECT language_id AS id, name FROM maleniti.language ORDER BY language_id');
 noCache(res);
 res.json({ languages: rows });
}));

router.get('/translations', asyncHandler(async (req, res) => {
 const bundles = String(req.query.bundles || '').split(',').map((b) => b.trim()).filter(Boolean);
 if (!bundles.length || bundles.length > 20 || !bundles.every((b) => BUNDLE_RE.test(b))) {
  return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'bundles must name one or more bundles, comma-separated.' });
 }
 const requested = /^[a-z]{2}$/.test(req.query.lang || '') ? req.query.lang : FALLBACK_LANGUAGE;
 const { rows: known } = await db.query('SELECT 1 FROM maleniti.language WHERE language_id = $1', [requested]);
 const language = known.length ? requested : FALLBACK_LANGUAGE;
 const { rows } = await db.query(
  `SELECT k.name, COALESCE(t.text, e.text, '') AS text
   FROM maleniti.translation_key k
   JOIN maleniti.brand b ON b.brand_id = k.brand_id
   LEFT JOIN maleniti.translation t ON t.trid = k.trid AND t.language_id = $2
   LEFT JOIN maleniti.translation e ON e.trid = k.trid AND e.language_id = $3
   WHERE b.code = $1 AND k.bundle = ANY($4)`,
  [BRAND, language, FALLBACK_LANGUAGE, bundles]
 );
 noCache(res);
 res.json({ language, strings: Object.fromEntries(rows.map((r) => [r.name, r.text])) });
}));

module.exports = router;
