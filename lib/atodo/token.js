const jwt = require('./jwt');

// A long-lived token, since this is a to-do app a person stays logged into
// rather than a short session -- re-issued wholesale (see issueToken's own
// call sites) whenever something it carries as a claim changes.
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

function toSubscription(row) {
 if (!row.subscription_plan) return null;
 return {
  id: row.subscription_id,
  plan: row.subscription_plan,
  billingInterval: row.subscription_billing_interval,
  startedAt: row.subscription_started_at ? new Date(row.subscription_started_at).getTime() : null,
  expiresAt: row.subscription_expires_at ? new Date(row.subscription_expires_at).getTime() : null,
  cancelAtPeriodEnd: row.subscription_cancel_at_period_end,
  scheduledDeletion: row.subscription_scheduled_deletion,
 };
}

function toUser(row) {
 return {
  id: row.id,
  email: row.email,
  nickname: row.nickname,
  avatar: row.avatar,
  timeFormat: row.time_format,
  background: row.background,
  language: row.language,
  theme: row.theme,
  weekStart: row.week_start,
  activeTaskId: row.active_task_id,
  activeOccurrenceDate: row.active_occurrence_date,
  todoViewMode: row.todo_view_mode,
  subscription: toSubscription(row),
 };
}

function toPasswordVersion(row) {
 return row.password_changed_at ? new Date(row.password_changed_at).getTime() : null;
}

function issueToken(row) {
 return jwt.sign({ sub: row.id, subscription: toSubscription(row), pwv: toPasswordVersion(row) }, TOKEN_TTL_SECONDS);
}

module.exports = { toUser, toSubscription, toPasswordVersion, issueToken };
