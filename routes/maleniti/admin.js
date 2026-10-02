const express = require('express');
const db = require('../../db');
const { adminResource, adminHandler, HttpError, inTransaction } = require('../../lib/maleniti/adminResource');
const { publicationDeadline, isEditable, earliestNewChange } = require('../../lib/maleniti/schedule');

// /maleniti/v1/admin -- the admin app's editing of the maleniti schema
// (migration 004: the business model behind the published price lists, see
// routes/priceLists.js). Super admin only (mounted behind requireSuperAdmin
// in server.js). Languages, points of sale, devices, brands and products
// are plain CRUD (lib/maleniti/adminResource.js, texts as { hr, en }
// objects); price lists, their versions and which point of sale uses which
// list are written by hand below.

const router = express.Router();

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

router.use('/products', adminResource({
 table: 'maleniti.product',
 id: 'product_id',
 columns: [{ name: 'brand_id', required: true, type: 'int' }, { name: 'code', required: true }],
 texts: { name: 'name_trid' },
 select: `SELECT maleniti.product.product_id, maleniti.product.brand_id, maleniti.product.code, maleniti.product.name_trid,
                 brand.code AS brand_code
          FROM maleniti.product JOIN maleniti.brand brand USING (brand_id)`,
 orderBy: 'brand.code, maleniti.product.product_id',
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

module.exports = router;
