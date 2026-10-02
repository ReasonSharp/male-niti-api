# Database migrations

The database schema, as versioned SQL scripts for dbupdater's `pgupgrade` /
`pgdowngrade` (https://github.com/maleniti/dbupdater — see its README for
the exact rules). The platform (`male-niti`'s `mn`) runs them on deploy; the
API itself never changes the schema.

| File | Purpose |
|---|---|
| `UP_NNN_Version_<description>.sql` | Version NNN-1 → NNN. |
| `DOWN_NNN_Version_<description>.sql` | Version NNN → NNN-1. |
| `DEMOPUT_NNN.sql` / `DEMODEL_NNN.sql` | Demo data (`--demo`) and its removal. |

Versions so far: **001** the CMS (public schema), **002** A-To-Do (`atodo`
schema), **003** a stats reset point per task (`atodo.tasks.stats_reset_at`), **004** published price lists (`maleniti` schema: points of sale, devices, brands, products, price lists, their prices and which point of sale uses which list, with translations; seeded with the real business data), **005** each product's landing-page place and highlight, billing interval and Stripe product. The demo data (version 002) is a free account
`demo@a-to-do.test` / `demo-password` with a few tasks.

## Rules

- **Released scripts are never edited.** Every schema change is a new
  `UP_`/`DOWN_` pair with the next number.
- Each version runs in one transaction together with the version bump, so
  no `BEGIN`/`COMMIT` in the scripts, nothing that can't run in a
  transaction (e.g. `CREATE INDEX CONCURRENTLY`), and no `dbVersion`
  updates — pgupgrade does that.
- A version whose downgrade would destroy data that must survive (accounts,
  fiscal receipts...) raises `minAllowedVersion` to itself — as `UP_001` and
  `UP_002` do — so `pgdowngrade` can't go below it.
- The API refuses to serve (503 `MAINTENANCE`, see `lib/dbVersion.js`)
  unless the database is at exactly the highest `UP_` version here, so a
  new migration and the code that needs it ship together.

## Locally

```bash
PSQL="docker exec -i <postgres-container> psql" \
  <dbupdater>/pgupgrade db/migrations --demo --full -U postgres <db_name>
```
