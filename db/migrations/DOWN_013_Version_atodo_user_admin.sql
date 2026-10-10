-- Reverts version 013: the account event log goes, and the email-change
-- texts promise the undo link again (if unedited since), with the undo
-- flow's texts back.

DROP TABLE atodo.account_events;

UPDATE maleniti.translation t SET text = 'We sent a confirmation link to {email} (valid for 6 hours). Until you open it, keep logging in with {current}. {current} also got a notice with a link to undo the change, in case it wasn''t you.' FROM maleniti.translation_key k
WHERE k.trid = t.trid AND k.name = 'changeEmail.sent' AND t.language_id = 'en' AND t.text = 'We sent a confirmation link to {email} (valid for 6 hours). Until you open it, keep logging in with {current}. {current} also got a notice, in case it wasn''t you.';
UPDATE maleniti.translation t SET text = 'Poveznicu za potvrdu poslali smo na {email} (vrijedi 6 sati). Dok je ne otvorite, i dalje se prijavljujte s {current}. Na {current} stigla je i obavijest s poveznicom za poništavanje promjene, za slučaj da to niste bili vi.' FROM maleniti.translation_key k
WHERE k.trid = t.trid AND k.name = 'changeEmail.sent' AND t.language_id = 'hr' AND t.text = 'Poveznicu za potvrdu poslali smo na {email} (vrijedi 6 sati). Dok je ne otvorite, i dalje se prijavljujte s {current}. Na {current} stigla je i obavijest, za slučaj da to niste bili vi.';
UPDATE maleniti.translation t SET text = '<summary>How do I change my login email?</summary><div class="faq-answer"><p>In <strong>Settings</strong>, choose <strong>Change email…</strong>. We send a confirmation link to the new address; your old address gets a link to undo the change, in case it wasn''t you.</p></div>' FROM maleniti.translation_key k
WHERE k.trid = t.trid AND k.name = 'faq.changeEmail' AND t.language_id = 'en' AND t.text = '<summary>How do I change my login email?</summary><div class="faq-answer"><p>In <strong>Settings</strong>, choose <strong>Change email…</strong>. We send a confirmation link to the new address, and a notice to your old one. If your login email was ever changed without your knowledge, write to us through the <a href="support.html?topic=account">support form</a> right away and we''ll help you get your account back.</p></div>';
UPDATE maleniti.translation t SET text = '<summary>Kako promijeniti e-mail za prijavu?</summary><div class="faq-answer"><p>U <strong>Postavkama</strong> odaberite <strong>Promijeni e-poštu…</strong>. Na novu adresu šaljemo poveznicu za potvrdu, a na staru poveznicu za poništavanje promjene, za slučaj da je niste vi zatražili.</p></div>' FROM maleniti.translation_key k
WHERE k.trid = t.trid AND k.name = 'faq.changeEmail' AND t.language_id = 'hr' AND t.text = '<summary>Kako promijeniti e-mail za prijavu?</summary><div class="faq-answer"><p>U <strong>Postavkama</strong> odaberite <strong>Promijeni e-poštu…</strong>. Na novu adresu šaljemo poveznicu za potvrdu, a na staru obavijest. Ako vam je e-mail za prijavu ikad promijenjen bez vašeg znanja, odmah nam pišite putem <a href="support.html?topic=account">obrasca za podršku</a> i pomoći ćemo vam vratiti račun.</p></div>';

DELETE FROM maleniti.translation_key
WHERE name LIKE 'undoEmailChange.%' AND brand_id = (SELECT brand_id FROM maleniti.brand WHERE code = 'atodo');

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

SELECT pg_temp.ui('app', 'undoEmailChange.done', 'Your login email is {email} again, and your new password is set.', 'Vaša e-pošta za prijavu ponovno je {email}, a nova lozinka je postavljena.');
SELECT pg_temp.ui('app', 'undoEmailChange.intro', 'Your login email is {email} again, and every session has been signed out. Whoever changed it may know your password, so choose a new one now.', 'Vaša e-pošta za prijavu ponovno je {email}, a sve su sesije odjavljene. Tko god ju je promijenio možda zna vašu lozinku, pa odmah odaberite novu.');
SELECT pg_temp.ui('app', 'undoEmailChange.invalid', 'That undo link is invalid, has expired, or has already been used.', 'Poveznica za poništavanje nije ispravna, istekla je ili je već iskorištena.');
SELECT pg_temp.ui('app', 'undoEmailChange.resetExpired', 'That password reset has expired. Log in with your current password and change it in Settings.', 'Postavljanje lozinke je isteklo. Prijavite se trenutnom lozinkom i promijenite je u Postavkama.');
SELECT pg_temp.ui('app', 'undoEmailChange.skipped', 'Your login email is {email} again, and every session has been signed out. You can still log in with your current password -- change it in Settings as soon as you can.', 'Vaša e-pošta za prijavu ponovno je {email}, a sve su sesije odjavljene. I dalje se možete prijaviti trenutnom lozinkom -- promijenite je u Postavkama čim prije.');
SELECT pg_temp.ui('app', 'undoEmailChange.submit', 'Set new password', 'Postavi novu lozinku');
SELECT pg_temp.ui('app', 'undoEmailChange.taken', 'Your previous address now belongs to another account, so it couldn''t be restored. Please contact support.', 'Vaša prethodna adresa sada pripada drugom računu, pa je nije bilo moguće vratiti. Obratite se podršci.');
SELECT pg_temp.ui('app', 'undoEmailChange.title', 'Email change undone -- set a new password', 'Promjena e-pošte poništena -- postavite novu lozinku');
