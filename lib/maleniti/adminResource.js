const express = require('express');
const db = require('../../db');

// A CRUD router (list, create, replace, delete) for one table of the
// maleniti schema (migration 004), for the admin app. Like
// lib/crudResource.js, but for this schema's own shape: its texts aren't
// _hr/_en columns but translation ids (*_trid) -- here they're read and
// written as one object per text, { hr: '...', en: '...' }, which this
// factory turns into maleniti.translation_key/translation rows (a new trid
// per text on create, its translations replaced on update, deleted with the
// row). Mounted behind requireSuperAdmin (see routes/maleniti/admin.js).
//
//   table      -- the table, schema-qualified
//   id         -- its key column; generated (SERIAL) unless idFromBody
//   idFromBody -- the key is given on create (e.g. a language's code)
//   columns    -- writable plain columns: { name, required, type: 'text' | 'int' }
//   texts      -- translated texts: { field: 'trid_column' }
//   select     -- SELECT listing the rows (with any joined read-only
//                 columns), ending before ORDER BY; must return every column
//                 and trid column
//   orderBy    -- its ORDER BY
//
// Errors answer plain text, like the CMS's own write endpoints: 400 for a
// missing/invalid field, 404 for no such row, 409 for a duplicate or a row
// still referenced elsewhere.

class HttpError extends Error {
 constructor(status, message) {
  super(message);
  this.status = status;
 }
}

function adminHandler(fn) {
 return (req, res) => {
  Promise.resolve(fn(req, res)).catch((error) => {
   if (error instanceof HttpError) return res.status(error.status).send(error.message);
   // unique / foreign key / check / invalid input
   if (error.code === '23505') return res.status(409).send(error.detail || 'Already exists.');
   if (error.code === '23503') {
    return res.status(409).send(error.detail && error.detail.includes('is still referenced')
     ? `Still in use: ${error.detail}` : (error.detail || 'Refers to something that does not exist.'));
   }
   if (error.code === '23514' || error.code === '22P02' || error.code === '22003' || error.code === '22007' || error.code === '22008') {
    return res.status(400).send(error.message);
   }
   console.error('Error: ', error.message);
   console.error('Stack: ', error.stack);
   res.status(500).send(error.message);
  });
 };
}

// Every language's texts for these trids: { trid: { hr: '...', en: '...' } }.
async function loadTexts(client, trids) {
 if (trids.length === 0) return {};
 const { rows } = await client.query(
  'SELECT trid, language_id, text FROM maleniti.translation WHERE trid = ANY($1)',
  [trids]
 );
 const texts = {};
 for (const row of rows) (texts[row.trid] ||= {})[row.language_id] = row.text;
 return texts;
}

// A translated text from a request body: an object of language -> text,
// Croatian required (the published price lists are in Croatian, and fall
// back to it for any language a text lacks); empty texts are left out.
async function validateText(client, field, value) {
 if (!value || typeof value !== 'object' || Array.isArray(value)) {
  throw new HttpError(400, `${field} must be an object of language -> text, e.g. { "hr": "...", "en": "..." }`);
 }
 const entries = Object.entries(value).filter(([, text]) => typeof text === 'string' && text.trim() !== '');
 if (!entries.some(([lang]) => lang === 'hr')) throw new HttpError(400, `${field} needs a Croatian (hr) text`);
 const { rows } = await client.query('SELECT language_id FROM maleniti.language');
 const known = new Set(rows.map((r) => r.language_id));
 const unknown = entries.map(([lang]) => lang).filter((lang) => !known.has(lang));
 if (unknown.length > 0) throw new HttpError(400, `${field}: unknown language(s) ${unknown.join(', ')}`);
 return entries.map(([lang, text]) => [lang, text.trim()]);
}

async function writeTexts(client, trid, entries) {
 await client.query('DELETE FROM maleniti.translation WHERE trid = $1', [trid]);
 for (const [lang, text] of entries) {
  await client.query('INSERT INTO maleniti.translation (trid, language_id, text) VALUES ($1, $2, $3)', [trid, lang, text]);
 }
}

