const fs = require('fs');
const path = require('path');
const db = require('../db');

// Keeps the API from running against a database whose schema version isn't
// the one this code was written for. The version this code expects is the
// highest UP_<NNN>_Version_*.sql in db/migrations (applied by dbupdater's
// pgupgrade, which records the database's version in public.setting,
// 'dbVersion'). Until the two match -- database behind, ahead, unversioned
// or unreachable -- every request except GET /health answers 503
// MAINTENANCE (requireDbInSync), instead of failing on missing columns or,
// worse, writing data in a shape the schema no longer expects. Re-checked
// every few seconds, so the API recovers by itself once a migration lands.

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const CHECK_INTERVAL_MS = 10 * 1000;

// The platform's maintenance flag (mn maintenance on / a deploy that
// migrates), mounted into this container: while it exists, requests get
// 503 MAINTENANCE here too -- not only at the TLS proxy -- so it holds
// however the API is reached. Checked at most every couple of seconds.
const MAINTENANCE_FLAG = process.env.MAINTENANCE_FLAG_FILE || '/maintenance/on';
const FLAG_TTL_MS = 2000;
let flag = { on: false, checkedAt: 0 };
function maintenanceFlagOn() {
 if (Date.now() - flag.checkedAt > FLAG_TTL_MS) flag = { on: fs.existsSync(MAINTENANCE_FLAG), checkedAt: Date.now() };
 return flag.on;
}

function expectedDbVersion() {
 const versions = fs.readdirSync(MIGRATIONS_DIR)
  .map((f) => /^UP_(\d{3})_Version_.*\.sql$/.exec(f))
  .filter(Boolean)
  .map((m) => m[1])
  .sort();
 return versions.length ? versions[versions.length - 1] : '000';
}

const EXPECTED = expectedDbVersion();
let state = { status: 'unknown', dbVersion: null };
const inSyncListeners = [];

async function check() {
 let next;
 try {
  const { rows: [{ exists }] } = await db.query("SELECT to_regclass('public.setting') IS NOT NULL AS exists");
  let dbVersion = null;
  if (exists) {
   const { rows } = await db.query("SELECT settingValue AS v FROM public.setting WHERE settingName = 'dbVersion'");
   dbVersion = rows.length ? rows[0].v : null;
  }
  next = { status: dbVersion === EXPECTED ? 'ok' : dbVersion ? 'mismatch' : 'unversioned', dbVersion };
 } catch (err) {
  next = { status: 'unreachable', dbVersion: null, error: err.message };
 }
 if (next.status !== state.status || next.dbVersion !== state.dbVersion) {
  console.log(next.status === 'ok'
   ? `[db] schema version ${EXPECTED} -- in sync`
   : `[db] NOT in sync (${next.status}${next.dbVersion ? `, database at ${next.dbVersion}` : ''}${next.error ? `: ${next.error}` : ''}; this code expects ${EXPECTED}) -- answering 503 MAINTENANCE`);
 }
 const becameInSync = next.status === 'ok' && state.status !== 'ok';
 state = next;
 if (becameInSync) inSyncListeners.forEach((fn) => fn());
 return state;
}

function startDbVersionChecks() {
 check();
 return setInterval(check, CHECK_INTERVAL_MS).unref();
}

const isDbInSync = () => state.status === 'ok';

// Runs `fn` every time the database comes (back) in sync -- e.g. starting
// background jobs only once there's a schema they can work with.
function onDbInSync(fn) {
 inSyncListeners.push(fn);
 if (isDbInSync()) fn();
}

const maintenance = (res) =>
 res.status(503).set('Retry-After', '30').json({ code: 'MAINTENANCE', message: 'The service is being updated. Please try again in a few minutes.' });

// Before anything that touches the database. The very first request after
// startup waits for the first check rather than being refused on 'unknown'.
// Also refuses while the platform's maintenance flag is set.
async function requireDbInSync(req, res, next) {
 if (maintenanceFlagOn()) return maintenance(res);
 if (state.status === 'unknown') await check();
 if (isDbInSync()) return next();
 maintenance(res);
}

// GET /health -- for the platform's deploy script (and anyone curious):
// this build's version, the database's version and the one expected.
// `status` is about the api and database only -- not the maintenance flag
// (reported separately), since a deploy checks the new release's health
// before it switches maintenance off.
async function health(req, res) {
 if (state.status === 'unknown') await check();
 res.status(isDbInSync() ? 200 : 503).json({
  status: isDbInSync() ? 'ok' : 'maintenance',
  version: process.env.APP_VERSION || 'dev',
  dbVersion: state.dbVersion,
  expectedDbVersion: EXPECTED,
  db: state.status,
  maintenanceFlag: maintenanceFlagOn(),
 });
}

module.exports = { startDbVersionChecks, requireDbInSync, isDbInSync, onDbInSync, health, expectedDbVersion, check };
