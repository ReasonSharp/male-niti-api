const db = require('../../db');

// A brand's prices at a point of sale at some moment, from the maleniti
// schema (migrations 004-005) -- shared by the published CSV and the
// current-prices JSON (routes/priceLists.js) and by checkout
// (routes/atodo/subscriptions.js), so all three always agree.
//
// The point of sale uses its latest pos_price_list up to `at`; each product
// of the brand with a price in that list by then is listed with its latest
// price up to `at`, and its anchor price: the latest anchored price up to
// `at` among the lists the point of sale has used. Moments compare to the
// millisecond (as precise as the API reports them; the database keeps
// microseconds). Names are in `lang`, falling back to Croatian.
//
// Returns { priceListId, listSince, products: [...] } -- priceListId null
// when the point of sale used no list yet.
async function brandPricesAt({ brandId, pointOfSaleId, lang = 'hr', at = new Date() }, client = db) {
 const { rows: [link] } = await client.query(
  `SELECT price_list_id, valid_from FROM maleniti.pos_price_list
   WHERE point_of_sale_id = $1 AND date_trunc('milliseconds', valid_from) <= $2
   ORDER BY valid_from DESC LIMIT 1`,
  [pointOfSaleId, at]
 );
 if (!link) return { priceListId: null, listSince: null, products: [] };
 const { rows } = await client.query(
  `SELECT p.product_id, p.code, COALESCE(name.text, name_hr.text) AS name,
          p.featured_ord, p.highlight, p.billing_interval, p.stripe_product_id,
          cur.price_eur, cur.special_sale, cur.valid_from,
          anchor.price_eur AS anchor_eur
   FROM maleniti.product p
   LEFT JOIN maleniti.translation name ON name.trid = p.name_trid AND name.language_id = $3
   LEFT JOIN maleniti.translation name_hr ON name_hr.trid = p.name_trid AND name_hr.language_id = 'hr'
   JOIN LATERAL (
     SELECT pr.price_eur, pr.special_sale, pr.valid_from
     FROM maleniti.price pr
     WHERE pr.product_id = p.product_id AND pr.price_list_id = $4
       AND date_trunc('milliseconds', pr.valid_from) <= $5
     ORDER BY pr.valid_from DESC
     LIMIT 1
   ) cur ON TRUE
   LEFT JOIN LATERAL (
     SELECT pr.price_eur
     FROM maleniti.price pr
     WHERE pr.product_id = p.product_id AND pr.anchored
       AND date_trunc('milliseconds', pr.valid_from) <= $5
       AND pr.price_list_id IN (
         SELECT price_list_id FROM maleniti.pos_price_list
         WHERE point_of_sale_id = $2 AND date_trunc('milliseconds', valid_from) <= $5)
     ORDER BY pr.valid_from DESC
     LIMIT 1
   ) anchor ON TRUE
   WHERE p.brand_id = $1
   ORDER BY p.product_id`,
  [brandId, pointOfSaleId, lang, link.price_list_id, at]
 );
 return {
  priceListId: link.price_list_id,
  listSince: link.valid_from,
  products: rows.map((row) => ({
   ...row,
   price_eur: row.price_eur === null ? null : Number(row.price_eur),
   anchor_eur: row.anchor_eur === null ? null : Number(row.anchor_eur),
  })),
 };
}

async function brandIdFor(code, client = db) {
 const { rows: [row] } = await client.query('SELECT brand_id FROM maleniti.brand WHERE code = $1', [code]);
 return row ? row.brand_id : null;
}

async function pointOfSaleIdFor(code, client = db) {
 const { rows: [row] } = await client.query('SELECT point_of_sale_id FROM maleniti.point_of_sale WHERE code = $1', [code]);
 return row ? row.point_of_sale_id : null;
}

module.exports = { brandPricesAt, brandIdFor, pointOfSaleIdFor };
