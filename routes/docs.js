const express = require('express');
const fs = require('fs');
const path = require('path');
const YAML = require('js-yaml');
const swaggerUi = require('swagger-ui-express');

const spec = YAML.load(fs.readFileSync(path.resolve(__dirname, '..', 'api-spec.yaml'), 'utf8'));

const router = express.Router();

router.use('/', swaggerUi.serve, swaggerUi.setup(spec));

module.exports = router;
