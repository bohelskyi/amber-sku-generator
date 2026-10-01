const c = require('./binding-contract');
const { normalizePath } = require('./sync-preview-categories');

// Migration 041's bounded per-binding evidence JSON holds category decisions.
// It belongs only to the category transport binding, never an EAV option domain.
function normalizeCategories(rows) {
  return c.unique(c.list(rows, 100).map((r) => {
    c.command(r, ['requestedPath', 'normalizedPath', 'categoryId', 'candidates', 'reviewState'], ['note']);
    if (r.note !== undefined && (typeof r.note !== 'string' || r.note.length > 2000)) c.invalid();
    if (typeof r.requestedPath !== 'string' || !r.requestedPath || r.requestedPath.length > 4096
      || r.normalizedPath !== normalizePath(r.requestedPath)
      || !['proposed', 'review_required', 'approved', 'blocked'].includes(r.reviewState)) c.invalid();
    const candidates = c.unique(c.list(r.candidates, 100).map((v) => {
      c.command(v, ['categoryId', 'path']);
      if (typeof v.categoryId !== 'string' || !/^[1-9][0-9]*$/.test(v.categoryId)
        || !Number.isSafeInteger(Number(v.categoryId)) || typeof v.path !== 'string'
        || v.path.length > 4096 || normalizePath(v.path) !== r.normalizedPath) c.invalid();
      return v;
    }), (v) => v.categoryId);
    if (r.categoryId !== null && !candidates.some((v) => v.categoryId === r.categoryId)) c.invalid();
    if (['proposed', 'approved'].includes(r.reviewState) && (candidates.length !== 1 || r.categoryId === null
      || r.normalizedPath.split('/').length < 2 || r.normalizedPath.split('/').some((p) => !p))) c.invalid();
    return { ...r, candidates };
  }), (r) => r.normalizedPath);
}
module.exports = { normalizeCategories };
