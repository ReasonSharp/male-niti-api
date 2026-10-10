const assert = require('node:assert');
const { buildLegalNoticeEmail } = require('../../lib/atodo/legalNotices');

const strings = {
 'email.termsChanged.subject': "We've updated our Terms of Service",
 'email.termsChanged.intro': 'The new version applies from {date}.',
 'email.termsChanged.action': 'Read the Terms of Service',
 'email.termsChanged.continuedUse': 'By continuing to use A-To-Do, you agree.',
 'email.legalChange.summaryHeading': "What's changed:",
 'email.legalChange.refund': 'Refund of charges between {from} and {to} ({supportUrl}).',
};
const base = {
 kind: 'terms',
 language: 'en',
 strings,
 publishedAt: '2026-11-20T10:00:00Z',
 documentUrl: 'https://atodo.example/terms.html?lang=en',
 supportUrl: 'https://atodo.example/support.html?lang=en&topic=billing',
};

const email = buildLegalNoticeEmail({ ...base, summary: 'Prices are now shown with anchor prices.\n\nA second\nchange.' });
assert.strictEqual(email.subject, "We've updated our Terms of Service", 'subject');
assert.ok(email.text.includes('The new version applies from 20 November 2026.'), 'the publication date, written out');
assert.ok(email.text.includes('Refund of charges between 6 November 2026 and 4 December 2026'), '14 days before and after');
assert.ok(email.text.includes('(https://atodo.example/support.html?lang=en&topic=billing)'), 'the support link in the refund text');
assert.ok(email.text.includes("What's changed:\n\nPrices are now shown with anchor prices.\n\nA second change."), 'the summary, a paragraph each, lines joined');
assert.ok(email.text.includes('https://atodo.example/terms.html?lang=en'), "the document's link");
assert.ok(email.text.includes('By continuing to use A-To-Do, you agree.'), 'continued use');
assert.ok(email.html.includes('<html lang="en"') || email.html.includes('lang="en"'), 'html in the language');
assert.ok(!email.html.includes('<script'), 'nothing unexpected');

const noSummary = buildLegalNoticeEmail({ ...base, summary: '   ' });
assert.ok(!noSummary.text.includes("What's changed:"), 'no summary, no heading for it');

const hr = buildLegalNoticeEmail({ ...base, language: 'hr', summary: '' });
assert.ok(hr.text.includes('20. studenoga 2026.'), 'a Croatian date');

const unescaped = buildLegalNoticeEmail({ ...base, summary: 'Section <b>4</b> & more' });
assert.ok(unescaped.html.includes('Section &lt;b&gt;4&lt;/b&gt; &amp; more'), "the summary is text, escaped in html");

console.log('legalNotices.test.js: all assertions passed');
