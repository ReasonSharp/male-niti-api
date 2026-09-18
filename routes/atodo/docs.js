const express = require('express');
const fs = require('fs');
const path = require('path');
const YAML = require('js-yaml');
const swaggerUi = require('swagger-ui-express');

// Mirrors routes/docs.js's own pattern, for atodo-api-spec.yaml instead --
// kept as a separate Swagger UI instance rather than merged into the main
// one since both specs declare their own, differently-meaning `bearerAuth`
// scheme (CMS API key here vs. a-to-do account JWT there).
const spec = YAML.load(fs.readFileSync(path.resolve(__dirname, '..', '..', 'atodo-api-spec.yaml'), 'utf8'));

const router = express.Router();

router.use('/', swaggerUi.serve, swaggerUi.setup(spec));

module.exports = router;
