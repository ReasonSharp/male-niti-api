const crypto = require('crypto');

// Date/amount formats the fiscalization specification (v2.7) requires. Every
// time is Croatian local time, whatever timezone the server runs in.

function zagrebParts(date) {
 const parts = Object.fromEntries(
  new Intl.DateTimeFormat('en-GB', {
   timeZone: 'Europe/Zagreb',
   year: 'numeric', month: '2-digit', day: '2-digit',
   hour: '2-digit', minute: '2-digit', second: '2-digit',
   hourCycle: 'h23',
  })
   .formatToParts(date)
   .filter((p) => p.type !== 'literal')
   .map((p) => [p.type, p.value])
 );
 return parts; // { day, month, year, hour, minute, second }, zero-padded
}

// "dd.mm.ggggThh:mm:ss" -- Zaglavlje/DatumVrijeme and Racun/DatVrijeme.
function xmlDateTime(date) {
 const p = zagrebParts(date);
 return `${p.day}.${p.month}.${p.year}T${p.hour}:${p.minute}:${p.second}`;
}

// "dd.MM.gggg HH:mm:ss" (a space, not a T) -- the ZKI input (appendix 12).
function zkiDateTime(date) {
 const p = zagrebParts(date);
 return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

// "GGGGMMDD_HHMM" -- the QR code's datv (section 2.7).
function qrDateTime(date) {
 const p = zagrebParts(date);
 return `${p.year}${p.month}${p.day}_${p.hour}${p.minute}`;
}

// Receipts are printed with Croatian local time too.
function receiptDateTime(date) {
 const p = zagrebParts(date);
 return `${p.day}.${p.month}.${p.year}. ${p.hour}:${p.minute}:${p.second}`;
}

// Decimal(15,2) with a point: 200 -> "2.00".
function amount(cents) {
 const sign = cents < 0 ? '-' : '';
 const abs = Math.abs(cents);
 return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// Zaštitni kod izdavatelja (ZKI), appendix 12: MD5 (hex, lowercase) of the
// RSA-SHA256 signature, with the issuer's private key, of
// OIB + issue time ("dd.MM.gggg HH:mm:ss") + receipt number + premises label
// + device label + total ("1245.56"), UTF-8 encoded.
function computeZki(keyPem, { oib, issuedAt, number, premises, device, totalCents }) {
 const input = `${oib}${zkiDateTime(issuedAt)}${number}${premises}${device}${amount(totalCents)}`;
 const signature = crypto.sign('sha256', Buffer.from(input, 'utf8'), keyPem);
 return crypto.createHash('md5').update(signature).digest('hex');
}

// The verification link printed as a QR code on every receipt (section 2.7):
// by JIR once there is one, else by ZKI; the amount in cents, no separators.
function verificationUrl({ jir, zki, issuedAt, totalCents }) {
 const id = jir ? `jir=${jir}` : `zki=${zki}`;
 return `https://porezna.gov.hr/rn?${id}&datv=${qrDateTime(issuedAt)}&izn=${totalCents}`;
}

module.exports = { xmlDateTime, zkiDateTime, qrDateTime, receiptDateTime, amount, computeZki, verificationUrl };
