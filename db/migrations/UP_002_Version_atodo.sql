-- Version 002: the A-To-Do integration (see atodo-api-spec.yaml for the API
-- contract these tables back), in its own `atodo` schema -- a real Postgres
-- schema, not a table-name prefix, so it stays clearly apart from the CMS's
-- public-schema tables; routes/atodo/ and lib/atodo/ qualify every
-- reference as atodo.<table>.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA atodo;

-- A registration that hasn't clicked its verification email link yet.
-- Promoted into atodo.accounts (and deleted) by POST /atodo/v1/auth/verify-email.
-- Registering again with the same still-pending email overwrites this row with
-- a fresh token/expiry rather than erroring -- see routes/atodo/auth.js.
CREATE TABLE atodo.pending_registrations (
    email TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- One row per account. Subscription state is embedded directly (an account
-- has at most one subscription at a time) rather than kept in a separate
-- table -- subscription_plan IS NULL means "Free", matching the API spec's
-- Subscription schema, where null means the account has never subscribed.
CREATE TABLE atodo.accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    nickname TEXT NOT NULL DEFAULT '',
    avatar TEXT,
    time_format TEXT NOT NULL DEFAULT '24' CHECK (time_format IN ('12', '24')),
    background JSONB,
    language TEXT CHECK (language IN ('en', 'hr')),
    theme TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark', 'light')),
    -- First day of the week, 0=Sunday..6=Saturday; NULL = never chosen (the
    -- client then follows the language).
    week_start SMALLINT CHECK (week_start BETWEEN 0 AND 6),
    -- A login-email change awaiting verification (POST /users/me/change-email):
    -- the new address, its single-use verification token and when that
    -- expires. email_change_requested_at identifies the latest request --
    -- the undo link's signed token embeds it, so only the latest request's
    -- undo link works, and only once (an undo clears it).
    pending_email TEXT,
    pending_email_token TEXT UNIQUE,
    pending_email_expires_at TIMESTAMPTZ,
    email_change_requested_at TIMESTAMPTZ,
    -- The Stripe customer this account pays as, and its current Stripe
    -- subscription (if any) -- see lib/atodo/billing.js.
    stripe_customer_id TEXT UNIQUE,
    stripe_subscription_id TEXT,
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
    password_changed_at TIMESTAMPTZ,
    -- Closed (deleted) accounts are kept for a year with only their email,
    -- password hash and trial status -- see lib/atodo/closedAccounts.js.
    closed_at TIMESTAMPTZ,
    -- The account (or the one closed before it) has had a trial or
    -- subscription, so no new free trial even with subscription_plan NULL.
    trial_ineligible BOOLEAN NOT NULL DEFAULT false
);

