-- Reverts version 010: the interface texts go (the client of version 009
-- had them built in), and with them every language but English and
-- Croatian -- an account that used one goes back to choosing.

DELETE FROM maleniti.translation_key WHERE name IS NOT NULL;
DELETE FROM maleniti.language WHERE language_id NOT IN ('en', 'hr');

ALTER TABLE atodo.accounts
    DROP CONSTRAINT accounts_language_fkey,
    ADD CONSTRAINT accounts_language_check CHECK (language IN ('en', 'hr'));

ALTER TABLE maleniti.translation
    DROP CONSTRAINT translation_language_id_fkey,
    ADD CONSTRAINT translation_language_id_fkey FOREIGN KEY (language_id) REFERENCES maleniti.language;

DROP INDEX maleniti.translation_key_name;

ALTER TABLE maleniti.translation_key
    DROP CONSTRAINT translation_key_named,
    DROP COLUMN brand_id,
    DROP COLUMN bundle,
    DROP COLUMN name;
