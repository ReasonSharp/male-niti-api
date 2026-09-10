const express = require('express');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

function escapeXml(str) {
 return String(str ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');
}

router.get('/', asyncHandler(async (req, res) => {
 const lang = req.query.lang === 'en' ? 'en' : 'hr';

 const { rows } = await db.query(
  `SELECT slug, title_hr, title_en, lede_hr, lede_en, excerpt_hr, excerpt_en, published_at
   FROM blog_posts ORDER BY published_at DESC`
 );

 const items = rows.map((row) => {
  const title = lang === 'en' ? row.title_en : row.title_hr;
  const description = lang === 'en' ? (row.lede_en || row.excerpt_en) : (row.lede_hr || row.excerpt_hr);
  const link = `https://maleniti.com/blog-post.html?slug=${encodeURIComponent(row.slug)}`;

  return `  <item>
   <title>${escapeXml(title)}</title>
   <description>${escapeXml(description)}</description>
   <link>${escapeXml(link)}</link>
   <guid isPermaLink="false">${escapeXml(row.slug)}</guid>
   <pubDate>${new Date(row.published_at).toUTCString()}</pubDate>
  </item>`;
 }).join('\n');

 const description = lang === 'en'
  ? 'Latest posts from the Male Niti blog'
  : 'Najnoviji članci s Male Niti bloga';

 const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>Male Niti Blog</title>
  <link>https://maleniti.com/blog.html</link>
  <description>${escapeXml(description)}</description>
  <language>${lang}</language>
${items}
</channel>
</rss>`;

 res.set('Content-Type', 'application/rss+xml; charset=utf-8');
 res.send(xml);
}));

module.exports = router;
