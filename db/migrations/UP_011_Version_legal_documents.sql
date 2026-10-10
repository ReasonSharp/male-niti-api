-- Version 011: A-To-Do's Privacy Policy and Terms of Service become legal
-- documents of their own, out of the interface texts (migration 010) --
-- edited in the admin app's Legal tab as a working copy per language, and
-- published, every language at once, as a new version:
--
--   legal_document          one per brand and kind ('privacy', 'terms')
--   legal_draft             a language's working copy -- title, body (HTML)
--                           and a short summary of what's changed (for the
--                           email); none of it shown until published
--   legal_publication       a published version, from published_at on
--                           (the page's "Last updated" date -- the same in
--                           every language); every earlier one is kept
--   legal_publication_text  the version in each language, which languages
--                           it changed and their summaries
--
-- Publishing also emails every open A-To-Do account about it, in its own
-- language (atodo.legal_notice_emails, one row per account, sent in the
-- background and retried until it goes -- see lib/atodo/legalNotices.js).
-- The email's texts are interface texts (bundle 'email'); so is the pages'
-- "Last updated: {date}" label (common). A date is written out in the
-- text's language ("10. listopada 2026." -- a Croatian one brings its own
-- full stop, so no sentence ends on one after it).
--
-- Seeded with the texts the pages had, as published on 8 October 2026 --
-- each language's sections (intro, s1, s2...) joined into one body -- and
-- those texts then removed from the interface texts.

CREATE TABLE maleniti.legal_document (
    document_id SERIAL PRIMARY KEY,
    brand_id INT NOT NULL REFERENCES maleniti.brand,
    kind TEXT NOT NULL CHECK (kind IN ('privacy', 'terms')),
    UNIQUE (brand_id, kind)
);

CREATE TABLE maleniti.legal_draft (
    document_id INT NOT NULL REFERENCES maleniti.legal_document ON DELETE CASCADE,
    language_id TEXT NOT NULL REFERENCES maleniti.language ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (document_id, language_id)
);

CREATE TABLE maleniti.legal_publication (
    publication_id SERIAL PRIMARY KEY,
    document_id INT NOT NULL REFERENCES maleniti.legal_document ON DELETE CASCADE,
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The admin API key's label that published it.
    published_by TEXT
);

CREATE INDEX legal_publication_document ON maleniti.legal_publication (document_id, published_at DESC);

CREATE TABLE maleniti.legal_publication_text (
    publication_id INT NOT NULL REFERENCES maleniti.legal_publication ON DELETE CASCADE,
    language_id TEXT NOT NULL REFERENCES maleniti.language ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    changed BOOLEAN NOT NULL DEFAULT false,
    summary TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (publication_id, language_id)
);

CREATE TABLE atodo.legal_notice_emails (
    publication_id INT NOT NULL REFERENCES maleniti.legal_publication ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES atodo.accounts ON DELETE CASCADE,
    sent_at TIMESTAMPTZ,
    attempts INT NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    last_error TEXT,
    PRIMARY KEY (publication_id, account_id)
);

CREATE INDEX legal_notice_emails_pending ON atodo.legal_notice_emails (publication_id) WHERE sent_at IS NULL;

INSERT INTO maleniti.legal_document (brand_id, kind)
SELECT brand_id, kind FROM maleniti.brand, unnest(ARRAY['privacy', 'terms']) AS kind WHERE code = 'atodo';

INSERT INTO maleniti.legal_publication (document_id, published_at, published_by)
SELECT document_id, '2026-10-08 00:00:00+02', 'migration 011' FROM maleniti.legal_document;

