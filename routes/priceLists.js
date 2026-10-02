const express = require('express');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { brandPricesAt } = require('../lib/maleniti/prices');

// Published price lists (maleniti schema, migration 004), mounted at
// /maleniti/v1/price-lists. Croatian law (Odluka o objavi cjenika, NN
// 101/2026) wants a consumer-facing website to publish its price list as a
// CSV/XML file a program can fetch, updated by 08:00 on the day a price
// changes, every version kept available for 30 days after it's replaced --
// and every price shown with its anchor price (sidrena cijena). Rather than
// files kept by hand, every version is rebuilt on request from the price
// history: GET /:brand?at= is the list as it stood at that moment, and
// GET /:brand/versions says which moments are worth asking for. A point of
// sale uses one price list at a time (maleniti.pos_price_list); a price
// list keeps every price it ever held (maleniti.price, by valid_from).
//
// Public and read-only, so CORS is wide open (the brand's own website, e.g.
// atodo.maleniti.com, fetches the versions from the browser).

const router = express.Router();

router.use((req, res, next) => {
 res.setHeader('Access-Control-Allow-Origin', '*');
 res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
 res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
 if (req.method === 'OPTIONS') return res.sendStatus(204);
 next();
});

const VERSION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const CSV_HEADERS = {
 hr: ['Naziv usluge', 'Maloprodajna cijena (EUR)', 'Posebni oblik prodaje', 'Sidrena cijena (EUR)'],
 en: ['Service name', 'Retail price (EUR)', 'Special sale', 'Anchor price (EUR)'],
};
const YES_NO = { hr: ['DA', 'NE'], en: ['yes', 'no'] };

function badRequest(res, message) {
 return res.status(400).json({ code: 'VALIDATION_ERROR', message });
}

// The brand, point of sale and language a request names -- the point of
// sale defaults to FISCAL_PREMISES, the one this deployment fiscalizes
// A-To-Do's payments under. Answers the error itself (and returns null)
// when one is missing or unknown.
async function resolveScope(req, res) {
 const posCode = req.query.pointOfSale || process.env.FISCAL_PREMISES;
 if (!posCode) {
  badRequest(res, 'pointOfSale is required (no FISCAL_PREMISES configured)');
  return null;
 }
 const lang = req.query.lang || 'hr';
 const { rows } = await db.query(
  `SELECT
     (SELECT brand_id FROM maleniti.brand WHERE code = $1) AS brand_id,
     (SELECT point_of_sale_id FROM maleniti.point_of_sale WHERE code = $2) AS point_of_sale_id,
     EXISTS (SELECT 1 FROM maleniti.language WHERE language_id = $3) AS language_known`,
  [req.params.brand, posCode, lang]
 );
 const { brand_id: brandId, point_of_sale_id: pointOfSaleId, language_known: languageKnown } = rows[0];
 if (!languageKnown) {
  badRequest(res, `Unknown language: ${lang}`);
  return null;
 }
 if (brandId === null || pointOfSaleId === null) {
  res.status(404).json({ code: 'NOT_FOUND', message: brandId === null ? 'No such brand.' : 'No such point of sale.' });
  return null;
 }
 return { brandId, pointOfSaleId, posCode, lang };
}

function parseAt(value) {
 if (value === undefined) return new Date();
 const at = new Date(value);
 return Number.isNaN(at.getTime()) ? null : at;
}

// Plain RFC 4180 CSV: comma-separated, a field quoted only when it holds a
// comma, quote or line break. The decision (NN 101/2026) prescribes no
// separator or number format -- just CSV or XML "suitable for automatic
// processing" -- so it's the one every program reads the same way: a
// semicolon/decimal-comma variant gets split on both by spreadsheets
// set to accept either.
function csvField(value) {
 const text = String(value ?? '');
 return /[,"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// "2.00" -- a decimal point, always two decimals.
function csvAmount(amount) {
 return amount === null ? '' : amount.toFixed(2);
}

// Zagreb-local "2026-09-10T08-00", for the file name (no colons, which
// some systems refuse in one).
function fileTimestamp(date) {
 const parts = Object.fromEntries(
  new Intl.DateTimeFormat('en-CA', {
   timeZone: 'Europe/Zagreb', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value])
 );
 return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}-${parts.minute}`;
}

function fileNamePart(text) {
 return String(text).replace(/[_\\/:*?"<>|\r\n]+/g, ' ').trim();
}

// The price list of a brand at a point of sale as it stood at `at` (default
// now; compared to the millisecond, as precise as the times /versions
// reports -- the database keeps microseconds), as CSV: the list that point
// of sale used then (its latest pos_price_list up to `at`), every product
// of the brand with a price in it by then -- its latest price up to `at` --
// and the anchor price: the latest anchored price up to `at` among the
// lists that point of sale has used. The file name carries what the
// decision lists -- the point of sale's type, address and label, a storage
// number (the price list's id) and the date and time this version took
// effect.
router.get('/:brand', asyncHandler(async (req, res) => {
 const scope = await resolveScope(req, res);
 if (!scope) return;
 const at = parseAt(req.query.at);
 if (!at) return badRequest(res, 'at must be a date and time (ISO 8601)');

 const { priceListId, listSince, products: rows } = await brandPricesAt({
  brandId: scope.brandId, pointOfSaleId: scope.pointOfSaleId, lang: scope.lang, at,
 });
 const { rows: [pos] } = await db.query(
  `SELECT pos.address, COALESCE(t.text, t_hr.text) AS type
   FROM maleniti.point_of_sale pos
   LEFT JOIN maleniti.translation t ON t.trid = pos.type_trid AND t.language_id = $2
   LEFT JOIN maleniti.translation t_hr ON t_hr.trid = pos.type_trid AND t_hr.language_id = 'hr'
   WHERE pos.point_of_sale_id = $1`,
  [scope.pointOfSaleId, scope.lang]
 );

 const header = CSV_HEADERS[scope.lang] || CSV_HEADERS.hr;
 const [yes, no] = YES_NO[scope.lang] || YES_NO.hr;
 const lines = [header.map(csvField).join(',')];
 for (const row of rows) {
  lines.push([row.name, csvAmount(row.price_eur), row.special_sale ? yes : no, csvAmount(row.anchor_eur)].map(csvField).join(','));
 }

 // This version began when the point of sale switched to the list or the
 // last of its current prices took effect, whichever came later.
 const takesEffect = rows.reduce((latest, row) => (row.valid_from > latest ? row.valid_from : latest), listSince || at);
 const storageNumber = priceListId || 0;
 const fileName = [pos.type, pos.address, scope.posCode, storageNumber, fileTimestamp(takesEffect)].map(fileNamePart).join('_') + '.csv';

 res.setHeader('Content-Type', 'text/csv; charset=utf-8');
 res.setHeader('Content-Disposition',
  `attachment; filename="${fileName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
 res.setHeader('Cache-Control', 'no-cache');
 // With a BOM, so spreadsheet programs read it as UTF-8 too.
 res.send(`\ufeff${lines.join('\r\n')}\r\n`);
}));

