#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const crypto = require('crypto');
const db = require('../db');
const hashApiKey = require('../lib/apiKeyHash');

async function main() {
 const args = process.argv.slice(2);
 const isSuperAdmin = args.includes('--admin');
 const label = args.find((a) => !a.startsWith('--'));

 if (!label) {
  console.error('Usage: node scripts/create-api-key.js <label> [--admin]');
  process.exit(1);
 }

 const key = crypto.randomBytes(32).toString('base64url');

 await db.query(
  'INSERT INTO api_keys (key_hash, label, is_super_admin) VALUES ($1, $2, $3)',
  [hashApiKey(key), label, isSuperAdmin]
 );

 console.log(`API key created for "${label}"${isSuperAdmin ? ' (super admin)' : ''}:`);
 console.log(key);
 console.log('Store this now - only its hash is kept, it cannot be shown again.');
}

main()
 .then(() => process.exit(0))
 .catch((err) => {
  console.error(err);
  process.exit(1);
 });
