// A brand's legal documents -- its Privacy Policy and Terms of Service
// (migration 011). Each has its published versions (every one kept, the
// latest live) and a working copy per language, which only publishing
// makes public, as a new version -- either
//  - a change (substantial): the policy or terms themselves change, so in
//    every language at once (no one can tell which language's version a
//    user agreed to, so they must all say the same), and every open
//    A-To-Do account is emailed about it (lib/atodo/legalNotices.js); the
//    pages' "Last updated" date is the latest change's -- or
//  - a correction (migration 012): a typo or a mistranslation, in any
//    languages, without emails; "Last updated" stays the last change's.

const KINDS = ['privacy', 'terms'];

class LegalError extends Error {
 constructor(status, message) {
  super(message);
  this.status = status;
 }
}

async function findDocument(db, brand, kind) {
 if (!KINDS.includes(kind)) return null;
 const { rows: [doc] } = await db.query(
  `SELECT d.document_id, d.brand_id, d.kind FROM maleniti.legal_document d
   JOIN maleniti.brand b USING (brand_id) WHERE b.code = $1 AND d.kind = $2`,
  [brand, kind]
 );
 return doc || null;
}

// The live version (`substantial`: only changes, for the date users were
// told about).
async function latestPublication(db, documentId, { substantial = false } = {}) {
 const { rows: [publication] } = await db.query(
  `SELECT publication_id, published_at, published_by, substantial FROM maleniti.legal_publication
   WHERE document_id = $1 AND ($2 = false OR substantial)
   ORDER BY published_at DESC, publication_id DESC LIMIT 1`,
  [documentId, substantial]
 );
 return publication || null;
}

// { language: { title, body, changed, summary } }
async function publicationTexts(db, publicationId) {
 const { rows } = await db.query(
  'SELECT language_id, title, body, changed, summary FROM maleniti.legal_publication_text WHERE publication_id = $1',
  [publicationId]
 );
 return Object.fromEntries(rows.map(({ language_id: lang, ...text }) => [lang, text]));
}

// The live version in a language (else English, else any), for the
// document's page: { kind, language, title, body, publishedAt } --
// publishedAt the latest change's, corrections since then aside -- or null.
async function publishedDocument(db, brand, kind, language) {
 const doc = await findDocument(db, brand, kind);
 if (!doc) return null;
 const publication = await latestPublication(db, doc.document_id);
 if (!publication) return null;
 const texts = await publicationTexts(db, publication.publication_id);
 const lang = [language, 'en', ...Object.keys(texts)].find((l) => l && texts[l]);
 if (!lang) return null;
 const lastChange = await latestPublication(db, doc.document_id, { substantial: true });
 return { kind, language: lang, title: texts[lang].title, body: texts[lang].body, publishedAt: (lastChange || publication).published_at };
}

// Everything the admin app's editor needs: the live version, the working
// copies, every version with how its emails went, and how many accounts
// publishing would email.
async function documentForAdmin(db, brand, kind) {
 const doc = await findDocument(db, brand, kind);
 if (!doc) throw new LegalError(404, `No ${kind} document for ${brand}.`);
 const { rows: languages } = await db.query('SELECT language_id, name FROM maleniti.language ORDER BY language_id');
 const latest = await latestPublication(db, doc.document_id);
 const { rows: drafts } = await db.query(
  'SELECT language_id, title, body, summary, updated_at FROM maleniti.legal_draft WHERE document_id = $1',
  [doc.document_id]
 );
 const { rows: publications } = await db.query(
  `SELECT p.publication_id, p.published_at, p.published_by, p.substantial,
          (SELECT array_agg(t.language_id ORDER BY t.language_id) FROM maleniti.legal_publication_text t
           WHERE t.publication_id = p.publication_id AND t.changed) AS changed_languages,
          count(e.account_id)::int AS recipients,
          count(e.sent_at)::int AS sent,
          count(*) FILTER (WHERE e.account_id IS NOT NULL AND e.sent_at IS NULL AND e.attempts >= $2)::int AS failed
   FROM maleniti.legal_publication p
   LEFT JOIN atodo.legal_notice_emails e USING (publication_id)
   WHERE p.document_id = $1
   GROUP BY p.publication_id
   ORDER BY p.published_at DESC, p.publication_id DESC`,
  [doc.document_id, MAX_SEND_ATTEMPTS]
 );
 const { rows: [{ count: activeAccounts }] } = await db.query('SELECT count(*)::int AS count FROM atodo.accounts WHERE closed_at IS NULL');
 return {
  kind,
  languages,
  published: latest && { ...latest, texts: await publicationTexts(db, latest.publication_id) },
  drafts: Object.fromEntries(drafts.map(({ language_id: lang, ...draft }) => [lang, draft])),
  publications: publications.map((p) => ({ ...p, changed_languages: p.changed_languages || [] })),
  activeAccounts,
 };
}

