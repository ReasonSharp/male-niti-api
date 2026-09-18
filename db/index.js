const { Pool } = require('pg');

// With no config, Pool reads the standard PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE
// env vars (loaded from .env by dotenv in server.js before this module is required).
const pool = new Pool();

module.exports = {
 query: (text, params) => pool.query(text, params),
 // For callers that need a transaction (e.g. PUT /atodo/v1/tasks' bulk
 // replace) -- caller is responsible for BEGIN/COMMIT/ROLLBACK and release().
 getClient: () => pool.connect(),
};
