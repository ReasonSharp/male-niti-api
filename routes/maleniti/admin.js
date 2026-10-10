const express = require('express');
const db = require('../../db');
const { adminResource, adminHandler, HttpError, inTransaction } = require('../../lib/maleniti/adminResource');
const { publicationDeadline, isEditable, earliestNewChange } = require('../../lib/maleniti/schedule');

// /maleniti/v1/admin -- the admin app's editing of the maleniti schema
// (migration 004: the business model behind the published price lists, see
// routes/priceLists.js). Super admin only (mounted behind requireSuperAdmin
// in server.js). Points of sale, devices, brands and products are plain
// CRUD (lib/maleniti/adminResource.js, texts as { hr, en } objects), and so
// is renaming a language; creating and deleting one, a brand client's
// interface texts (migration 010, the Translations tab), price lists, their
// versions and which point of sale uses which list are written by hand
// below.

const router = express.Router();

// A new language starts as a copy of an existing one's texts (copy_from) --
// every text there is, interface and business data alike -- so it's whole
// from the start and gets translated in place. English (the fallback for a
// missing text) and Croatian (the price lists' language) can't be deleted;
// any other takes its texts with it, and its accounts go back to choosing
// (migration 010).
const LANGUAGE_RE = /^[a-z]{2}$/;
const PERMANENT_LANGUAGES = ['en', 'hr'];

router.post('/languages', adminHandler(async (req, res) => {
 const body = req.body || {};
 const languageId = typeof body.language_id === 'string' ? body.language_id.trim() : '';
 const name = typeof body.name === 'string' ? body.name.trim() : '';
 const copyFrom = body.copy_from || null;
 if (!LANGUAGE_RE.test(languageId)) throw new HttpError(400, 'language_id must be a two-letter code, e.g. "de"');
 if (!name) throw new HttpError(400, 'name is required');
 const created = await inTransaction(async (client) => {
  if (copyFrom) {
   const { rows } = await client.query('SELECT 1 FROM maleniti.language WHERE language_id = $1', [copyFrom]);
   if (!rows.length) throw new HttpError(400, `copy_from: no language ${copyFrom}`);
  }
  const { rows: [row] } = await client.query(
   'INSERT INTO maleniti.language (language_id, name) VALUES ($1, $2) RETURNING language_id, name',
   [languageId, name]
  );
  if (copyFrom) {
   await client.query(
    'INSERT INTO maleniti.translation (trid, language_id, text) SELECT trid, $1, text FROM maleniti.translation WHERE language_id = $2',
    [languageId, copyFrom]
   );
  }
  return row;
 });
 res.status(201).json(created);
}));

router.delete('/languages/:id', adminHandler(async (req, res) => {
 if (PERMANENT_LANGUAGES.includes(req.params.id)) {
  throw new HttpError(409, `${req.params.id} can't be deleted: English is the fallback for a missing text, Croatian the price lists' language.`);
 }
 const { rowCount } = await db.query('DELETE FROM maleniti.language WHERE language_id = $1', [req.params.id]);
 if (!rowCount) throw new HttpError(404, 'No such language.');
 res.status(204).send();
}));

router.use('/languages', adminResource({
 table: 'maleniti.language',
 id: 'language_id',
 idFromBody: true,
 columns: [{ name: 'name', required: true }],
 select: 'SELECT language_id, name FROM maleniti.language',
 orderBy: 'language_id',
}));

router.use('/points-of-sale', adminResource({
 table: 'maleniti.point_of_sale',
 id: 'point_of_sale_id',
 columns: [{ name: 'code', required: true }, { name: 'address', required: true }],
 texts: { type: 'type_trid' },
 select: 'SELECT point_of_sale_id, code, address, type_trid FROM maleniti.point_of_sale',
 orderBy: 'code',
}));

router.use('/devices', adminResource({
 table: 'maleniti.device',
 id: 'device_id',
 columns: [{ name: 'point_of_sale_id', required: true, type: 'int' }, { name: 'device_number', required: true, type: 'int' }],
 select: `SELECT maleniti.device.device_id, maleniti.device.point_of_sale_id, maleniti.device.device_number,
                 pos.code AS point_of_sale_code
          FROM maleniti.device JOIN maleniti.point_of_sale pos USING (point_of_sale_id)`,
 orderBy: 'pos.code, maleniti.device.device_number',
}));

