const { getAppConfig } = require('./catalog/catalog-read-model');
const {
  createCategory,
  updateCategory,
} = require('./catalog/category-commands');
const {
  createQuestion,
  updateQuestion,
} = require('./catalog/question-commands');
const {
  createOption,
  updateOption,
} = require('./catalog/option-commands');
const {
  setOptionArchived,
  updateQuestionsOrder,
  deleteCatalogItem,
} = require('./catalog/catalog-lifecycle-commands');

module.exports = {
  getAppConfig,
  createCategory,
  updateCategory,
  createQuestion,
  updateQuestion,
  createOption,
  updateOption,
  setOptionArchived,
  updateQuestionsOrder,
  deleteCatalogItem,
};
