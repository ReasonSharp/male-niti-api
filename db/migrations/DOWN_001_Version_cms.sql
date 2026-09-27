-- Reverts version 001: drops the whole CMS. Blocked by minAllowedVersion
-- 001 (set by UP_001) -- only reachable if that's deliberately lowered.

DROP TABLE banned_ips;
DROP TABLE api_keys;
DROP TABLE contact_submissions;
DROP TABLE imprint;
DROP TABLE blog_posts;
DROP TABLE work_items;
DROP TABLE pricing_plans;
DROP TABLE services;
