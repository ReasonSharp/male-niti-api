-- Version 004: the business model behind published price lists, in its own
-- `maleniti` schema -- points of sale, their fiscal devices, brands and
-- their products, and every price list ever published with its prices.
-- Croatian law (Odluka o objavi cjenika, NN 101/2026) wants each consumer-
-- facing website to publish its price list as a machine-readable file, each
-- version kept available for 30 days after it's replaced, every price
-- carrying its anchor price ("sidrena cijena", Odluka o isticanju dodatne
-- cijene, same NN) -- see routes/priceLists.js, which builds the files from
-- these tables. Leaves the CMS's own services/pricing_plans alone: those
-- predate anchor prices and back the main site as they are.
--
-- Multilingual text isn't kept as name_hr/name_en columns here, but as a
-- translation id (trid) per text, pointing at maleniti.translation's one
-- row per language. A trid is a row of maleniti.translation_key first, so
-- every *_trid column can be a real foreign key (a key of translation alone
-- would be (trid, language_id), which a single column can't reference).

CREATE SCHEMA maleniti;

CREATE TABLE maleniti.language (
    language_id TEXT PRIMARY KEY CHECK (language_id ~ '^[a-z]{2}$'),
    -- The language's own name for itself ("hrvatski", "English").
    name TEXT NOT NULL
);

CREATE TABLE maleniti.translation_key (
    trid SERIAL PRIMARY KEY
);

CREATE TABLE maleniti.translation (
    trid INT NOT NULL REFERENCES maleniti.translation_key ON DELETE CASCADE,
    language_id TEXT NOT NULL REFERENCES maleniti.language,
    text TEXT NOT NULL,
    PRIMARY KEY (trid, language_id)
);

-- A business premises (poslovni prostor) as registered for fiscalization:
-- code is its label (oznaka poslovnog prostora, e.g. P1, WEB1 -- also what
-- FISCAL_PREMISES names), type its kind (oblik prodajnog objekta), address
-- the registered address. Both are named in a price list file's name.
CREATE TABLE maleniti.point_of_sale (
    point_of_sale_id SERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    type_trid INT NOT NULL REFERENCES maleniti.translation_key,
    address TEXT NOT NULL
);

-- A fiscal device (naplatni uređaj) of a point of sale; its number goes on
-- every receipt issued through it.
CREATE TABLE maleniti.device (
    device_id SERIAL PRIMARY KEY,
    point_of_sale_id INT NOT NULL REFERENCES maleniti.point_of_sale,
    device_number INT NOT NULL CHECK (device_number > 0),
    UNIQUE (point_of_sale_id, device_number)
);

-- A group of products (goods or services) sold under one name, e.g. A-To-Do.
CREATE TABLE maleniti.brand (
    brand_id SERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL CHECK (code ~ '^[a-z0-9-]+$'),
    name_trid INT NOT NULL REFERENCES maleniti.translation_key
);

CREATE TABLE maleniti.product (
    product_id SERIAL PRIMARY KEY,
    brand_id INT NOT NULL REFERENCES maleniti.brand,
    code TEXT UNIQUE NOT NULL CHECK (code ~ '^[a-z0-9-]+$'),
    name_trid INT NOT NULL REFERENCES maleniti.translation_key
);

-- One published version of a point of sale's price list (prices can differ
-- between points of sale). Its prices may take effect at or after
-- published_at, each at its own valid_from.
CREATE TABLE maleniti.price_list (
    price_list_id SERIAL PRIMARY KEY,
    point_of_sale_id INT NOT NULL REFERENCES maleniti.point_of_sale,
    published_at TIMESTAMPTZ NOT NULL,
    UNIQUE (point_of_sale_id, published_at)
);

-- A product's price from valid_from on, as listed by one price list. The
-- price in effect at a point of sale at any moment is its latest one
-- (by valid_from) there; its anchor price is the latest one flagged
-- anchored. special_sale marks a price applied during a special form of
-- sale (posebni oblik prodaje -- a discount, a promotion), which the price
-- list file has to state as well.
CREATE TABLE maleniti.price (
    price_id SERIAL PRIMARY KEY,
    product_id INT NOT NULL REFERENCES maleniti.product,
    price_list_id INT NOT NULL REFERENCES maleniti.price_list ON DELETE CASCADE,
    valid_from TIMESTAMPTZ NOT NULL,
    price_eur NUMERIC(10, 2) NOT NULL CHECK (price_eur >= 0),
    anchored BOOLEAN NOT NULL DEFAULT FALSE,
    special_sale BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (product_id, price_list_id, valid_from)
);

CREATE INDEX price_product_valid_from ON maleniti.price (product_id, valid_from);

-- The business as it is today. Seeded here rather than as demo data: these
-- are real records (the published price lists are legal ones).

INSERT INTO maleniti.language (language_id, name) VALUES
    ('hr', 'hrvatski'),
    ('en', 'English');

-- A new trid holding one text per language; only for this script.
CREATE FUNCTION pg_temp.tr(hr TEXT, en TEXT) RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
    new_trid INT;
BEGIN
    INSERT INTO maleniti.translation_key DEFAULT VALUES RETURNING trid INTO new_trid;
    INSERT INTO maleniti.translation (trid, language_id, text) VALUES
        (new_trid, 'hr', hr),
        (new_trid, 'en', en);
    RETURN new_trid;
END;
$$;

-- P1 at the registered seat, for receipts issued by hand; WEB1 is A-To-Do's
-- online sales.
INSERT INTO maleniti.point_of_sale (code, type_trid, address) VALUES
    ('P1', pg_temp.tr('Poslovni prostor', 'Business premises'), 'Slakovec 80'),
    ('WEB1', pg_temp.tr('Internetska prodaja', 'Online sales'), 'Slakovec 80');

INSERT INTO maleniti.device (point_of_sale_id, device_number)
SELECT point_of_sale_id, 1 FROM maleniti.point_of_sale;

INSERT INTO maleniti.brand (code, name_trid) VALUES
    ('atodo', pg_temp.tr('A-To-Do', 'A-To-Do'));

INSERT INTO maleniti.product (brand_id, code, name_trid)
SELECT brand_id, p.code, p.name_trid
FROM maleniti.brand,
     (VALUES
         ('atodo-free', pg_temp.tr('A-To-Do Besplatno', 'A-To-Do Free')),
         ('atodo-pro-monthly', pg_temp.tr('A-To-Do Pro – mjesečna pretplata', 'A-To-Do Pro Monthly')),
         ('atodo-pro-yearly', pg_temp.tr('A-To-Do Pro – godišnja pretplata', 'A-To-Do Pro Yearly'))
     ) AS p (code, name_trid)
WHERE brand.code = 'atodo';

-- WEB1's first price list: A-To-Do's prices as they were on 10 Sept 2026,
-- the anchor date (anchored, so they're its anchor prices from then on).
INSERT INTO maleniti.price_list (point_of_sale_id, published_at)
SELECT point_of_sale_id, '2026-09-10 00:00:00 Europe/Zagreb' FROM maleniti.point_of_sale WHERE code = 'WEB1';

INSERT INTO maleniti.price (product_id, price_list_id, valid_from, price_eur, anchored)
SELECT product.product_id, price_list.price_list_id, price_list.published_at, p.price_eur, TRUE
FROM maleniti.price_list
JOIN maleniti.point_of_sale USING (point_of_sale_id),
     (VALUES ('atodo-free', 0.00), ('atodo-pro-monthly', 2.00), ('atodo-pro-yearly', 20.00)) AS p (code, price_eur)
JOIN maleniti.product ON product.code = p.code
WHERE point_of_sale.code = 'WEB1';
