const crudResource = require('../lib/crudResource');

module.exports = crudResource({
 table: 'pricing_plans',
 orderBy: 'sort_order',
 columns: [
  'sort_order', 'tag_hr', 'tag_en', 'title_hr', 'title_en', 'em_hr', 'em_en',
  'sub_hr', 'sub_en', 'list_hr', 'list_en', 'when_hr', 'when_en', 'featured',
 ],
 required: [
  'tag_hr', 'tag_en', 'title_hr', 'title_en', 'sub_hr', 'sub_en',
  'list_hr', 'list_en', 'when_hr', 'when_en', 'featured',
 ],
});
