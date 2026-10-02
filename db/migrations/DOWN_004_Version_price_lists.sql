-- Reverts version 004: drops the maleniti schema -- points of sale, devices,
-- brands, products and every published price list with its prices. Nothing
-- else references it.

DROP SCHEMA maleniti CASCADE;
