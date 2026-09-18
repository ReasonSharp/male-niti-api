const express = require('express');
const requireAtodoAuth = require('../../lib/atodo/authenticate');
const authRouter = require('./auth');
const usersRouter = require('./users');
const tasksRouter = require('./tasks');
const subscriptionsRouter = require('./subscriptions');

const router = express.Router();

// authRouter guards its own /me route (requireAtodoAuth is per-route there,
// not per-router) since /register, /verify-email and /login are public
// (security: [] in api-spec.yaml) but /me isn't.
router.use('/auth', authRouter);
router.use('/users', requireAtodoAuth, usersRouter);
router.use('/tasks', requireAtodoAuth, tasksRouter);
router.use('/subscriptions', requireAtodoAuth, subscriptionsRouter);

module.exports = router;
