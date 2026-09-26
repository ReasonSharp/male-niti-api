const crypto = require('crypto');
const https = require('https');
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('@xmldom/xmldom');
const { xmlDateTime, amount } = require('./format');

// Building, signing and sending a RacunZahtjev (B2C receipt) to the
// Tax Administration's fiscalization service (CIS), per the "Tehnička
// specifikacija za korisnike" v2.7:
//  - section 2.1.1: the data set and element order (below);
//  - section 7: an enveloped XML signature of the root element --
//    exclusive C14N, RSA-SHA256, SHA-256 digest, Reference to the root's Id,
//    KeyInfo with the certificate and its issuer/serial;
//  - section 6.1: the SOAP endpoints (see config.js).

const NS = 'http://www.apis-it.hr/fin/2012/types/f73';
const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';

const escapeXml = (s) =>
 String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// Unsigned RacunZahtjev. The company is outside the VAT system (USustPdv
// false): no Pdv/Pnp/OstaliPor/exemption elements, just the total. Payment
// by card (NacinPlac K). messageId is new for every send, a late re-send
// included (section 2.1.1: "svaka poruka ... mora sadržavati različiti ID").
function buildRacunZahtjev({ messageId, sentAt, oib, issuedAt, number, premises, device, totalCents, operatorOib, zki, lateDelivery }) {
 return (
  `<tns:RacunZahtjev xmlns:tns="${NS}" Id="RacunZahtjev">` +
  '<tns:Zaglavlje>' +
  `<tns:IdPoruke>${escapeXml(messageId)}</tns:IdPoruke>` +
  `<tns:DatumVrijeme>${xmlDateTime(sentAt)}</tns:DatumVrijeme>` +
  '</tns:Zaglavlje>' +
  '<tns:Racun>' +
  `<tns:Oib>${escapeXml(oib)}</tns:Oib>` +
  '<tns:USustPdv>false</tns:USustPdv>' +
  `<tns:DatVrijeme>${xmlDateTime(issuedAt)}</tns:DatVrijeme>` +
  // Numbering is kept per payment device (see receipts.js), hence N.
  '<tns:OznSlijed>N</tns:OznSlijed>' +
  '<tns:BrRac>' +
  `<tns:BrOznRac>${number}</tns:BrOznRac>` +
  `<tns:OznPosPr>${escapeXml(premises)}</tns:OznPosPr>` +
  `<tns:OznNapUr>${escapeXml(device)}</tns:OznNapUr>` +
  '</tns:BrRac>' +
  `<tns:IznosUkupno>${amount(totalCents)}</tns:IznosUkupno>` +
  '<tns:NacinPlac>K</tns:NacinPlac>' +
  `<tns:OibOper>${escapeXml(operatorOib)}</tns:OibOper>` +
  `<tns:ZastKod>${escapeXml(zki)}</tns:ZastKod>` +
  `<tns:NakDost>${lateDelivery ? 'true' : 'false'}</tns:NakDost>` +
  '</tns:Racun>' +
  '</tns:RacunZahtjev>'
 );
}

function signRacunZahtjev(xml, certificate) {
 const sig = new SignedXml({
  privateKey: certificate.keyPem,
  signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  canonicalizationAlgorithm: EXC_C14N,
  getKeyInfoContent: () =>
   '<X509Data>' +
   `<X509Certificate>${certificate.certDerBase64}</X509Certificate>` +
   '<X509IssuerSerial>' +
   `<X509IssuerName>${escapeXml(certificate.issuerName)}</X509IssuerName>` +
   `<X509SerialNumber>${certificate.serialNumber}</X509SerialNumber>` +
   '</X509IssuerSerial>' +
   '</X509Data>',
 });
 sig.addReference({
  xpath: "/*[local-name(.)='RacunZahtjev']",
  transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', EXC_C14N],
  digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
 });
 // Inside the root, after Racun -- where the schema puts ds:Signature.
 sig.computeSignature(xml, { location: { reference: "/*[local-name(.)='RacunZahtjev']/*[local-name(.)='Racun']", action: 'after' } });
 return sig.getSignedXml();
}

function soapEnvelope(bodyXml) {
 return (
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
  `<soapenv:Body>${bodyXml}</soapenv:Body>` +
  '</soapenv:Envelope>'
 );
}

function postSoap(url, body, { ca, timeoutMs }) {
 return new Promise((resolve, reject) => {
  const req = https.request(
   url,
   {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(body), SOAPAction: '' },
    ca,
    minVersion: 'TLSv1.2', // TLS 1.1 is no longer accepted (v2.7)
    timeout: timeoutMs,
   },
   (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
   }
  );
  req.on('timeout', () => req.destroy(new Error(`no response from CIS within ${timeoutMs} ms`)));
  req.on('error', reject);
  req.end(body);
 });
}

// RacunOdgovor: a Jir, or Greske/Greska (SifraGreske + PorukaGreske).
function parseRacunOdgovor(xml) {
 // Not XML at all (e.g. a proxy's error page): no JIR, no CIS errors either.
 if (!/^\s*</.test(xml)) return { jir: null, errors: [] };
 const doc = new DOMParser().parseFromString(xml, 'text/xml');
 const text = (el, name) => {
  const found = el.getElementsByTagNameNS(NS, name)[0];
  return found ? found.textContent.trim() : null;
 };
 const jir = text(doc, 'Jir');
 const errors = Array.from(doc.getElementsByTagNameNS(NS, 'Greska')).map((g) => ({ code: text(g, 'SifraGreske'), message: text(g, 'PorukaGreske') }));
 const fault = doc.getElementsByTagName('faultstring')[0];
 if (!jir && !errors.length && fault) errors.push({ code: 'soap-fault', message: fault.textContent.trim() });
 return { jir, errors };
}

// Sends one receipt. Resolves { jir } on success, or { errors } if CIS
// rejected it; rejects only on transport failure (no answer at all). Either
// non-JIR outcome leaves the receipt to be re-sent as a late delivery.
async function fiscalizeReceipt(config, receipt, { lateDelivery = false, timeoutMs = 10000 } = {}) {
 const unsigned = buildRacunZahtjev({
  messageId: crypto.randomUUID(),
  sentAt: new Date(),
  oib: config.oib,
  issuedAt: receipt.issuedAt,
  number: receipt.number,
  premises: receipt.premises,
  device: receipt.device,
  totalCents: receipt.totalCents,
  operatorOib: config.operatorOib,
  zki: receipt.zki,
  lateDelivery,
 });
 const signed = signRacunZahtjev(unsigned, config.certificate);
 const response = await postSoap(config.cisUrl, soapEnvelope(signed), { ca: config.cisCa, timeoutMs });
 const parsed = parseRacunOdgovor(response.body);
 if (parsed.jir) return { jir: parsed.jir };
 return { errors: parsed.errors.length ? parsed.errors : [{ code: `http-${response.status}`, message: response.body.slice(0, 300) }] };
}

module.exports = { buildRacunZahtjev, signRacunZahtjev, soapEnvelope, parseRacunOdgovor, fiscalizeReceipt };
