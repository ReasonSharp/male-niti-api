const crudResource = require('../lib/crudResource');

module.exports = crudResource({
 table: 'services',
 orderBy: 'sort_order',
 columns: [
  'sort_order', 'tone', 'roman', 'num_hr', 'num_en', 'title_hr', 'title_en',
  'title2_hr', 'title2_en', 'body_hr', 'body_en', 'list_hr', 'list_en',
 ],
 required: [
  'tone', 'roman', 'num_hr', 'num_en', 'title_hr', 'title_en',
  'title2_hr', 'title2_en', 'body_hr', 'body_en', 'list_hr', 'list_en',
 ],
});
