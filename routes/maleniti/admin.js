const express = require('express');
const db = require('../../db');
const { adminResource, adminHandler, HttpError, inTransaction } = require('../../lib/maleniti/adminResource');

// /maleniti/v1/admin -- the admin app's editing of the maleniti schema
// (migration 004: the business model behind the published price lists, see
// routes/priceLists.js). Super admin only (mounted behind requireSuperAdmin
// in server.js). Languages, points of sale, devices, brands and products
// are plain CRUD (lib/maleniti/adminResource.js, texts as { hr, en }
// objects); price lists are written together with their prices.

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
// Price lists, each with its prices. A list is published at published_at:
// from then on it's part of the published history (every version of the
// price list must stay as it was, 30 days at least -- see
// routes/priceLists.js), so it can't be changed or deleted any more; a
// correction is a new list. Until then (a list scheduled for later) it can
// be edited or deleted freely. Neither a list nor its prices may be dated in
// the past: that would add versions that were never actually published.
// ---------------------------------------------------------------------------

// A minute's leeway for "now", so a list published "now" from the admin
// app isn't refused for the second or two the request took.
const PAST_TOLERANCE_MS = 60 * 1000;

function parseMoment(field, value) {
 const date = new Date(value);
 if (value === undefined || value === null || value === '' || Number.isNaN(date.getTime())) {
  throw new HttpError(400, `${field} must be a date and time (ISO 8601)`);
 }
 return date;
}

function notInPast(field, date) {
 if (date.getTime() < Date.now() - PAST_TOLERANCE_MS) throw new HttpError(400, `${field} can't be in the past`);
}

async function validatePriceList(client, body) {
 const pointOfSaleId = Number(body.point_of_sale_id);
 if (!Number.isInteger(pointOfSaleId)) throw new HttpError(400, 'point_of_sale_id is required');
 const publishedAt = parseMoment('published_at', body.published_at);
 notInPast('published_at', publishedAt);
 if (!Array.isArray(body.prices) || body.prices.length === 0) throw new HttpError(400, 'prices must list at least one price');

 const seen = new Set();
 const prices = body.prices.map((price, i) => {
  const at = `prices[${i}]`;
  const productId = Number(price.product_id);
  if (!Number.isInteger(productId)) throw new HttpError(400, `${at}.product_id is required`);
  const validFrom = price.valid_from === undefined || price.valid_from === null || price.valid_from === ''
   ? publishedAt : parseMoment(`${at}.valid_from`, price.valid_from);
  if (validFrom < publishedAt) throw new HttpError(400, `${at}.valid_from can't be before the list's published_at`);
  const amount = Number(price.price_eur);
  if (price.price_eur === '' || price.price_eur === null || !Number.isFinite(amount) || amount < 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
   throw new HttpError(400, `${at}.price_eur must be an amount in EUR, at most two decimals`);
  }
  const key = `${productId}@${validFrom.toISOString()}`;
  if (seen.has(key)) throw new HttpError(400, `${at}: the same product twice at the same moment`);
  seen.add(key);
  return { productId, validFrom, amount: Math.round(amount * 100) / 100, anchored: !!price.anchored, specialSale: !!price.special_sale };
 });

 const { rows: [{ known }] } = await client.query(
  'SELECT count(*)::int AS known FROM maleniti.product WHERE product_id = ANY($1)',
  [[...new Set(prices.map((p) => p.productId))]]
 );
 if (known !== new Set(prices.map((p) => p.productId)).size) throw new HttpError(400, 'prices name a product that does not exist');
 return { pointOfSaleId, publishedAt, prices };
}

async function writePrices(client, priceListId, prices) {
 await client.query('DELETE FROM maleniti.price WHERE price_list_id = $1', [priceListId]);
 for (const p of prices) {
  await client.query(
   `INSERT INTO maleniti.price (product_id, price_list_id, valid_from, price_eur, anchored, special_sale)
    VALUES ($1, $2, $3, $4, $5, $6)`,
   [p.productId, priceListId, p.validFrom, p.amount, p.anchored, p.specialSale]
  );
 }
}