INSERT INTO maleniti.legal_publication_text (publication_id, language_id, title, body)
SELECT publication_id, language_id, title, body FROM (
    SELECT p.publication_id, t.language_id,
           max(t.text) FILTER (WHERE k.name = d.kind || '.pageTitle') AS title,
           string_agg(t.text, E'\n' ORDER BY CASE WHEN k.name = d.kind || '.intro' THEN 0 ELSE substring(k.name FROM '\.s(\d+)$')::int END)
               FILTER (WHERE k.name ~ ('^' || d.kind || '\.(intro|s\d+)$')) AS body
    FROM maleniti.legal_document d
    JOIN maleniti.legal_publication p USING (document_id)
    JOIN maleniti.translation_key k ON k.brand_id = d.brand_id AND k.bundle = d.kind
    JOIN maleniti.translation t ON t.trid = k.trid
    GROUP BY p.publication_id, t.language_id
) texts
WHERE title IS NOT NULL AND body IS NOT NULL;

DELETE FROM maleniti.translation_key
WHERE bundle IN ('privacy', 'terms') AND brand_id = (SELECT brand_id FROM maleniti.brand WHERE code = 'atodo');

-- One A-To-Do interface text in English and Croatian; only for this script.
CREATE FUNCTION pg_temp.ui(bundle TEXT, name TEXT, en TEXT, hr TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    new_trid INT;
BEGIN
    INSERT INTO maleniti.translation_key (brand_id, bundle, name)
    SELECT brand_id, ui.bundle, ui.name FROM maleniti.brand WHERE code = 'atodo'
    RETURNING trid INTO new_trid;
    INSERT INTO maleniti.translation (trid, language_id, text) VALUES
        (new_trid, 'en', en),
        (new_trid, 'hr', hr);
END;
$$;

SELECT pg_temp.ui('common', 'legal.lastUpdated', 'Last updated: {date}', 'Zadnje ažurirano: {date}');
SELECT pg_temp.ui('common', 'legal.unavailable', 'This document can''t be loaded right now - please try again later.', 'Ovaj dokument trenutno nije moguće učitati - pokušajte ponovno kasnije.');

SELECT pg_temp.ui('email', 'email.privacyChanged.subject', 'We''ve updated our Privacy Policy', 'Ažurirali smo Pravila privatnosti');
SELECT pg_temp.ui('email', 'email.privacyChanged.intro', 'We''ve updated the A-To-Do Privacy Policy. The new version applies from {date}.', 'Ažurirali smo Pravila privatnosti aplikacije A-To-Do. Nova verzija vrijedi od {date}');
SELECT pg_temp.ui('email', 'email.privacyChanged.action', 'Read the Privacy Policy', 'Pročitajte Pravila privatnosti');
SELECT pg_temp.ui('email', 'email.privacyChanged.continuedUse', 'By continuing to use A-To-Do, you agree to the updated Privacy Policy.', 'Nastavkom korištenja aplikacije A-To-Do prihvaćate ažurirana Pravila privatnosti.');
SELECT pg_temp.ui('email', 'email.termsChanged.subject', 'We''ve updated our Terms of Service', 'Ažurirali smo Uvjete korištenja');
SELECT pg_temp.ui('email', 'email.termsChanged.intro', 'We''ve updated the A-To-Do Terms of Service. The new version applies from {date}.', 'Ažurirali smo Uvjete korištenja aplikacije A-To-Do. Nova verzija vrijedi od {date}');
SELECT pg_temp.ui('email', 'email.termsChanged.action', 'Read the Terms of Service', 'Pročitajte Uvjete korištenja');
SELECT pg_temp.ui('email', 'email.termsChanged.continuedUse', 'By continuing to use A-To-Do, you agree to the updated Terms of Service.', 'Nastavkom korištenja aplikacije A-To-Do prihvaćate ažurirane Uvjete korištenja.');
SELECT pg_temp.ui('email', 'email.legalChange.summaryHeading', 'What''s changed:', 'Što se promijenilo:');
SELECT pg_temp.ui('email', 'email.legalChange.refund', 'If you don''t agree with the changes, you have the right to a refund of any charges made between {from} and {to} - 14 days before and after the change. To ask for one, write to us through the support form ({supportUrl}) or at support@maleniti.com.', 'Ako se ne slažete s promjenama, imate pravo na povrat novca za sve naplate izvršene između {from} i {to} - 14 dana prije i nakon promjene. Zatražite ga putem obrasca za podršku ({supportUrl}) ili na support@maleniti.com.');
