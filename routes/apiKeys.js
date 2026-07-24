const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const hashApiKey = require('../lib/apiKeyHash');

const router = express.Router();

// Rotates an API key's secret in place (id, label, admin flag unchanged).
// Self-service: a caller can always rotate their own key. A super admin can
// rotate anyone's. The new plaintext key is returned once here, same as
// scripts/create-api-key.js - only its hash is ever stored afterwards.
router.post('/:id/rotate', asyncHandler(async (req, res) => {
 if (!req.auth) return res.status(401).send('Authentication required');

 const targetId = Number(req.params.id);
 if (!Number.isInteger(targetId)) return res.status(400).send('Invalid id');

 if (req.auth.id !== targetId && !req.auth.isSuperAdmin) {
  return res.status(403).send('Can only rotate your own API key');
 }

 const { rows: existing } = await db.query(
  'SELECT id, revoked_at FROM api_keys WHERE id = $1',
  [targetId]
 );
 if (existing.length === 0) return res.status(404).send('Not found');
 if (existing[0].revoked_at) return res.status(409).send('API key has been revoked');

 const key = crypto.randomBytes(32).toString('base64url');

 const { rows } = await db.query(
  `UPDATE api_keys SET key_hash = $1 WHERE id = $2
   RETURNING id, label, is_super_admin, created_at, last_used_at`,
  [hashApiKey(key), targetId]
 );

 res.json({ ...rows[0], key });
}));

module.exports = router;