// A brand's products and their prices right now, for its website (A-To-Do's
// landing, checkout and in-app prices -- see its anchor-prices.js): every
// product with a price at the point of sale, with its anchor price and how
// the landing page shows it (featured_ord: its place, null = not shown;
// highlight), and billing_interval for subscriptions. Names in `lang`.
router.get('/:brand/current', asyncHandler(async (req, res) => {
 const scope = await resolveScope(req, res);
 if (!scope) return;
 const { products } = await brandPricesAt({ brandId: scope.brandId, pointOfSaleId: scope.pointOfSaleId, lang: scope.lang });
 res.setHeader('Cache-Control', 'no-cache');
 res.json({
  brand: req.params.brand,
  pointOfSale: scope.posCode,
  products: products.map((p) => ({
   code: p.code,
   name: p.name,
   price_eur: p.price_eur,
   anchor_eur: p.anchor_eur,
   special_sale: p.special_sale,
   featured_ord: p.featured_ord,
   highlight: p.highlight,
   billing_interval: p.billing_interval,
  })),
 });
}));

// The versions of a brand's price list at a point of sale still to be
// offered: every moment its price list changed -- it switched to another
// list (pos_price_list), or a price of the brand changed in the list in use
// -- starts a version, valid until the next one. A version stays due until
// 30 days after it was replaced, the current one always. Grouped by price
// list, oldest first; moments still in the future aren't versions yet.
router.get('/:brand/versions', asyncHandler(async (req, res) => {
 const scope = await resolveScope(req, res);
 if (!scope) return;
 const now = new Date();

 const { rows: links } = await db.query(
  `SELECT price_list_id, date_trunc('milliseconds', valid_from) AS valid_from
   FROM maleniti.pos_price_list WHERE point_of_sale_id = $1 AND valid_from <= $2
   ORDER BY valid_from`,
  [scope.pointOfSaleId, now]
 );
 const { rows: changes } = await db.query(
  `SELECT DISTINCT pr.price_list_id, date_trunc('milliseconds', pr.valid_from) AS valid_from
   FROM maleniti.price pr JOIN maleniti.product p USING (product_id)
   WHERE p.brand_id = $1 AND pr.valid_from <= $2 AND pr.price_list_id = ANY($3)`,
  [scope.brandId, now, [...new Set(links.map((l) => l.price_list_id))]]
 );

 // Every version: a link's start, then each price change within its span.
 const versions = [];
 links.forEach((link, i) => {
  const until = links[i + 1] ? links[i + 1].valid_from : null;
  versions.push({ link: i, from: link.valid_from });
  changes
   .filter((c) => c.price_list_id === link.price_list_id && c.valid_from > link.valid_from && (!until || c.valid_from < until))
   .sort((a, b) => a.valid_from - b.valid_from)
   .forEach((c) => versions.push({ link: i, from: c.valid_from }));
 });
 const windowStart = now.getTime() - VERSION_WINDOW_MS;
 const due = versions.filter((v, i) => !versions[i + 1] || versions[i + 1].from.getTime() > windowStart);

 res.setHeader('Cache-Control', 'no-cache');
 res.json({
  brand: req.params.brand,
  pointOfSale: scope.posCode,
  priceLists: links
   .map((link, i) => ({
    id: link.price_list_id,
    usedFrom: link.valid_from.toISOString(),
    priceChanges: due.filter((v) => v.link === i).map((v) => v.from.toISOString()),
   }))
   .filter((list) => list.priceChanges.length > 0),
 });
}));

module.exports = router;
