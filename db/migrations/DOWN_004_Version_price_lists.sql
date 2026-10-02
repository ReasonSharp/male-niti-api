-- Reverts version 004: drops the maleniti schema -- points of sale, devices,
-- brands, products, price lists with every price they held, and which point
-- of sale used which. Nothing else references it.

DROP SCHEMA maleniti CASCADE;
