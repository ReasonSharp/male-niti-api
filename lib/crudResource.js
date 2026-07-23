const express = require('express');
const db = require('../db');
const asyncHandler = require('./asyncHandler');
const buildSetClause = require('./buildSet');
const requireSuperAdmin = require('./requireSuperAdmin');

// A full CRUD router (list, create, full/partial update, delete) for a table
// keyed by its `id` column. Used by resources whose shape is otherwise
// identical: services, pricing_plans, work_items. GET is public per the API
// spec; every mutating method is restricted to the super admin.
module.exports = function crudResource({ table, columns, required, orderBy }) {
 const router = express.Router();
 const returning = `id, ${columns.join(', ')}`;

 router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
   `SELECT ${returning} FROM ${table} ORDER BY ${orderBy}`
  );
  res.json(rows);
 }));

 router.post('/', requireSuperAdmin, asyncHandler(async (req, res) => {
  const missing = required.filter((f) => req.body[f] === undefined || req.body[f] === null);
  if (missing.length > 0) {
   return res.status(400).send(`Missing required field(s): ${missing.join(', ')}`);
  }

  const { cols, values } = buildSetClause(columns, req.body);
  const placeholders = cols.map((_, i) => `$${i + 1}`);

  const { rows } = await db.query(
   `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING ${returning}`,
   values
  );
  res.status(201).json(rows[0]);
 }));

 router.put('/:id', requireSuperAdmin, asyncHandler(async (req, res) => {
  const missing = required.filter((f) => req.body[f] === undefined || req.body[f] === null);
  if (missing.length > 0) {
   return res.status(400).send(`Missing required field(s): ${missing.join(', ')}`);
  }

  const { setClause, values } = buildSetClause(columns, req.body);
  const { rows } = await db.query(
   `UPDATE ${table} SET ${setClause} WHERE id = $${values.length + 1} RETURNING ${returning}`,
   [...values, req.params.id]
  );
  if (rows.length === 0) return res.status(404).send('Not found');
  res.json(rows[0]);
 }));

 router.patch('/:id', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { setClause, values } = buildSetClause(columns, req.body);
  if (values.length === 0) return res.status(400).send('No updatable fields provided');

  const { rows } = await db.query(
   `UPDATE ${table} SET ${setClause} WHERE id = $${values.length + 1} RETURNING ${returning}`,
   [...values, req.params.id]
  );
  if (rows.length === 0) return res.status(404).send('Not found');
  res.json(rows[0]);
 }));

 router.delete('/:id', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { rowCount } = await db.query(`DELETE FROM ${table} WHERE id = $1`, [req.params.id]);
  if (rowCount === 0) return res.status(404).send('Not found');
  res.status(204).send();
 }));

 return router;
};
