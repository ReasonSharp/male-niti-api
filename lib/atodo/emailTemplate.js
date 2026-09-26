// Builds both parts of an atodo email from one description, so every message
// looks the same and neither part can drift from the other:
//  - html: a complete HTML document (doctype, head, body) with a simple
//    table layout and inline styles -- what email clients reliably render --
//    and the main link as a button, with the full URL also printed as plain
//    text right under it for when the button doesn't work;
//  - text: the plain-text alternative for clients that don't show HTML,
//    with the URL on a line of its own so it can be copied as-is.
//
// renderEmail({ heading, paragraphs, details, action: { label, url },
//              image: { cid, alt, caption }, afterAction, lang })
//   heading      one line, also the document's <title>
//   paragraphs   plain-text paragraphs before the button (escaped for html)
//   details      optional [label, value] rows, shown as a two-column table
//                (e.g. a receipt's fields)
//   action       optional: the main link
//   image        optional: an inline image attached under Content-ID `cid`
//                (see mailer.js's attachments), with a caption under it --
//                e.g. a receipt's QR code
//   afterAction  optional plain-text paragraphs after it (e.g. "ignore this
//                email if...")
//   lang         the document's language (default 'en')
// Returns { text, html }.

const escapeHtml = (s) =>
 String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function renderEmail({ heading, paragraphs = [], details = [], action = null, image = null, afterAction = [], lang = 'en' }) {
 const text = [
  heading,
  '',
  ...paragraphs.flatMap((p) => [p, '']),
  ...(details.length ? [...details.map(([label, value]) => `${label}: ${value}`), ''] : []),
  ...(action ? [`${action.label}:`, action.url, ''] : []),
  ...(image && image.caption ? [image.caption, ''] : []),
  ...afterAction.flatMap((p) => [p, '']),
  '-- A-To-Do',
 ].join('\n');

 const para = (p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#202124;">${escapeHtml(p)}</p>`;
 const url = action ? escapeHtml(action.url) : '';
 const actionHtml = action
  ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px;">
       <tr><td style="border-radius:6px;background:#1a73e8;">
         <a href="${url}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(action.label)}</a>
       </td></tr>
     </table>
     <p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:#5f6368;">If the button doesn't work, copy and paste this link into your browser:</p>
     <p style="margin:0 0 20px;font-size:13px;line-height:1.5;word-break:break-all;"><a href="${url}" style="color:#1a73e8;">${url}</a></p>`
  : '';

 const detailsHtml = details.length
  ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px;border-collapse:collapse;">
       ${details
        .map(
         ([label, value]) =>
          `<tr><td style="padding:5px 12px 5px 0;font-size:13px;color:#5f6368;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>` +
          `<td style="padding:5px 0;font-size:13px;color:#202124;word-break:break-all;">${escapeHtml(value)}</td></tr>`
        )
        .join('\n       ')}
     </table>`
  : '';
 const imageHtml = image
  ? `<p style="margin:0 0 8px;"><img src="cid:${escapeHtml(image.cid)}" alt="${escapeHtml(image.alt || '')}" width="160" height="160" style="display:block;width:160px;height:160px;"></p>
     ${image.caption ? `<p style="margin:0 0 20px;font-size:12px;line-height:1.5;color:#5f6368;">${escapeHtml(image.caption)}</p>` : ''}`
  : '';

 const html = `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f3f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f3f4;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:10px;">
      <tr><td style="padding:32px 32px 24px;font-family:${FONT};">
        <h1 style="margin:0 0 20px;font-size:20px;line-height:1.3;color:#202124;">${escapeHtml(heading)}</h1>
        ${paragraphs.map(para).join('\n        ')}
        ${detailsHtml}
        ${actionHtml}
        ${imageHtml}
        ${afterAction.map(para).join('\n        ')}
      </td></tr>
      <tr><td style="padding:0 32px 28px;font-family:${FONT};font-size:12px;color:#80868b;">A-To-Do</td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

 return { text, html };
}

module.exports = { renderEmail };