function columnValue(column, value) {
 if (value === undefined || value === null || value === '') {
  if (column.required) throw new HttpError(400, `${column.name} is required`);
  return null;
 }
 if (column.type === 'int') {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new HttpError(400, `${column.name} must be a whole number`);
  return n;
 }
 return String(value).trim();
}

async function inTransaction(fn) {
 const client = await db.getClient();
 try {
  await client.query('BEGIN');
  const result = await fn(client);
  await client.query('COMMIT');
  return result;
 } catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
 } finally {
  client.release();
 }
}

function adminResource({ table, id, idFromBody = false, columns, texts = {}, select, orderBy }) {
 const router = express.Router();
 const textFields = Object.entries(texts);

 async function list(client, where = '', params = []) {
  const { rows } = await client.query(`${select} ${where} ORDER BY ${orderBy}`, params);
  const loaded = await loadTexts(client, rows.flatMap((row) => textFields.map(([, trid]) => row[trid])));
  return rows.map((row) => {
   const out = { ...row };
   for (const [field, trid] of textFields) {
    out[field] = loaded[row[trid]] || {};
    delete out[trid];
   }
   return out;
  });
 }

 async function one(client, key) {
  const [row] = await list(client, `WHERE ${table}.${id} = $1`, [key]);
  return row;
 }

 router.get('/', adminHandler(async (req, res) => {
  res.json(await list(db));
 }));

 router.post('/', adminHandler(async (req, res) => {
  const body = req.body || {};
  const created = await inTransaction(async (client) => {
   const names = [];
   const values = [];
   if (idFromBody) {
    names.push(id);
    values.push(columnValue({ name: id, required: true }, body[id]));
   }
   for (const column of columns) {
    names.push(column.name);
    values.push(columnValue(column, body[column.name]));
   }
   for (const [field, tridColumn] of textFields) {
    const entries = await validateText(client, field, body[field]);
    const { rows: [key] } = await client.query('INSERT INTO maleniti.translation_key DEFAULT VALUES RETURNING trid');
    await writeTexts(client, key.trid, entries);
    names.push(tridColumn);
    values.push(key.trid);
   }
   const { rows: [row] } = await client.query(
    `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${id}`,
    values
   );
   return one(client, row[id]);
  });
  res.status(201).json(created);
 }));

 router.put('/:id', adminHandler(async (req, res) => {
  const body = req.body || {};
  const updated = await inTransaction(async (client) => {
   const tridColumns = textFields.map(([, trid]) => trid);
   const { rows: [existing] } = await client.query(
    `SELECT ${[id, ...tridColumns].join(', ')} FROM ${table} WHERE ${id} = $1 FOR UPDATE`,
    [req.params.id]
   );
   if (!existing) throw new HttpError(404, 'Not found');
   if (columns.length > 0) {
    const values = columns.map((column) => columnValue(column, body[column.name]));
    await client.query(
     `UPDATE ${table} SET ${columns.map((c, i) => `${c.name} = $${i + 2}`).join(', ')} WHERE ${id} = $1`,
     [req.params.id, ...values]
    );
   }
   for (const [field, tridColumn] of textFields) {
    await writeTexts(client, existing[tridColumn], await validateText(client, field, body[field]));
   }
   return one(client, req.params.id);
  });
  res.json(updated);
 }));

 router.delete('/:id', adminHandler(async (req, res) => {
  await inTransaction(async (client) => {
   const tridColumns = textFields.map(([, trid]) => trid);
   const { rows: [deleted] } = await client.query(
    `DELETE FROM ${table} WHERE ${id} = $1 RETURNING ${[id, ...tridColumns].join(', ')}`,
    [req.params.id]
   );
   if (!deleted) throw new HttpError(404, 'Not found');
   const trids = tridColumns.map((c) => deleted[c]);
   if (trids.length > 0) await client.query('DELETE FROM maleniti.translation_key WHERE trid = ANY($1)', [trids]);
  });
  res.sendStatus(204);
 }));

 return router;
}

module.exports = { adminResource, adminHandler, HttpError, inTransaction };
