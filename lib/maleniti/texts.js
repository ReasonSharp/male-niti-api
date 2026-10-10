// A brand's interface texts (the maleniti schema's named translation keys,
// migration 010) in one language, by key: { language, strings }. A text the
// language lacks is English's; an unknown language is English altogether
// (`language` then says 'en'). `db` is the pool or a transaction's client.
// Used by the client's GET /atodo/v1/translations and by emails the API
// writes in a user's language.

const FALLBACK_LANGUAGE = 'en';

async function brandTexts(db, brand, bundles, requestedLanguage) {
 const requested = /^[a-z]{2}$/.test(requestedLanguage || '') ? requestedLanguage : FALLBACK_LANGUAGE;
 const { rows: known } = await db.query('SELECT 1 FROM maleniti.language WHERE language_id = $1', [requested]);
 const language = known.length ? requested : FALLBACK_LANGUAGE;
 const { rows } = await db.query(
  `SELECT k.name, COALESCE(t.text, e.text, '') AS text
   FROM maleniti.translation_key k
   JOIN maleniti.brand b ON b.brand_id = k.brand_id
   LEFT JOIN maleniti.translation t ON t.trid = k.trid AND t.language_id = $2
   LEFT JOIN maleniti.translation e ON e.trid = k.trid AND e.language_id = $3
   WHERE b.code = $1 AND k.bundle = ANY($4)`,
  [brand, language, FALLBACK_LANGUAGE, bundles]
 );
 return { language, strings: Object.fromEntries(rows.map((r) => [r.name, r.text])) };
}

// A text with its {placeholder} tokens filled -- the client's own scheme
// (its i18n.js's formatTranslation). A missing key shows as itself.
function formatText(strings, key, vars = {}) {
 const str = strings[key] ?? key;
 return str.replace(/\{(\w+)\}/g, (_, name) => (vars[name] != null ? vars[name] : `{${name}}`));
}

module.exports = { brandTexts, formatText, FALLBACK_LANGUAGE };