async function loadPriceLists(client, where = '', params = []) {
 const { rows } = await client.query(
  `SELECT pl.price_list_id, pl.point_of_sale_id, pos.code AS point_of_sale_code, pl.published_at,
          pl.published_at <= now() AS published,
          COALESCE(json_agg(json_build_object(
            'price_id', pr.price_id, 'product_id', pr.product_id, 'product_code', product.code,
            'valid_from', pr.valid_from, 'price_eur', pr.price_eur,
            'anchored', pr.anchored, 'special_sale', pr.special_sale
          ) ORDER BY pr.valid_from, product.product_id) FILTER (WHERE pr.price_id IS NOT NULL), '[]') AS prices
   FROM maleniti.price_list pl
   JOIN maleniti.point_of_sale pos USING (point_of_sale_id)
   LEFT JOIN maleniti.price pr USING (price_list_id)
   LEFT JOIN maleniti.product product ON product.product_id = pr.product_id
   ${where}
   GROUP BY pl.price_list_id, pos.code
   ORDER BY pl.published_at DESC, pl.price_list_id DESC`,
  params
 );
 return rows;
}

// A list that's still editable (scheduled, not yet published), locked for
// the rest of the transaction; 404/409 otherwise.
async function lockScheduledList(client, id) {
 const { rows: [list] } = await client.query(
  'SELECT price_list_id, published_at <= now() AS published FROM maleniti.price_list WHERE price_list_id = $1 FOR UPDATE',
  [id]
 );
 if (!list) throw new HttpError(404, 'Not found');
 if (list.published) throw new HttpError(409, 'This price list is already published and can no longer be changed - publish a new one instead.');
}

router.get('/price-lists', adminHandler(async (req, res) => {
 res.json(await loadPriceLists(db));
}));

router.get('/price-lists/:id', adminHandler(async (req, res) => {
 const [list] = await loadPriceLists(db, 'WHERE pl.price_list_id = $1', [req.params.id]);
 if (!list) throw new HttpError(404, 'Not found');
 res.json(list);
}));

router.post('/price-lists', adminHandler(async (req, res) => {
 const created = await inTransaction(async (client) => {
  const { pointOfSaleId, publishedAt, prices } = await validatePriceList(client, req.body || {});
  const { rows: [list] } = await client.query(
   'INSERT INTO maleniti.price_list (point_of_sale_id, published_at) VALUES ($1, $2) RETURNING price_list_id',
   [pointOfSaleId, publishedAt]
  );
  await writePrices(client, list.price_list_id, prices);
  return (await loadPriceLists(client, 'WHERE pl.price_list_id = $1', [list.price_list_id]))[0];
 });
 res.status(201).json(created);
}));

router.put('/price-lists/:id', adminHandler(async (req, res) => {
 const updated = await inTransaction(async (client) => {
  await lockScheduledList(client, req.params.id);
  const { pointOfSaleId, publishedAt, prices } = await validatePriceList(client, req.body || {});
  await client.query(
   'UPDATE maleniti.price_list SET point_of_sale_id = $2, published_at = $3 WHERE price_list_id = $1',
   [req.params.id, pointOfSaleId, publishedAt]
  );
  await writePrices(client, req.params.id, prices);
  return (await loadPriceLists(client, 'WHERE pl.price_list_id = $1', [req.params.id]))[0];
 });
 res.json(updated);
}));

router.delete('/price-lists/:id', adminHandler(async (req, res) => {
 await inTransaction(async (client) => {
  await lockScheduledList(client, req.params.id);
  await client.query('DELETE FROM maleniti.price_list WHERE price_list_id = $1', [req.params.id]);
 });
 res.sendStatus(204);
}));

module.exports = router;