async function saveDraft(db, brand, kind, language, { title, body, summary }) {
 const doc = await findDocument(db, brand, kind);
 if (!doc) throw new LegalError(404, `No ${kind} document for ${brand}.`);
 if (typeof title !== 'string' || !title.trim()) throw new LegalError(400, 'title is required');
 if (typeof body !== 'string' || !body.trim()) throw new LegalError(400, 'body is required');
 if (summary != null && typeof summary !== 'string') throw new LegalError(400, 'summary must be a text');
 const { rows: [draft] } = await db.query(
  `INSERT INTO maleniti.legal_draft (document_id, language_id, title, body, summary, updated_at)
   VALUES ($1, $2, $3, $4, $5, now())
   ON CONFLICT (document_id, language_id) DO UPDATE
   SET title = EXCLUDED.title, body = EXCLUDED.body, summary = EXCLUDED.summary, updated_at = now()
   RETURNING language_id, title, body, summary, updated_at`,
  [doc.document_id, language, title.trim(), body, (summary || '').trim()]
 );
 return draft;
}

async function discardDraft(db, brand, kind, language) {
 const doc = await findDocument(db, brand, kind);
 if (!doc) throw new LegalError(404, `No ${kind} document for ${brand}.`);
 await db.query('DELETE FROM maleniti.legal_draft WHERE document_id = $1 AND language_id = $2', [doc.document_id, language]);
}

// Publishes the working copies (in `client`'s transaction): a new version
// with every language -- a working copy where there is one, else the live
// text -- live from now; the working copies go. A change (`substantial`)
// needs a changed working copy in every language there is, and queues an
// email to every open account; a correction neither. Refused when no
// working copy changes anything.
async function publish(client, brand, kind, publishedBy, { substantial }) {
 if (typeof substantial !== 'boolean') throw new LegalError(400, 'Say whether this is a change (substantial: true, everyone is emailed) or a correction (substantial: false).');
 const doc = await findDocument(client, brand, kind);
 if (!doc) throw new LegalError(404, `No ${kind} document for ${brand}.`);
 await client.query('SELECT 1 FROM maleniti.legal_document WHERE document_id = $1 FOR UPDATE', [doc.document_id]);
 const latest = await latestPublication(client, doc.document_id);
 const current = latest ? await publicationTexts(client, latest.publication_id) : {};
 const { rows: drafts } = await client.query(
  'SELECT language_id, title, body, summary FROM maleniti.legal_draft WHERE document_id = $1',
  [doc.document_id]
 );
 const draftByLanguage = Object.fromEntries(drafts.map((d) => [d.language_id, d]));
 const languages = [...new Set([...Object.keys(current), ...Object.keys(draftByLanguage)])].sort();
 const texts = languages.map((lang) => {
  const draft = draftByLanguage[lang];
  const live = current[lang];
  if (!draft) return { lang, title: live.title, body: live.body, changed: false, summary: '' };
  const changed = !live || draft.title !== live.title || draft.body !== live.body;
  return { lang, title: draft.title, body: draft.body, changed, summary: changed ? draft.summary : '' };
 });
 const changedLanguages = texts.filter((t) => t.changed).map((t) => t.lang);
 if (!changedLanguages.length) throw new LegalError(409, 'Nothing to publish: no working copy differs from the published version.');
 if (substantial) {
  const { rows: allLanguages } = await client.query('SELECT language_id FROM maleniti.language ORDER BY language_id');
  const unchanged = allLanguages.map((l) => l.language_id).filter((lang) => !changedLanguages.includes(lang));
  if (unchanged.length) {
   throw new LegalError(409, `A change has to be made in every language - not changed yet: ${unchanged.join(', ')}. (A typo or mistranslation fix can be published as a correction.)`);
  }
 }

 const { rows: [publication] } = await client.query(
  'INSERT INTO maleniti.legal_publication (document_id, published_by, substantial) VALUES ($1, $2, $3) RETURNING publication_id, published_at, substantial',
  [doc.document_id, publishedBy || null, substantial]
 );
 for (const t of texts) {
  await client.query(
   `INSERT INTO maleniti.legal_publication_text (publication_id, language_id, title, body, changed, summary)
    VALUES ($1, $2, $3, $4, $5, $6)`,
   [publication.publication_id, t.lang, t.title, t.body, t.changed, t.summary]
  );
 }
 await client.query('DELETE FROM maleniti.legal_draft WHERE document_id = $1', [doc.document_id]);
 let recipients = 0;
 if (substantial) {
  ({ rowCount: recipients } = await client.query(
   `INSERT INTO atodo.legal_notice_emails (publication_id, account_id)
    SELECT $1, id FROM atodo.accounts WHERE closed_at IS NULL`,
   [publication.publication_id]
  ));
 }
 return { ...publication, changed_languages: changedLanguages, recipients };
}

// How often a notice email is tried before it counts as failed.
const MAX_SEND_ATTEMPTS = 5;

module.exports = {
 KINDS,
 LegalError,
 MAX_SEND_ATTEMPTS,
 publishedDocument,
 documentForAdmin,
 saveDraft,
 discardDraft,
 publish,
 publicationTexts,
};
