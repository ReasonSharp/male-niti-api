-- Version 013: A-To-Do's user administration (the admin app's "A-To-Do
-- users" tab) and the end of undoing an email change from a link.
--
-- atodo.account_events records what happened to an account and when --
-- email and password changes, scheduled deletion, trials and subscription
-- changes it made, and support's own actions on it (lib/atodo/
-- accountEvents.js). Deleted with the account: a closed one keeps only its
-- email, password hash and trial status (Privacy Policy section 4).
--
-- An email change can no longer be undone from a link emailed to the old
-- address (that could be abused): whoever finds their email changed without
-- them writes to support, who sets it back from the admin app. The texts
-- that promised the link say so instead -- unless they've been edited
-- since, which this leaves alone -- and the undo flow's own texts go but
-- one, for an undo link still in someone's inbox.

CREATE TABLE atodo.account_events (
    event_id BIGSERIAL PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES atodo.accounts ON DELETE CASCADE,
    at TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX account_events_account ON atodo.account_events (account_id, at DESC);

UPDATE maleniti.translation t SET text = 'We sent a confirmation link to {email} (valid for 6 hours). Until you open it, keep logging in with {current}. {current} also got a notice, in case it wasn''t you.' FROM maleniti.translation_key k
WHERE k.trid = t.trid AND k.name = 'changeEmail.sent' AND t.language_id = 'en' AND t.text = 'We sent a confirmation link to {email} (valid for 6 hours). Until you open it, keep logging in with {current}. {current} also got a notice with a link to undo the change, in case it wasn''t you.';
UPDATE maleniti.translation t SET text = 'Poveznicu za potvrdu poslali smo na {email} (vrijedi 6 sati). Dok je ne otvorite, i dalje se prijavljujte s {current}. Na {current} stigla je i obavijest, za slučaj da to niste bili vi.' FROM maleniti.translation_key k
WHERE k.trid = t.trid AND k.name = 'changeEmail.sent' AND t.language_id = 'hr' AND t.text = 'Poveznicu za potvrdu poslali smo na {email} (vrijedi 6 sati). Dok je ne otvorite, i dalje se prijavljujte s {current}. Na {current} stigla je i obavijest s poveznicom za poništavanje promjene, za slučaj da to niste bili vi.';
UPDATE maleniti.translation t SET text = '<summary>How do I change my login email?</summary><div class="faq-answer"><p>In <strong>Settings</strong>, choose <strong>Change email…</strong>. We send a confirmation link to the new address, and a notice to your old one. If your login email was ever changed without your knowledge, write to us through the <a href="support.html?topic=account">support form</a> right away and we''ll help you get your account back.</p></div>' FROM maleniti.translation_key k
WHERE k.trid = t.trid AND k.name = 'faq.changeEmail' AND t.language_id = 'en' AND t.text = '<summary>How do I change my login email?</summary><div class="faq-answer"><p>In <strong>Settings</strong>, choose <strong>Change email…</strong>. We send a confirmation link to the new address; your old address gets a link to undo the change, in case it wasn''t you.</p></div>';
UPDATE maleniti.translation t SET text = '<summary>Kako promijeniti e-mail za prijavu?</summary><div class="faq-answer"><p>U <strong>Postavkama</strong> odaberite <strong>Promijeni e-poštu…</strong>. Na novu adresu šaljemo poveznicu za potvrdu, a na staru obavijest. Ako vam je e-mail za prijavu ikad promijenjen bez vašeg znanja, odmah nam pišite putem <a href="support.html?topic=account">obrasca za podršku</a> i pomoći ćemo vam vratiti račun.</p></div>' FROM maleniti.translation_key k
WHERE k.trid = t.trid AND k.name = 'faq.changeEmail' AND t.language_id = 'hr' AND t.text = '<summary>Kako promijeniti e-mail za prijavu?</summary><div class="faq-answer"><p>U <strong>Postavkama</strong> odaberite <strong>Promijeni e-poštu…</strong>. Na novu adresu šaljemo poveznicu za potvrdu, a na staru poveznicu za poništavanje promjene, za slučaj da je niste vi zatražili.</p></div>';

DELETE FROM maleniti.translation_key
WHERE name LIKE 'undoEmailChange.%' AND brand_id = (SELECT brand_id FROM maleniti.brand WHERE code = 'atodo');

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

SELECT pg_temp.ui('app', 'undoEmailChange.unavailable', 'Undoing an email change from a link is no longer possible. If your login email was changed without your knowledge, write to support and we''ll help you get your account back.', 'Poništavanje promjene e-pošte putem poveznice više nije moguće. Ako vam je e-mail za prijavu promijenjen bez vašeg znanja, pišite podršci i pomoći ćemo vam vratiti račun.');
