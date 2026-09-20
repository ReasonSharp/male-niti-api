-- Database schema for the A-To-Do integration (see ../atodo/api-spec.yaml,
-- copied into this repo as atodo-api-spec.yaml, for the API contract these
-- tables back). Applied the same way as schema.sql -- this repo doesn't
-- apply its own schema, see CLAUDE.md.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- A real Postgres schema (not just a table-name prefix) so the atodo
-- integration's tables stay clearly separated from the CMS's own
-- (public-schema) tables -- see routes/atodo/ and lib/atodo/, which qualify
-- every reference as atodo.<table>.
CREATE SCHEMA IF NOT EXISTS atodo;

-- A registration that hasn't clicked its verification email link yet.
-- Promoted into atodo.accounts (and deleted) by POST /atodo/v1/auth/verify-email.
-- Registering again with the same still-pending email overwrites this row with
-- a fresh token/expiry rather than erroring -- see routes/atodo/auth.js.
CREATE TABLE IF NOT EXISTS atodo.pending_registrations (
    email TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- One row per verified account. Subscription state is embedded directly
-- (an account has at most one subscription at a time) rather than kept in a
-- separate table -- subscription_plan IS NULL means "Free", matching the API
-- spec's Subscription schema, where null means the account has never subscribed.
CREATE TABLE IF NOT EXISTS atodo.accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    nickname TEXT NOT NULL DEFAULT '',
    avatar TEXT,
    time_format TEXT NOT NULL DEFAULT '24' CHECK (time_format IN ('12', '24')),
    background JSONB,
    language TEXT CHECK (language IN ('en', 'hr')),
    active_task_id TEXT,
    active_occurrence_date TEXT,
    todo_view_mode TEXT NOT NULL DEFAULT 'pending' CHECK (todo_view_mode IN ('pending', 'next-recurrence', 'all')),
    subscription_id UUID,
    subscription_plan TEXT CHECK (subscription_plan IN ('trial', 'pro')),
    subscription_billing_interval TEXT CHECK (subscription_billing_interval IN ('monthly', 'annual')),
    subscription_started_at TIMESTAMPTZ,
    subscription_expires_at TIMESTAMPTZ,
    subscription_cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
    subscription_scheduled_deletion BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ,
    last_active_at TIMESTAMPTZ,
    -- Bumped by POST /users/me/change-password (lib/atodo/authenticate.js
    -- rejects any bearer token issued before this) so changing a password
    -- ends every other outstanding session, not just this one. NULL means
    -- never changed -- every token issued since account creation stays valid.
    password_changed_at TIMESTAMPTZ
);

-- CREATE TABLE IF NOT EXISTS above is a no-op against an already-deployed
-- atodo.accounts (this file has no migration tool -- see CLAUDE.md), so
-- password_changed_at is added separately, idempotently, to actually reach
-- existing deployments when this file is re-applied.
ALTER TABLE atodo.accounts ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

-- One account's entire to-do list, bulk-replaced by PUT /atodo/v1/tasks. id
-- is client-generated (see api-spec.yaml's Task schema). Date-only fields
-- are kept as plain TEXT rather than DATE, matching the spec's own
-- "YYYY-MM-DD, compared as strings, never parsed" contract for
-- dueDate/endDate/occurrence dates, and sidestepping node-pg's
-- timezone-sensitive DATE-to-Date-object conversion.
CREATE TABLE IF NOT EXISTS atodo.tasks (
    account_id UUID NOT NULL REFERENCES atodo.accounts(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    series_id TEXT NOT NULL,
    series_name TEXT,
    name TEXT NOT NULL,
    description TEXT,
    details TEXT,
    due_date TEXT NOT NULL,
    due_time TEXT,
    all_day BOOLEAN NOT NULL,
    appointment BOOLEAN NOT NULL,
    passive BOOLEAN NOT NULL,
    recur_until_completed BOOLEAN NOT NULL,
    pending_reschedules TEXT[] NOT NULL DEFAULT '{}',
    end_date TEXT,
    frequency JSONB NOT NULL,
    completions JSONB NOT NULL DEFAULT '{}',
    dismissed JSONB NOT NULL DEFAULT '{}',
    marked_failed JSONB NOT NULL DEFAULT '{}',
    created_at BIGINT NOT NULL,
    timer JSONB,
    log JSONB NOT NULL DEFAULT '[]',
    comments JSONB NOT NULL DEFAULT '[]',
    PRIMARY KEY (account_id, id)
);

-- Mock Stripe Checkout sessions (see lib/atodo/stripe.js) -- payment always
-- "succeeds", so a session is already 'paid' by the time it's inserted; kept
-- as a real table anyway so GET /subscriptions/checkout-sessions/{sessionId}
-- has something to look up, the same shape a real Stripe-backed
-- implementation would need for its webhook to update.
CREATE TABLE IF NOT EXISTS atodo.checkout_sessions (
    id TEXT PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES atodo.accounts(id) ON DELETE CASCADE,
    billing_interval TEXT NOT NULL CHECK (billing_interval IN ('monthly', 'annual')),
    status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('pending', 'paid', 'cancelled')),
    success_url TEXT NOT NULL,
    cancel_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
