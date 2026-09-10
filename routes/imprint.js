const express = require('express');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const buildSetClause = require('../lib/buildSet');
const requireSuperAdmin = require('../lib/requireSuperAdmin');

const router = express.Router();

const COLUMNS = [
 'legal_name', 'legal_form_hr', 'legal_form_en', 'owner_name', 'address',
 'oib', 'registration_number', 'register_hr', 'register_en',
 'vat_status_hr', 'vat_status_en', 'phone', 'bank_name', 'iban', 'swift',
 'hosting_provider',
];

// phone is the only nullable column - see db/schema.sql.
const REQUIRED_COLUMNS = COLUMNS.filter((c) => c !== 'phone');

router.get('/', asyncHandler(async (req, res) => {
 const { rows } = await db.query(`SELECT ${COLUMNS.join(', ')} FROM imprint LIMIT 1`);
 if (rows.length === 0) return res.status(404).send('Imprint not set');
 res.json(rows[0]);
}));

// Singleton resource: created once via POST, then edited via PATCH - same
// shape as api-keys/bootstrap's "only ever succeeds once" but with a 409
// instead of a 404, since existence is meant to be recoverable (unlike a
// plaintext secret that can't be regenerated).
router.post('/', requireSuperAdmin, asyncHandler(async (req, res) => {
 const { rows: existing } = await db.query('SELECT id FROM imprint LIMIT 1');
 if (existing.length > 0) {
  return res.status(409).send('Imprint already exists - use PATCH to update it');
 }

 const missing = REQUIRED_COLUMNS.filter((f) => req.body[f] === undefined || req.body[f] === null);
 if (missing.length > 0) {
  return res.status(400).send(`Missing required field(s): ${missing.join(', ')}`);
 }

 const { cols, values } = buildSetClause(COLUMNS, req.body);
 const placeholders = cols.map((_, i) => `$${i + 1}`);

 const { rows } = await db.query(
  `INSERT INTO imprint (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING ${COLUMNS.join(', ')}`,
  values
 );
 res.status(201).json(rows[0]);
}));

router.patch('/', requireSuperAdmin, asyncHandler(async (req, res) => {
 const { setClause, values } = buildSetClause(COLUMNS, req.body);
 if (values.length === 0) return res.status(400).send('No updatable fields provided');

 const { rows: existing } = await db.query('SELECT id FROM imprint LIMIT 1');
 if (existing.length === 0) return res.status(404).send('Imprint not set - use POST to create it');

 const { rows } = await db.query(
  `UPDATE imprint SET ${setClause} WHERE id = $${values.length + 1} RETURNING ${COLUMNS.join(', ')}`,
  [...values, existing[0].id]
 );
 res.json(rows[0]);
}));

module.exports = router;