router.use('/brands', adminResource({
 table: 'maleniti.brand',
 id: 'brand_id',
 columns: [{ name: 'code', required: true }],
 texts: { name: 'name_trid' },
 select: 'SELECT brand_id, code, name_trid FROM maleniti.brand',
 orderBy: 'code',
}));

// featured_ord/highlight: its place on the brand's landing page (null = not
// shown); billing_interval/stripe_product_id: what checkout sells it as
// (migration 005).
router.use('/products', adminResource({
 table: 'maleniti.product',
 id: 'product_id',
 columns: [
  { name: 'brand_id', required: true, type: 'int' },
  { name: 'code', required: true },
  { name: 'featured_ord', type: 'int' },
  { name: 'highlight', type: 'bool' },
  { name: 'billing_interval' },
  { name: 'stripe_product_id' },
 ],
 texts: { name: 'name_trid' },
 select: `SELECT maleniti.product.product_id, maleniti.product.brand_id, maleniti.product.code, maleniti.product.name_trid,
                 maleniti.product.featured_ord, maleniti.product.highlight, maleniti.product.billing_interval,
                 maleniti.product.stripe_product_id,
                 brand.code AS brand_code
          FROM maleniti.product JOIN maleniti.brand brand USING (brand_id)`,
 orderBy: 'brand.code, maleniti.product.featured_ord NULLS LAST, maleniti.product.product_id',
}));

// ---------------------------------------------------------------------------
// Price lists. A list's products are the ones it has prices for, and it
// keeps every price it ever held: a price change is a new price row at the
// moment it takes effect. The admin app shows each such moment as a version
// of the list (its prices then, the changed ones marked): "copying" a
// version makes a new one with new prices for the same products (only the
// changed ones become rows), adding or removing products means a new list.
// Which list a point of sale uses from when is pos_price_list.
//
// Every change, versions and point-of-sale switches alike, follows the
// publication deadline (lib/maleniti/schedule.js): a new one has to be in
// the future and still publishable (by 08:00 Zagreb on the day it takes
// effect), and stays editable until that same deadline.
// ---------------------------------------------------------------------------

// A minute's leeway for "now", so a change saved "now" from the admin app
// isn't refused for the second or two the request took.
const NOW_TOLERANCE_MS = 60 * 1000;

function parseMoment(field, value) {
 const date = new Date(value);
 if (value === undefined || value === null || value === '' || Number.isNaN(date.getTime())) {
  throw new HttpError(400, `${field} must be a date and time (ISO 8601)`);
 }
 return date;
}

const sameMoment = (a, b) => Math.abs(a.getTime() - b.getTime()) < 1;
const formatZagreb = (date) => date.toLocaleString('hr-HR', { timeZone: 'Europe/Zagreb' });

// A moment a change is being written for: in the future (or, for an edit,
// the moment it already had) and not past its publication deadline.
function checkChangeMoment(field, moment, { existing = null, now = new Date() } = {}) {
 if (!(existing && sameMoment(existing, moment)) && moment.getTime() < now.getTime() - NOW_TOLERANCE_MS) {
  throw new HttpError(400, `${field} can't be in the past`);
 }
 if (!isEditable(moment, now)) {
  throw new HttpError(400, `${field}: a change taking effect then had to be published by ${formatZagreb(publicationDeadline(moment))} - the earliest possible now is ${formatZagreb(earliestNewChange(now))}`);
 }
}

function checkStillEditable(moment, what) {
 if (!isEditable(moment)) {
  throw new HttpError(409, `${what} was due for publication by ${formatZagreb(publicationDeadline(moment))} and can no longer be changed.`);
 }
}

// Prices from a request: [{ product_id, price_eur, anchored, special_sale }],
// each product once.
function parsePrices(prices) {
 if (!Array.isArray(prices) || prices.length === 0) throw new HttpError(400, 'prices must list at least one price');
 const seen = new Set();
 return prices.map((price, i) => {
  const at = `prices[${i}]`;
  const productId = Number(price.product_id);
  if (!Number.isInteger(productId)) throw new HttpError(400, `${at}.product_id is required`);
  if (seen.has(productId)) throw new HttpError(400, `${at}: the same product twice`);
  seen.add(productId);
  const amount = Number(price.price_eur);
  if (price.price_eur === '' || price.price_eur === null || !Number.isFinite(amount) || amount < 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
   throw new HttpError(400, `${at}.price_eur must be an amount in EUR, at most two decimals`);
  }
  return { productId, amount: Math.round(amount * 100) / 100, anchored: !!price.anchored, specialSale: !!price.special_sale };
 });
}

