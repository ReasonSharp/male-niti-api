-- Reverts version 011: the Privacy Policy and Terms of Service go back to
-- being interface texts (the keys version 010's client reads), from their
-- latest published version -- each language's whole body as the intro,
-- the numbered sections empty, "Last updated" with an ISO date. Their
-- earlier versions, working copies and the notice emails' record go.

DELETE FROM maleniti.translation_key
WHERE brand_id = (SELECT brand_id FROM maleniti.brand WHERE code = 'atodo')
  AND (bundle = 'email' OR name IN ('legal.lastUpdated', 'legal.unavailable'));

CREATE TEMP TABLE restored_key ON COMMIT DROP AS
WITH latest AS (
    SELECT DISTINCT ON (d.document_id) d.document_id, d.brand_id, d.kind, p.publication_id, p.published_at
    FROM maleniti.legal_document d
    JOIN maleniti.legal_publication p USING (document_id)
    ORDER BY d.document_id, p.published_at DESC
)
SELECT latest.*, names.name, nextval('maleniti.translation_key_trid_seq')::int AS trid
FROM latest
CROSS JOIN LATERAL (
    SELECT latest.kind || '.pageTitle'
    UNION ALL SELECT latest.kind || '.updated'
    UNION ALL SELECT latest.kind || '.intro'
    UNION ALL SELECT latest.kind || '.s' || i FROM generate_series(1, CASE latest.kind WHEN 'privacy' THEN 9 ELSE 13 END) AS i
) AS names (name);

INSERT INTO maleniti.translation_key (trid, brand_id, bundle, name)
SELECT trid, brand_id, kind, name FROM restored_key;

INSERT INTO maleniti.translation (trid, language_id, text)
SELECT r.trid, t.language_id,
       CASE
           WHEN r.name LIKE '%.pageTitle' THEN t.title
           WHEN r.name LIKE '%.updated' THEN
               CASE t.language_id WHEN 'hr' THEN 'Zadnje ažurirano: ' ELSE 'Last updated: ' END
               || to_char(r.published_at AT TIME ZONE 'Europe/Zagreb', 'YYYY-MM-DD')
           WHEN r.name LIKE '%.intro' THEN t.body
           ELSE ''
       END
FROM restored_key r
JOIN maleniti.legal_publication_text t ON t.publication_id = r.publication_id;

DROP TABLE atodo.legal_notice_emails;
DROP TABLE maleniti.legal_publication_text;
DROP TABLE maleniti.legal_publication;
DROP TABLE maleniti.legal_draft;
DROP TABLE maleniti.legal_document;
