const crudResource = require('../lib/crudResource');

module.exports = crudResource({
 table: 'work_items',
 orderBy: 'sort_order',
 columns: [
  'sort_order', 'featured', 'slug', 'media_label_hr', 'media_label_en',
  'caption_hr', 'caption_en', 'status_label_hr', 'status_label_en',
  'title_hr', 'title_en', 'title_rest_hr', 'title_rest_en', 'body_hr', 'body_en',
  'chips', 'client_hr', 'client_en', 'duration_hr', 'duration_en',
  'users_hr', 'users_en', 'status_hr', 'status_en',
  'demo_url', 'demo_label_hr', 'demo_label_en', 'post_slug',
 ],
 required: ['featured', 'media_label_hr', 'media_label_en', 'caption_hr', 'caption_en'],
});
