const express = require('express');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');

// Published price lists (maleniti schema, migration 004), mounted at
// /maleniti/v1/price-lists. Croatian law (Odluka o objavi cjenika, NN
// 101/2026) wants a consumer-facing website to publish its price list as a
// CSV/XML file a program can fetch, updated by 08:00 on the day a price
// changes, every version kept available for 30 days after it's replaced --
// and every price shown with its anchor price (sidrena cijena). Rather than
// files kept by hand, every version is rebuilt on request from the price
// history: GET /:brand?at= is the list as it stood at that moment, and
// GET /:brand/versions says which moments are worth asking for.
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

function csvField(value) {
 const text = String(value ?? '');
 return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// "2,00" -- a decimal comma, as Croatian prices are written; the fields are
// separated by semicolons for the same reason.
function csvAmount(amount) {
 return amount === null ? '' : String(amount).replace('.', ',');
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
// reports -- the database keeps microseconds), as CSV: every product with a price there then, its latest price (by
// valid_from, among price lists already published at `at`) and its latest
// anchored one. The file name carries what the decision lists -- the point
// of sale's type, address and label, a storage number (the newest price
// list this version draws on) and the date and time the version took
// effect.
router.get('/:brand', asyncHandler(async (req, res) => {
 const scope = await resolveScope(req, res);
 if (!scope) return;
 const at = parseAt(req.query.at);
 if (!at) return badRequest(res, 'at must be a date and time (ISO 8601)');

 const { rows } = await db.query(
  `SELECT COALESCE(name.text, name_hr.text) AS name,
          cur.price_eur, cur.special_sale, cur.valid_from, cur.price_list_id,
          anchor.price_eur AS anchor_eur
   FROM maleniti.product p
   LEFT JOIN maleniti.translation name ON name.trid = p.name_trid AND name.language_id = $3
   LEFT JOIN maleniti.translation name_hr ON name_hr.trid = p.name_trid AND name_hr.language_id = 'hr'
   JOIN LATERAL (
     SELECT pr.price_eur, pr.special_sale, pr.valid_from, pr.price_list_id
     FROM maleniti.price pr JOIN maleniti.price_list pl USING (price_list_id)
     WHERE pr.product_id = p.product_id AND pl.point_of_sale_id = $2
       AND date_trunc('milliseconds', pr.valid_from) <= $4 AND date_trunc('milliseconds', pl.published_at) <= $4
     ORDER BY pr.valid_from DESC, pl.published_at DESC
     LIMIT 1
   ) cur ON TRUE
   LEFT JOIN LATERAL (
     SELECT pr.price_eur
     FROM maleniti.price pr JOIN maleniti.price_list pl USING (price_list_id)
     WHERE pr.product_id = p.product_id AND pl.point_of_sale_id = $2 AND pr.anchored
       AND date_trunc('milliseconds', pr.valid_from) <= $4 AND date_trunc('milliseconds', pl.published_at) <= $4
     ORDER BY pr.valid_from DESC, pl.published_at DESC
     LIMIT 1
   ) anchor ON TRUE
   WHERE p.brand_id = $1
   ORDER BY p.product_id`,
  [scope.brandId, scope.pointOfSaleId, scope.lang, at]
 );
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
 const lines = [header.map(csvField).join(';')];
 for (const row of rows) {
  lines.push([row.name, csvAmount(row.price_eur), row.special_sale ? yes : no, csvAmount(row.anchor_eur)].map(csvField).join(';'));
 }

 const takesEffect = rows.reduce((latest, row) => (row.valid_from > latest ? row.valid_from : latest), rows.length ? rows[0].valid_from : at);
 const storageNumber = rows.reduce((max, row) => Math.max(max, row.price_list_id), 0);
 const fileName = [pos.type, pos.address, scope.posCode, storageNumber, fileTimestamp(takesEffect)].map(fileNamePart).join('_') + '.csv';

 res.setHeader('Content-Type', 'text/csv; charset=utf-8');
 res.setHeader('Content-Disposition',
  `attachment; filename="${fileName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
 res.setHeader('Cache-Control', 'no-cache');
 // With a BOM, so spreadsheet programs read it as UTF-8 too.
 res.send(`﻿${lines.join('\r\n')}\r\n`);
}));

// The price lists worth offering for download: every one published in the
// last 30 days (each version stays available that long after it's
// replaced), plus the newest one before them -- the list in effect when
// the window opened -- or, with nothing that recent, just the newest one.
// Each lists the moments its prices for this brand took effect, oldest
// first (not ones still in the future). A list without any of the brand's
// prices doesn't count.
router.get('/:brand/versions', asyncHandler(async (req, res) => {
 const scope = await resolveScope(req, res);
 if (!scope) return;
 const now = new Date();

 const { rows } = await db.query(
  `SELECT pl.price_list_id, pl.published_at,
          ARRAY_AGG(DISTINCT date_trunc('milliseconds', pr.valid_from) ORDER BY date_trunc('milliseconds', pr.valid_from))
            FILTER (WHERE pr.valid_from <= $3) AS changes
   FROM maleniti.price_list pl
   JOIN maleniti.price pr USING (price_list_id)
   JOIN maleniti.product p USING (product_id)
   WHERE pl.point_of_sale_id = $2 AND p.brand_id = $1 AND pl.published_at <= $3
   GROUP BY pl.price_list_id, pl.published_at
   ORDER BY pl.published_at`,
  [scope.brandId, scope.pointOfSaleId, now]
 );

 const windowStart = now.getTime() - VERSION_WINDOW_MS;
 const firstRecent = rows.findIndex((row) => row.published_at.getTime() >= windowStart);
 const selected = firstRecent === -1 ? rows.slice(-1) : rows.slice(Math.max(0, firstRecent - 1));

 res.setHeader('Cache-Control', 'no-cache');
 res.json({
  brand: req.params.brand,
  pointOfSale: scope.posCode,
  priceLists: selected.map((row) => ({
   id: row.price_list_id,
   publishedAt: row.published_at.toISOString(),
   priceChanges: (row.changes || []).map((date) => date.toISOString()),
  })),
 });
}));

module.exports = router;