async function checkProductsExist(client, prices) {
 const { rows: [{ known }] } = await client.query(
  'SELECT count(*)::int AS known FROM maleniti.product WHERE product_id = ANY($1)',
  [prices.map((p) => p.productId)]
 );
 if (known !== prices.length) throw new HttpError(400, 'prices name a product that does not exist');
}

// Whether a price of a version changes anything against the price before
// it: a different amount or special-sale flag, or it's to be the new anchor
// price. Not asking for an anchor isn't a change -- the anchor price is the
// latest anchored one, so it simply stays what it was.
const changesPrice = (row, price) =>
 !row || Number(row.price_eur) !== price.amount || row.special_sale !== price.specialSale || (price.anchored && !row.anchored);

// A list's versions: each moment a price of it takes effect, with the whole
// list as it stands then (every product's latest price up to that moment)
// and which of those prices change at it.
function buildVersions(priceRows, products, now) {
 const moments = [...new Set(priceRows.map((r) => r.valid_from.getTime()))].sort((a, b) => a - b);
 return moments.map((moment, i) => {
  const latest = new Map();
  for (const row of priceRows) {
   if (row.valid_from.getTime() <= moment) latest.set(row.product_id, row);
  }
  const at = new Date(moment);
  return {
   valid_from: at.toISOString(),
   base: i === 0,
   editable: isEditable(at, now),
   deadline: publicationDeadline(at).toISOString(),
   prices: [...latest.values()]
    .sort((a, b) => a.product_id - b.product_id)
    .map((row) => ({
     price_id: row.price_id,
     product_id: row.product_id,
     product_code: products.get(row.product_id).code,
     price_eur: Number(row.price_eur),
     anchored: row.anchored,
     special_sale: row.special_sale,
     changed: row.valid_from.getTime() === moment,
    })),
  };
 });
}

async function loadPriceRows(client, priceListId) {
 const { rows } = await client.query(
  `SELECT price_id, product_id, date_trunc('milliseconds', valid_from) AS valid_from, price_eur, anchored, special_sale
   FROM maleniti.price WHERE price_list_id = $1 ORDER BY valid_from, product_id`,
  [priceListId]
 );
 return rows;
}

async function lockPriceList(client, id) {
 const { rows: [list] } = await client.query('SELECT price_list_id FROM maleniti.price_list WHERE price_list_id = $1 FOR UPDATE', [id]);
 if (!list) throw new HttpError(404, 'Not found');
}

router.get('/price-lists', adminHandler(async (req, res) => {
 const now = new Date();
 const { rows: lists } = await db.query('SELECT price_list_id, created_at FROM maleniti.price_list ORDER BY price_list_id DESC');
 const { rows: prices } = await db.query(
  `SELECT price_list_id, price_id, product_id, date_trunc('milliseconds', valid_from) AS valid_from, price_eur, anchored, special_sale
   FROM maleniti.price ORDER BY valid_from, product_id`
 );
 const { rows: productRows } = await db.query('SELECT product_id, code FROM maleniti.product');
 const products = new Map(productRows.map((p) => [p.product_id, p]));
 const { rows: links } = await db.query(
  `SELECT l.pos_price_list_id, l.point_of_sale_id, pos.code AS point_of_sale_code, l.price_list_id, l.valid_from
   FROM maleniti.pos_price_list l JOIN maleniti.point_of_sale pos USING (point_of_sale_id)
   ORDER BY l.valid_from`
 );
 res.json({
  earliest_valid_from: earliestNewChange(now).toISOString(),
  price_lists: lists.map((list) => ({
   price_list_id: list.price_list_id,
   created_at: list.created_at,
   versions: buildVersions(prices.filter((p) => p.price_list_id === list.price_list_id), products, now).reverse(),
   // Each with until: when that point of sale moved on to another list.
   used_at: links.filter((l) => l.price_list_id === list.price_list_id)
    .map((l) => {
     const next = links.find((o) => o.point_of_sale_id === l.point_of_sale_id && o.valid_from > l.valid_from);
     return { ...l, until: next ? next.valid_from : null, editable: isEditable(l.valid_from, now) };
    }),
  })),
 });
}));

