-- Version 005: what a brand's website and checkout need to know about its
-- products, so neither hardcodes them any more -- the price list (version
-- 004) already says what each costs.
--
--   featured_ord      -- the product's place on the brand's landing page
--                        (1, 2, 3...), NULL = not shown there
--   highlight         -- shown highlighted there
--   billing_interval  -- a subscription billed every month or year (NULL =
--                        not a subscription, e.g. a free plan)
--   stripe_product_id -- the Stripe Product (prod_...) its subscriptions
--                        are sold as; checkout charges the price list's
--                        price for it (NULL = not sold through Stripe).
--                        Differs between Stripe's test and live mode, so
--                        it's set per deployment, in the admin app.

ALTER TABLE maleniti.product
    ADD COLUMN featured_ord INT CHECK (featured_ord > 0),
    ADD COLUMN highlight BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN billing_interval TEXT CHECK (billing_interval IN ('month', 'year')),
    ADD COLUMN stripe_product_id TEXT CHECK (stripe_product_id ~ '^prod_[A-Za-z0-9]+$'),
    ADD CONSTRAINT product_featured_ord_unique UNIQUE (brand_id, featured_ord),
    -- One subscription per interval per brand: checkout picks it by interval.
    ADD CONSTRAINT product_billing_interval_unique UNIQUE (brand_id, billing_interval);

-- A-To-Do's landing page as it was: Free, Pro monthly, Pro yearly (highlighted).
UPDATE maleniti.product SET featured_ord = 1 WHERE code = 'atodo-free';
UPDATE maleniti.product SET featured_ord = 2, billing_interval = 'month' WHERE code = 'atodo-pro-monthly';
UPDATE maleniti.product SET featured_ord = 3, billing_interval = 'year', highlight = TRUE WHERE code = 'atodo-pro-yearly';
