const forge = require('node-forge');

// Fiscalization settings (Croatian B2C receipt fiscalization, "Fiskalizacija
// računa u krajnjoj potrošnji" -- see the Tax Administration's
// "Tehnička specifikacija za korisnike" v2.7, which this module follows),
// all from the environment:
//   FISCAL_CERT_P12_BASE64  the FINA fiscal certificate (.p12/.pfx), base64 --
//                           demo for the test environment, production for live
//   FISCAL_CERT_PASSWORD    its password
//   FISCAL_CIS_URL          default: the TEST service (see CIS_TEST_URL) --
//                           set to CIS_PROD_URL only with a production certificate
//   FISCAL_CIS_CA_BASE64    optional: base64 of a PEM bundle trusted for the CIS
//                           server's TLS certificate (FINA DEMO CA for test, FINA
//                           RDC for production), if not in Node's own store
//   FISCAL_OIB              the company's OIB (must match the certificate)
//   FISCAL_PREMISES         business premises label (oznaka poslovnog prostora,
//                           as registered in ePorezna) -- [0-9a-zA-Z]{1,20}
//   FISCAL_DEVICE           payment device label (oznaka naplatnog uređaja) --
//                           digits, no leading zero
//   FISCAL_OPERATOR_OIB     OIB of the operator issuing receipts (for an automated
//                           online shop, typically the company's own OIB)
//   FISCAL_SELLER_NAME      printed on receipts, e.g. "Male niti, obrt za ..."
//   FISCAL_SELLER_ADDRESS   printed on receipts
//   FISCAL_VAT_NOTE         printed on receipts, since the company is outside
//                           the VAT system -- default: see DEFAULT_VAT_NOTE
//
// loadFiscalConfig() returns { ok: true, ...settings, key, cert } or
// { ok: false, reason } -- never throws. Anything missing or invalid (no
// certificate, wrong password, expired, bad labels) means fiscalization is
// unavailable, and with it payments (see lib/atodo/payments.js).

const CIS_TEST_URL = 'https://cistest.apis-it.hr:8449/FiskalizacijaServiceTest';
const CIS_PROD_URL = 'https://cis.porezna-uprava.hr:8449/FiskalizacijaService';
const DEFAULT_VAT_NOTE = 'PDV nije obračunan temeljem čl. 90. st. 2. Zakona o PDV-u.';

// RFC 2253 order (most specific first), which is how X509IssuerName is
// written in the specification's own examples ("OU=DEMO,O=FINA,C=HR").
function issuerName(cert) {
 return cert.issuer.attributes
  .slice()
  .reverse()
  .map((a) => `${a.shortName || a.name}=${a.value}`)
  .join(',');
}

function loadCertificate(p12Base64, password) {
 const p12Der = forge.util.decode64(p12Base64);
 const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(p12Der), false, password);
 const keyBags = [
  ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
  ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
 ];
 const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
 const keyBag = keyBags.find((b) => b.key);
 if (!keyBag) throw new Error('no private key in the certificate file');
 // The signing certificate is the one whose public key matches the private key.
 const keyModulus = keyBag.key.n.toString(16);
 const certBag = certBags.find((b) => b.cert && b.cert.publicKey.n && b.cert.publicKey.n.toString(16) === keyModulus);
 if (!certBag) throw new Error('no certificate matching the private key');
 const cert = certBag.cert;
 const certDerBase64 = forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());
 return {
  keyPem: forge.pki.privateKeyToPem(keyBag.key),
  certPem: forge.pki.certificateToPem(cert),
  certDerBase64,
  issuerName: issuerName(cert),
  serialNumber: BigInt(`0x${cert.serialNumber}`).toString(10),
  notAfter: cert.validity.notAfter,
  subject: cert.subject.attributes.map((a) => `${a.shortName || a.name}=${a.value}`).join(','),
 };
}

function loadFiscalConfig(env = process.env) {
 const required = ['FISCAL_CERT_P12_BASE64', 'FISCAL_CERT_PASSWORD', 'FISCAL_OIB', 'FISCAL_PREMISES', 'FISCAL_DEVICE', 'FISCAL_OPERATOR_OIB', 'FISCAL_SELLER_NAME', 'FISCAL_SELLER_ADDRESS'];
 const missing = required.filter((k) => !env[k]);
 if (missing.length) return { ok: false, reason: `not configured (missing ${missing.join(', ')})` };
 if (!/^\d{11}$/.test(env.FISCAL_OIB) || !/^\d{11}$/.test(env.FISCAL_OPERATOR_OIB)) return { ok: false, reason: 'FISCAL_OIB/FISCAL_OPERATOR_OIB must be 11 digits' };
 if (!/^[0-9a-zA-Z]{1,20}$/.test(env.FISCAL_PREMISES)) return { ok: false, reason: 'FISCAL_PREMISES may only contain 0-9, a-z, A-Z (max 20)' };
 if (!/^[1-9]\d{0,19}$/.test(env.FISCAL_DEVICE)) return { ok: false, reason: 'FISCAL_DEVICE must be digits without a leading zero' };

 let certificate;
 try {
  certificate = loadCertificate(env.FISCAL_CERT_P12_BASE64, env.FISCAL_CERT_PASSWORD);
 } catch (err) {
  return { ok: false, reason: `certificate unusable: ${err.message}` };
 }
 if (certificate.notAfter.getTime() <= Date.now()) return { ok: false, reason: `certificate expired on ${certificate.notAfter.toISOString()}` };

 return {
  ok: true,
  cisUrl: env.FISCAL_CIS_URL || CIS_TEST_URL,
  // Receipts sent here are legally real -- see lib/atodo/payments.js for
  // how that's kept apart from Stripe's test mode.
  production: (env.FISCAL_CIS_URL || CIS_TEST_URL) === CIS_PROD_URL,
  cisCa: env.FISCAL_CIS_CA_BASE64 ? Buffer.from(env.FISCAL_CIS_CA_BASE64, 'base64').toString('utf8') : undefined,
  oib: env.FISCAL_OIB,
  premises: env.FISCAL_PREMISES,
  device: env.FISCAL_DEVICE,
  operatorOib: env.FISCAL_OPERATOR_OIB,
  sellerName: env.FISCAL_SELLER_NAME,
  sellerAddress: env.FISCAL_SELLER_ADDRESS,
  vatNote: env.FISCAL_VAT_NOTE || DEFAULT_VAT_NOTE,
  certificate,
 };
}

module.exports = { loadFiscalConfig, loadCertificate, CIS_TEST_URL, CIS_PROD_URL, DEFAULT_VAT_NOTE };
