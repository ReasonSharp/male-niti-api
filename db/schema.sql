-- Database schema for the Male Niti Content API.
-- Run automatically on first init by the postgres container in docker-compose.yml
-- (mounted into /docker-entrypoint-initdb.d/), or apply manually with:
--   psql "$DATABASE_URL" -f db/schema.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS services (
    id SERIAL PRIMARY KEY,
    sort_order INTEGER NOT NULL DEFAULT 0,
    tone TEXT NOT NULL CHECK (tone IN ('indigo', 'green')),
    roman TEXT NOT NULL,
    num_hr TEXT NOT NULL,
    num_en TEXT NOT NULL,
    title_hr TEXT NOT NULL,
    title_en TEXT NOT NULL,
    title2_hr TEXT NOT NULL,
    title2_en TEXT NOT NULL,
    body_hr TEXT NOT NULL,
    body_en TEXT NOT NULL,
    list_hr TEXT[] NOT NULL,
    list_en TEXT[] NOT NULL
);

CREATE TABLE IF NOT EXISTS pricing_plans (
    id SERIAL PRIMARY KEY,
    sort_order INTEGER NOT NULL DEFAULT 0,
    tag_hr TEXT NOT NULL,
    tag_en TEXT NOT NULL,
    title_hr TEXT NOT NULL,
    title_en TEXT NOT NULL,
    em_hr TEXT,
    em_en TEXT,
    sub_hr TEXT NOT NULL,
    sub_en TEXT NOT NULL,
    list_hr TEXT[] NOT NULL,
    list_en TEXT[] NOT NULL,
    when_hr TEXT NOT NULL,
    when_en TEXT NOT NULL,
    featured BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS work_items (
    id SERIAL PRIMARY KEY,
    sort_order INTEGER NOT NULL DEFAULT 0,
    featured BOOLEAN NOT NULL DEFAULT FALSE,
    slug TEXT UNIQUE,
    media_label_hr TEXT NOT NULL,
    media_label_en TEXT NOT NULL,
    caption_hr TEXT NOT NULL,
    caption_en TEXT NOT NULL,
    status_label_hr TEXT,
    status_label_en TEXT,
    title_hr TEXT,
    title_en TEXT,
    title_rest_hr TEXT,
    title_rest_en TEXT,
    body_hr TEXT,
    body_en TEXT,
    chips TEXT[],
    client_hr TEXT,
    client_en TEXT,
    duration_hr TEXT,
    duration_en TEXT,
    users_hr TEXT,
    users_en TEXT,
    status_hr TEXT,
    status_en TEXT,
    demo_url TEXT,
    demo_label_hr TEXT,
    demo_label_en TEXT,
    post_slug TEXT
);

CREATE TABLE IF NOT EXISTS blog_posts (
    id SERIAL PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    tag_hr TEXT NOT NULL,
    tag_en TEXT NOT NULL,
    tone TEXT NOT NULL CHECK (tone IN ('indigo', 'green')),
    date_hr TEXT NOT NULL,
    date_en TEXT NOT NULL,
    title_hr TEXT NOT NULL,
    title_en TEXT NOT NULL,
    em_hr TEXT,
    em_en TEXT,
    excerpt_hr TEXT NOT NULL,
    excerpt_en TEXT NOT NULL,
    read_hr TEXT NOT NULL,
    read_en TEXT NOT NULL,
    featured BOOLEAN NOT NULL DEFAULT FALSE,
    lede_hr TEXT,
    lede_en TEXT,
    body_hr JSONB NOT NULL,
    body_en JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    kind TEXT,
    msg TEXT NOT NULL,
    completed BOOLEAN NOT NULL DEFAULT FALSE,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bearer-token API keys. Only the key's hash is stored; the plaintext is
-- shown once at creation time by scripts/create-api-key.js and never again.
CREATE TABLE IF NOT EXISTS api_keys (
    id SERIAL PRIMARY KEY,
    key_hash TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    is_super_admin BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

-- IPs banned for abusive traffic (see lib/rateLimiter.js). expires_at NULL means permanent.
CREATE TABLE IF NOT EXISTS banned_ips (
    ip TEXT PRIMARY KEY,
    reason TEXT,
    banned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ
);