// A new list: its first prices at valid_from, used from then on at the
// given points of sale (if any -- it can be assigned later too).
router.post('/price-lists', adminHandler(async (req, res) => {
 const body = req.body || {};
 const created = await inTransaction(async (client) => {
  const validFrom = parseMoment('valid_from', body.valid_from);
  checkChangeMoment('valid_from', validFrom);
  const prices = parsePrices(body.prices);
  await checkProductsExist(client, prices);
  const posIds = (body.point_of_sale_ids || []).map(Number);
  const { rows: [list] } = await client.query('INSERT INTO maleniti.price_list DEFAULT VALUES RETURNING price_list_id');
  for (const p of prices) {
   await client.query(
    `INSERT INTO maleniti.price (product_id, price_list_id, valid_from, price_eur, anchored, special_sale)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [p.productId, list.price_list_id, validFrom, p.amount, p.anchored, p.specialSale]
   );
  }
  for (const posId of posIds) {
   await client.query(
    'INSERT INTO maleniti.pos_price_list (point_of_sale_id, price_list_id, valid_from) VALUES ($1, $2, $3)',
    [posId, list.price_list_id, validFrom]
   );
  }
  return { price_list_id: list.price_list_id };
 });
 res.status(201).json(created);
}));

// Writes one version of a list: `prices` is the whole list as it should
// stand from `validFrom` on; only the prices differing from the version
// before it become rows (kept, with their price_id, if already there).
// `existingMoment` is the version being edited (null for a new one).
async function writeVersion(client, priceListId, { existingMoment, validFrom, prices }) {
 const rows = await loadPriceRows(client, priceListId);
 const moments = [...new Set(rows.map((r) => r.valid_from.getTime()))].sort((a, b) => a - b);
 const others = moments.filter((m) => !existingMoment || m !== existingMoment.getTime());
 const before = others.filter((m) => m < (existingMoment || validFrom).getTime());
 const after = others.filter((m) => m > (existingMoment || validFrom).getTime());
 if (others.includes(validFrom.getTime())) throw new HttpError(400, 'The list already has a version at that moment - edit that one instead.');
 if (!existingMoment && after.length > 0) throw new HttpError(400, 'valid_from must be after the list\'s latest version');
 if (before.length > 0 && validFrom.getTime() <= before[before.length - 1]) throw new HttpError(400, 'valid_from must be after the version before it');
 if (after.length > 0 && validFrom.getTime() >= after[0]) throw new HttpError(400, 'valid_from must be before the version after it');

 // The list as it stood before this version, and the products it has.
 const previous = new Map();
 for (const row of rows) {
  if (before.length > 0 && row.valid_from.getTime() <= before[before.length - 1]) previous.set(row.product_id, row);
 }
 const productSet = new Set(rows.map((r) => r.product_id));
 const isOnlyVersion = others.length === 0;
 if (!isOnlyVersion) {
  const given = new Set(prices.map((p) => p.productId));
  if (given.size !== productSet.size || [...given].some((id) => !productSet.has(id))) {
   throw new HttpError(400, 'A version has the same products as the rest of its list - adding or removing products means a new price list.');
  }
 }

 const own = existingMoment ? rows.filter((r) => r.valid_from.getTime() === existingMoment.getTime()) : [];
 let changed = 0;
 for (const price of prices) {
  const mine = own.find((r) => r.product_id === price.productId);
  const differs = changesPrice(previous.get(price.productId), price);
  if (differs) changed++;
  if (mine && differs) {
   await client.query(
    'UPDATE maleniti.price SET valid_from = $2, price_eur = $3, anchored = $4, special_sale = $5 WHERE price_id = $1',
    [mine.price_id, validFrom, price.amount, price.anchored, price.specialSale]
   );
  } else if (mine) {
   await client.query('DELETE FROM maleniti.price WHERE price_id = $1', [mine.price_id]);
  } else if (differs) {
   await client.query(
    `INSERT INTO maleniti.price (product_id, price_list_id, valid_from, price_eur, anchored, special_sale)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [price.productId, priceListId, validFrom, price.amount, price.anchored, price.specialSale]
   );
  }
 }
 // Products the only version no longer lists.
 for (const row of own.filter((r) => !prices.some((p) => p.productId === r.product_id))) {
  await client.query('DELETE FROM maleniti.price WHERE price_id = $1', [row.price_id]);
 }
 if (changed === 0) throw new HttpError(400, 'No price differs from the version before - nothing to save.');
}

// A new version of a list ("copy"): new prices for its products from
// valid_from on.
router.post('/price-lists/:id/versions', adminHandler(async (req, res) => {
 const body = req.body || {};
 await inTransaction(async (client) => {
  await lockPriceList(client, req.params.id);
  const validFrom = parseMoment('valid_from', body.valid_from);
  checkChangeMoment('valid_from', validFrom);
  const prices = parsePrices(body.prices);
  await checkProductsExist(client, prices);
  await writeVersion(client, Number(req.params.id), { existingMoment: null, validFrom, prices });
 });
 res.sendStatus(204);
}));

// Edits a version (by its current valid_from) until its publication
// deadline: its moment and prices. The only version of a list may also
// change which products it has.
router.put('/price-lists/:id/versions/:at', adminHandler(async (req, res) => {
 const body = req.body || {};
 await inTransaction(async (client) => {
  await lockPriceList(client, req.params.id);
  const existingMoment = parseMoment('version', req.params.at);
  const rows = await loadPriceRows(client, req.params.id);
  if (!rows.some((r) => r.valid_from.getTime() === existingMoment.getTime())) throw new HttpError(404, 'No such version');
  checkStillEditable(existingMoment, 'This version');
  const validFrom = parseMoment('valid_from', body.valid_from);
  checkChangeMoment('valid_from', validFrom, { existing: existingMoment });
  const prices = parsePrices(body.prices);
  await checkProductsExist(client, prices);
  await writeVersion(client, Number(req.params.id), { existingMoment, validFrom, prices });
 });
 res.sendStatus(204);
}));

// Withdraws a version until its publication deadline. The only version of
// a list takes the list with it (and its point-of-sale assignments, which
// must still be withdrawable too).
router.delete('/price-lists/:id/versions/:at', adminHandler(async (req, res) => {
 await inTransaction(async (client) => {
  await lockPriceList(client, req.params.id);
  const moment = parseMoment('version', req.params.at);
  const rows = await loadPriceRows(client, req.params.id);
  const own = rows.filter((r) => r.valid_from.getTime() === moment.getTime());
  if (own.length === 0) throw new HttpError(404, 'No such version');
  checkStillEditable(moment, 'This version');
  const isBase = rows.every((r) => r.valid_from.getTime() >= moment.getTime());
  if (isBase && own.length !== rows.length) {
   throw new HttpError(409, 'This is the list\'s first version - withdraw the later ones first.');
  }
  if (isBase) {
   const { rows: links } = await client.query('SELECT valid_from FROM maleniti.pos_price_list WHERE price_list_id = $1', [req.params.id]);
   for (const link of links) checkStillEditable(link.valid_from, 'A point of sale\'s switch to this list');
   await client.query('DELETE FROM maleniti.pos_price_list WHERE price_list_id = $1', [req.params.id]);
   await client.query('DELETE FROM maleniti.price WHERE price_list_id = $1', [req.params.id]);
   await client.query('DELETE FROM maleniti.price_list WHERE price_list_id = $1', [req.params.id]);
  } else {
   await client.query('DELETE FROM maleniti.price WHERE price_id = ANY($1)', [own.map((r) => r.price_id)]);
  }
 });
 res.sendStatus(204);
}));

// ---------------------------------------------------------------------------
// Which price list each point of sale uses from when (pos_price_list).
// ---------------------------------------------------------------------------

async function parseAssignment(client, body, existing) {
 const pointOfSaleId = Number(body.point_of_sale_id);
 const priceListId = Number(body.price_list_id);
 if (!Number.isInteger(pointOfSaleId)) throw new HttpError(400, 'point_of_sale_id is required');
 if (!Number.isInteger(priceListId)) throw new HttpError(400, 'price_list_id is required');
 const validFrom = parseMoment('valid_from', body.valid_from);
 checkChangeMoment('valid_from', validFrom, { existing });
 return { pointOfSaleId, priceListId, validFrom };
}

router.get('/pos-price-lists', adminHandler(async (req, res) => {
 const now = new Date();
 const { rows } = await db.query(
  `SELECT l.pos_price_list_id, l.point_of_sale_id, pos.code AS point_of_sale_code, l.price_list_id, l.valid_from
   FROM maleniti.pos_price_list l JOIN maleniti.point_of_sale pos USING (point_of_sale_id)
   ORDER BY pos.code, l.valid_from DESC`
 );
 res.json(rows.map((r) => ({ ...r, editable: isEditable(r.valid_from, now) })));
}));

router.post('/pos-price-lists', adminHandler(async (req, res) => {
 const created = await inTransaction(async (client) => {
  const a = await parseAssignment(client, req.body || {}, null);
  const { rows: [row] } = await client.query(
   'INSERT INTO maleniti.pos_price_list (point_of_sale_id, price_list_id, valid_from) VALUES ($1, $2, $3) RETURNING *',
   [a.pointOfSaleId, a.priceListId, a.validFrom]
  );
  return row;
 });
 res.status(201).json(created);
}));

router.put('/pos-price-lists/:id', adminHandler(async (req, res) => {
 const updated = await inTransaction(async (client) => {
  const { rows: [existing] } = await client.query('SELECT * FROM maleniti.pos_price_list WHERE pos_price_list_id = $1 FOR UPDATE', [req.params.id]);
  if (!existing) throw new HttpError(404, 'Not found');
  checkStillEditable(existing.valid_from, 'This switch of price list');
  const a = await parseAssignment(client, req.body || {}, existing.valid_from);
  const { rows: [row] } = await client.query(
   'UPDATE maleniti.pos_price_list SET point_of_sale_id = $2, price_list_id = $3, valid_from = $4 WHERE pos_price_list_id = $1 RETURNING *',
   [req.params.id, a.pointOfSaleId, a.priceListId, a.validFrom]
  );
  return row;
 });
 res.json(updated);
}));

router.delete('/pos-price-lists/:id', adminHandler(async (req, res) => {
 await inTransaction(async (client) => {
  const { rows: [existing] } = await client.query('SELECT * FROM maleniti.pos_price_list WHERE pos_price_list_id = $1 FOR UPDATE', [req.params.id]);
  if (!existing) throw new HttpError(404, 'Not found');
  checkStillEditable(existing.valid_from, 'This switch of price list');
  await client.query('DELETE FROM maleniti.pos_price_list WHERE pos_price_list_id = $1', [req.params.id]);
 });
 res.sendStatus(204);
}));

// ---------------------------------------------------------------------------
// Interface texts (migration 010): a brand client's named translation keys,
// each in every language, for the admin app's Translations tab. A text is
// set per language; deleting one makes the client fall back to English
// (whose own texts can only be changed, not deleted).
// ---------------------------------------------------------------------------

router.get('/translations', adminHandler(async (req, res) => {
 const brand = req.query.brand || 'atodo';
 const { rows: [brandRow] } = await db.query('SELECT brand_id FROM maleniti.brand WHERE code = $1', [brand]);
 if (!brandRow) throw new HttpError(404, `No brand ${brand}.`);
 const { rows: languages } = await db.query('SELECT language_id, name FROM maleniti.language ORDER BY language_id');
 const { rows: keys } = await db.query(
  'SELECT trid, bundle, name FROM maleniti.translation_key WHERE brand_id = $1 ORDER BY bundle, name',
  [brandRow.brand_id]
 );
 const { rows: texts } = await db.query(
  'SELECT t.trid, t.language_id, t.text FROM maleniti.translation t JOIN maleniti.translation_key k USING (trid) WHERE k.brand_id = $1',
  [brandRow.brand_id]
 );
 const byTrid = new Map(keys.map((k) => [k.trid, { ...k, texts: {} }]));
 for (const t of texts) byTrid.get(t.trid).texts[t.language_id] = t.text;
 res.json({ languages, keys: [...byTrid.values()] });
}));

async function namedKey(trid) {
 const { rows: [key] } = await db.query('SELECT trid FROM maleniti.translation_key WHERE trid = $1 AND name IS NOT NULL', [trid]);
 if (!key) throw new HttpError(404, 'No such interface text.');
}

router.put('/translations/:trid/:language', adminHandler(async (req, res) => {
 const trid = Number(req.params.trid);
 if (!Number.isInteger(trid)) throw new HttpError(400, 'trid must be a whole number');
 const text = req.body && req.body.text;
 if (typeof text !== 'string') throw new HttpError(400, 'text must be a string');
 await namedKey(trid);
 const { rows: [row] } = await db.query(
  `INSERT INTO maleniti.translation (trid, language_id, text) VALUES ($1, $2, $3)
   ON CONFLICT (trid, language_id) DO UPDATE SET text = EXCLUDED.text
   RETURNING trid, language_id, text`,
  [trid, req.params.language, text]
 );
 res.json(row);
}));

// One language's texts from the admin app's "Import translations" (a file
// its "Export translations" made): { language: { language_id, name },
// texts: { name: text } }. Every text in it is set; texts it doesn't have
// are left as they are; names the brand has no text for are skipped and
// reported (texts are added with the client code that uses them). A
// language that doesn't exist yet is created, starting with no texts. (Up
// to 2 MB -- see server.js.)
const LANGUAGE_NAME_MAX = 100;

router.post('/translations/import', adminHandler(async (req, res) => {
 const body = req.body || {};
 const brand = typeof body.brand === 'string' ? body.brand : 'atodo';
 const language = body.language || {};
 const languageId = typeof language.language_id === 'string' ? language.language_id.trim() : '';
 const languageName = typeof language.name === 'string' ? language.name.trim() : '';
 const texts = body.texts;
 if (!LANGUAGE_RE.test(languageId)) throw new HttpError(400, 'language.language_id must be a two-letter code');
 if (!texts || typeof texts !== 'object' || Array.isArray(texts)) throw new HttpError(400, 'texts must be an object of key -> text');
 const entries = Object.entries(texts);
 const notText = entries.filter(([, text]) => typeof text !== 'string').map(([name]) => name);
 if (notText.length) throw new HttpError(400, `Not a text: ${notText.slice(0, 5).join(', ')}${notText.length > 5 ? '...' : ''}`);

 const result = await inTransaction(async (client) => {
  const { rows: [brandRow] } = await client.query('SELECT brand_id FROM maleniti.brand WHERE code = $1', [brand]);
  if (!brandRow) throw new HttpError(404, `No brand ${brand}.`);
  const { rows: [existing] } = await client.query('SELECT 1 FROM maleniti.language WHERE language_id = $1', [languageId]);
  if (!existing) {
   if (!languageName || languageName.length > LANGUAGE_NAME_MAX) throw new HttpError(400, `${languageId} is a new language: language.name is required`);
   await client.query('INSERT INTO maleniti.language (language_id, name) VALUES ($1, $2)', [languageId, languageName]);
  }
  const { rows: keys } = await client.query(
   `SELECT k.trid, k.name, t.text FROM maleniti.translation_key k
    LEFT JOIN maleniti.translation t ON t.trid = k.trid AND t.language_id = $2
    WHERE k.brand_id = $1 AND k.name IS NOT NULL`,
   [brandRow.brand_id, languageId]
  );
  const byName = new Map(keys.map((k) => [k.name, k]));
  const unknown = [];
  let updated = 0;
  let unchanged = 0;
  for (const [name, text] of entries) {
   const key = byName.get(name);
   if (!key) {
    unknown.push(name);
    continue;
   }
   if (key.text === text) {
    unchanged++;
    continue;
   }
   await client.query(
    `INSERT INTO maleniti.translation (trid, language_id, text) VALUES ($1, $2, $3)
     ON CONFLICT (trid, language_id) DO UPDATE SET text = EXCLUDED.text`,
    [key.trid, languageId, text]
   );
   updated++;
  }
  return { language_id: languageId, created_language: !existing, updated, unchanged, unknown };
 });
 res.json(result);
}));

router.delete('/translations/:trid/:language', adminHandler(async (req, res) => {
 const trid = Number(req.params.trid);
 if (!Number.isInteger(trid)) throw new HttpError(400, 'trid must be a whole number');
 if (req.params.language === 'en') throw new HttpError(409, 'English is the fallback for every other language: change it instead.');
 await namedKey(trid);
 await db.query('DELETE FROM maleniti.translation WHERE trid = $1 AND language_id = $2', [trid, req.params.language]);
 res.status(204).send();
}));

module.exports = router;
