const express = require('express');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const buildSetClause = require('../lib/buildSet');
const requireSuperAdmin = require('../lib/requireSuperAdmin');

const router = express.Router();

const SUMMARY_COLUMNS = `slug, tag_hr, tag_en, tone, date_hr, date_en, title_hr, title_en,
                         em_hr, em_en, excerpt_hr, excerpt_en, read_hr, read_en`;

const WRITABLE_COLUMNS = [
 'slug', 'tag_hr', 'tag_en', 'tone', 'date_hr', 'date_en', 'title_hr', 'title_en',
 'em_hr', 'em_en', 'excerpt_hr', 'excerpt_en', 'read_hr', 'read_en', 'body_hr', 'body_en',
];

const REQUIRED_COLUMNS = [
 'slug', 'tag_hr', 'tag_en', 'tone', 'date_hr', 'date_en', 'title_hr', 'title_en',
 'excerpt_hr', 'excerpt_en', 'read_hr', 'read_en', 'body_hr', 'body_en',
];

router.get('/', asyncHandler(async (req, res) => {
 const limit = Math.max(0, parseInt(req.query.limit, 10) || 20);
 const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

 const { rows } = await db.query(
  `SELECT ${SUMMARY_COLUMNS}
   FROM blog_posts
   ORDER BY published_at DESC
   LIMIT $1 OFFSET $2`,
  [limit, offset]
 );
 res.json(rows);
}));

router.get('/:slug', asyncHandler(async (req, res) => {
 const { rows } = await db.query(
  `SELECT ${SUMMARY_COLUMNS}, body_hr, body_en
   FROM blog_posts
   WHERE slug = $1`,
  [req.params.slug]
 );

 if (rows.length === 0) {
  return res.status(404).send('Blog post not found');
 }
 res.json(rows[0]);
}));

router.post('/', requireSuperAdmin, asyncHandler(async (req, res) => {
 const missing = REQUIRED_COLUMNS.filter((f) => req.body[f] === undefined || req.body[f] === null);
 if (missing.length > 0) {
  return res.status(400).send(`Missing required field(s): ${missing.join(', ')}`);
 }

 const { cols, values } = buildSetClause(WRITABLE_COLUMNS, req.body);
 const placeholders = cols.map((_, i) => `$${i + 1}`);

 const { rows } = await db.query(
  `INSERT INTO blog_posts (${cols.join(', ')}) VALUES (${placeholders.join(', ')})
   RETURNING ${SUMMARY_COLUMNS}, body_hr, body_en`,
  values
 );
 res.status(201).json(rows[0]);
}));

router.put('/:slug', requireSuperAdmin, asyncHandler(async (req, res) => {
 const missing = REQUIRED_COLUMNS.filter((f) => req.body[f] === undefined || req.body[f] === null);
 if (missing.length > 0) {
  return res.status(400).send(`Missing required field(s): ${missing.join(', ')}`);
 }

 const { setClause, values } = buildSetClause(WRITABLE_COLUMNS, req.body);
 const { rows } = await db.query(
  `UPDATE blog_posts SET ${setClause} WHERE slug = $${values.length + 1}
   RETURNING ${SUMMARY_COLUMNS}, body_hr, body_en`,
  [...values, req.params.slug]
 );
 if (rows.length === 0) return res.status(404).send('Blog post not found');
 res.json(rows[0]);
}));

router.patch('/:slug', requireSuperAdmin, asyncHandler(async (req, res) => {
 const { setClause, values } = buildSetClause(WRITABLE_COLUMNS, req.body);
 if (values.length === 0) return res.status(400).send('No updatable fields provided');

 const { rows } = await db.query(
  `UPDATE blog_posts SET ${setClause} WHERE slug = $${values.length + 1}
   RETURNING ${SUMMARY_COLUMNS}, body_hr, body_en`,
  [...values, req.params.slug]
 );
 if (rows.length === 0) return res.status(404).send('Blog post not found');
 res.json(rows[0]);
}));

router.delete('/:slug', requireSuperAdmin, asyncHandler(async (req, res) => {
 const { rowCount } = await db.query('DELETE FROM blog_posts WHERE slug = $1', [req.params.slug]);
 if (rowCount === 0) return res.status(404).send('Blog post not found');
 res.status(204).send();
}));

module.exports = router;
