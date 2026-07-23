const { Pool } = require('pg');

// With no config, Pool reads the standard PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE
// env vars (loaded from .env by dotenv in server.js before this module is required).
const pool = new Pool();

module.exports = {
 query: (text, params) => pool.query(text, params),
};
