-- Reverts version 005: products forget their landing-page place, highlight,
-- billing interval and Stripe Product.

ALTER TABLE maleniti.product
    DROP CONSTRAINT product_billing_interval_unique,
    DROP CONSTRAINT product_featured_ord_unique,
    DROP COLUMN stripe_product_id,
    DROP COLUMN billing_interval,
    DROP COLUMN highlight,
    DROP COLUMN featured_ord;
