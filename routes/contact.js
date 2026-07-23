const express = require('express');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const requireSuperAdmin = require('../lib/requireSuperAdmin');
const rateLimiter = require('../lib/rateLimiter');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/', rateLimiter.strict, asyncHandler(async (req, res) => {
 const { name, email, kind, msg } = req.body;

 if (!name || typeof name !== 'string' ||
     !email || typeof email !== 'string' || !EMAIL_RE.test(email) ||
     !msg || typeof msg !== 'string') {
  return res.status(400).send('name, a valid email, and msg are required');
 }

 const { rows } = await db.query(
  `INSERT INTO contact_submissions (name, email, kind, msg)
   VALUES ($1, $2, $3, $4)
   RETURNING id, received_at`,
  [name, email, kind || null, msg]
 );

 res.status(201).json(rows[0]);
}));

router.get('/', requireSuperAdmin, asyncHandler(async (req, res) => {
 const { rows } = await db.query(
  `SELECT id, name, email, kind, msg, completed, received_at
   FROM contact_submissions
   ORDER BY received_at DESC`
 );
 res.json(rows);
}));

router.patch('/:id', requireSuperAdmin, asyncHandler(async (req, res) => {
 if (typeof req.body.completed !== 'boolean') {
  return res.status(400).send('completed (boolean) is required');
 }

 const { rows } = await db.query(
  `UPDATE contact_submissions SET completed = $1 WHERE id = $2
   RETURNING id, name, email, kind, msg, completed, received_at`,
  [req.body.completed, req.params.id]
 );
 if (rows.length === 0) return res.status(404).send('Not found');
 res.json(rows[0]);
}));

module.exports = router;