-- One record per task: its data plus its current recurrence pattern,
-- bulk-replaced by PUT /atodo/v1/tasks. id is client-generated (see
-- atodo-api-spec.yaml's Task schema). Date-only fields are plain TEXT rather
-- than DATE, matching the spec's "YYYY-MM-DD, compared as strings, never
-- parsed" contract, and sidestepping node-pg's timezone-sensitive
-- DATE-to-Date conversion. Holds no per-occurrence state -- that lives on
-- atodo.occurrences, keyed by task_id. log/comments here are task-level
-- (not tied to one date).
CREATE TABLE atodo.tasks (
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
    end_date TEXT,
    frequency JSONB NOT NULL,
    created_at BIGINT NOT NULL,
    log JSONB NOT NULL DEFAULT '[]',
    comments JSONB NOT NULL DEFAULT '[]',
    PRIMARY KEY (account_id, id)
);

-- One row per *interacted-with* occurrence of a task -- sparse: a
-- pattern-produced date with nothing recorded on it has no row at all, but
-- every row that exists always counts as an occurrence. task_id (not a
-- specific atodo.tasks row's id) is the reference.
--
-- recur_until_completed tasks keep at most one 'pending' row alive at a
-- time -- their current occurrence -- with pending_reschedules tracking
-- every date it's been auto-pushed through without being resolved (see the
-- client's recurrence.js). Completing it resolves this row and inserts a new
-- 'pending' one for the next cycle.
CREATE TABLE atodo.occurrences (
    account_id UUID NOT NULL REFERENCES atodo.accounts(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    occurrence_date TEXT NOT NULL,
    pending_reschedules TEXT[] NOT NULL DEFAULT '{}',
    -- The occurrence's OUTCOME. Independent of `dismissed` below: an
    -- occurrence can be 'completed' and still not yet dismissed (the brief
    -- linger before it visually disappears), or 'pending' and already
    -- dismissed (a missed occurrence swept off the list without ever being
    -- resolved) -- two separate axes, not one.
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
    resolved_at BIGINT,
    -- Hidden from the list regardless of status -- see the client's
    -- markOccurrencesDismissedBefore/autoDismissStaleCarriedOverOccurrences/
    -- scheduleDismissal.
    dismissed BOOLEAN NOT NULL DEFAULT FALSE,
    manual BOOLEAN NOT NULL DEFAULT FALSE,
    overrides JSONB,
    -- Free-text details specific to this one occurrence (the task's own
    -- details apply to all of its occurrences alike) -- see Occurrence.details.
    details TEXT,
    comments JSONB NOT NULL DEFAULT '[]',
    log JSONB NOT NULL DEFAULT '[]',
    focused_seconds INTEGER NOT NULL DEFAULT 0,
    timer_seconds INTEGER NOT NULL DEFAULT 0,
    timer JSONB,
    PRIMARY KEY (account_id, id),
    UNIQUE (account_id, task_id, occurrence_date)
);

-- Our record of each Stripe Checkout Session, 'pending' until Stripe
-- reports it paid or expired -- see routes/atodo/subscriptions.js and
-- lib/atodo/billing.js (rows are always inserted with an explicit status).
CREATE TABLE atodo.checkout_sessions (
    id TEXT PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES atodo.accounts(id) ON DELETE CASCADE,
    billing_interval TEXT NOT NULL CHECK (billing_interval IN ('monthly', 'annual')),
    status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('pending', 'paid', 'cancelled')),
    success_url TEXT NOT NULL,
    cancel_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fiscalized B2C receipts (Croatian "fiskalizacija", see lib/atodo/fiscal/),
-- one per paid Stripe invoice, plus a storno receipt per refund. Receipt
-- numbers run sequentially per payment device within each calendar year
-- (OznSlijed 'N'), allocated under an advisory lock so there are no gaps or
-- duplicates. `zki` (the issuer's security code) is fixed at issue time;
-- `jir` arrives from the Tax Administration -- until it does, status stays
-- 'pending' and the receipt is re-sent as a late delivery (NakDost).
-- Receipts are legal records: deleting an account only detaches them
-- (account_id SET NULL); they're kept intact for 11 years from the end of
-- their year, then deleted (closedAccounts.js's purge).
CREATE TABLE atodo.fiscal_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID REFERENCES atodo.accounts(id) ON DELETE SET NULL,
    customer_email TEXT NOT NULL,
    -- For a storno, the refunded invoice -- hence unique only among sales
    -- (fiscal_receipts_sale_invoice below).
    stripe_invoice_id TEXT NOT NULL,
    year SMALLINT NOT NULL,
    number INTEGER NOT NULL,
    premises TEXT NOT NULL,
    device TEXT NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL,
    description TEXT NOT NULL,
    total_cents INTEGER NOT NULL,
    zki TEXT NOT NULL,
    jir TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fiscalized')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_attempt_at TIMESTAMPTZ,
    emailed_at TIMESTAMPTZ,
    -- A storno receipt: the refund it's for, and the receipt it cancels (a
    -- storno outliving its original's 11 years just loses the link).
    stripe_refund_id TEXT UNIQUE,
    original_receipt_id UUID REFERENCES atodo.fiscal_receipts(id) ON DELETE SET NULL,
    UNIQUE (premises, device, year, number)
);
CREATE UNIQUE INDEX fiscal_receipts_sale_invoice ON atodo.fiscal_receipts (stripe_invoice_id) WHERE stripe_refund_id IS NULL;

-- Never downgrade below this: DOWN_002 would drop every account and task,
-- and the fiscal receipts, which the law requires us to keep.
INSERT INTO public.setting (settingName, settingValue) VALUES ('minAllowedVersion', '002')
ON CONFLICT (settingName) DO UPDATE SET settingValue = EXCLUDED.settingValue;
