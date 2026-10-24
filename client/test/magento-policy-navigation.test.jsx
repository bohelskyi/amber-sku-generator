import { describe, expect, it } from 'vitest';
import {
  closePolicyReviewUrl,
  parsePolicyReview,
  policyReviewUrl,
  resolvePolicyEntry,
} from '../src/lib/magento-policy-navigation.js';

const pathname = '/admin/catalog';
const binding = 'published-binding';
const opaqueId = 'policy:<BR/english/meta:title>?side=a&b=1 #exact';
const entry = {
  id: opaqueId, kind: 'policy', group: 'BR', routeKey: 'BR.special',
  row: 'english', target: 'meta_title', label: 'en',
  identity: 'authoritative_create_update', reviewState: 'approved',
};
const params = (values = {}) => new URLSearchParams({
  category: 'BR', binding, review: 'policies', ...values,
});
const dto = (entries = [entry], id = binding) => ({ revision: { id, revision: '7' }, entries });
const tupleParams = () => params({
  route: entry.routeKey, language: entry.row, reviewField: entry.target, reviewStore: entry.label,
});
const readUrl = (value) => new URL(value, 'https://local.test');

describe('policy navigation reads exact returned identities without choosing a policy', () => {
  it('keeps absent, closed and unknown modes outside the policy-view contract', () => {
    for (const mode of [undefined, '', 'closed', 'POLICIES', 'approve']) {
      const query = params();
      if (mode === undefined) query.delete('review'); else query.set('review', mode);
      expect(parsePolicyReview(query, 'BR')).toBeNull();
    }
  });

  it('accepts a general table with navigation scope but never selects its first policy', () => {
    const intent = parsePolicyReview(params({ route: 'BR.special', language: 'english' }), 'BR');
    expect(intent).toMatchObject({ valid: true, kind: 'general', category: 'BR', binding });
    expect(resolvePolicyEntry(intent, dto())).toBeNull();
  });

  it('preserves an opaque ID literally, including punctuation, and does not trim it into another identity', () => {
    const query = params({ reviewEntry: opaqueId });
    const intent = parsePolicyReview(new URLSearchParams(query.toString()), 'BR');
    expect(intent).toMatchObject({ valid: true, kind: 'id', entryId: opaqueId });
    expect(resolvePolicyEntry(intent, dto())).toBe(entry);
    expect(resolvePolicyEntry(parsePolicyReview(params({ reviewEntry: ` ${opaqueId} ` }), 'BR'), dto())).toBeNull();
  });

  it('resolves a complete tuple among the same target on other routes, languages and stores', () => {
    const others = [
      { ...entry, id: 'policy:base', row: 'base', label: 'all' },
      { ...entry, id: 'policy:other-route', routeKey: 'BR.other' },
      { ...entry, id: 'policy:other-store', label: 'english_second' },
      { ...entry, id: 'policy:other-category', group: 'KL' },
      { ...entry, id: 'attribute:same', kind: 'attribute' },
    ];
    const input = dto([...others, entry]);
    const before = JSON.stringify(input);
    const intent = parsePolicyReview(tupleParams(), 'BR');
    expect(intent).toMatchObject({ valid: true, kind: 'tuple' });
    expect(resolvePolicyEntry(intent, input)).toBe(entry);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('checks every supplied scope field even when the opaque ID exists', () => {
    for (const [key, value] of [
      ['route', 'BR.other'], ['language', 'base'], ['reviewField', 'meta_description'], ['reviewStore', 'all'],
    ]) {
      const query = tupleParams();
      query.set('reviewEntry', entry.id); query.set(key, value);
      const intent = parsePolicyReview(query, 'BR');
      expect(intent.valid).toBe(true);
      expect(resolvePolicyEntry(intent, dto()), key).toBeNull();
    }
    const intent = parsePolicyReview(params({ reviewEntry: entry.id }), 'BR');
    expect(resolvePolicyEntry(intent, dto([{ ...entry, group: 'KL' }]))).toBeNull();
    expect(resolvePolicyEntry(intent, dto([{ ...entry, kind: 'attribute' }]))).toBeNull();
  });

  it('refuses missing and ambiguous matches instead of selecting the first returned row', () => {
    const byId = parsePolicyReview(params({ reviewEntry: entry.id }), 'BR');
    const byTuple = parsePolicyReview(tupleParams(), 'BR');
    expect(resolvePolicyEntry(byId, dto([]))).toBeNull();
    expect(resolvePolicyEntry(byTuple, dto([]))).toBeNull();
    expect(resolvePolicyEntry(byId, dto([entry, { ...entry }]))).toBeNull();
    expect(resolvePolicyEntry(byTuple, dto([entry, { ...entry, id: 'policy:second-id' }]))).toBeNull();
  });

  it('requires the exact selected response binding and an actual entries array', () => {
    const intent = parsePolicyReview(params({ reviewEntry: entry.id }), 'BR');
    for (const response of [
      undefined, null, {}, { entries: [entry] }, dto([entry], 'another-binding'),
      dto(null), dto({ entry }), dto('entries'), dto([null]),
    ]) {
      expect(resolvePolicyEntry(intent, response)).toBeNull();
    }
    expect(resolvePolicyEntry(null, dto())).toBeNull();
    expect(resolvePolicyEntry({ valid: false }, dto())).toBeNull();
  });

  it('never returns a tuple match without a bounded opaque server ID', () => {
    const intent = parsePolicyReview(tupleParams(), 'BR');
    for (const id of [undefined, null, '', 1, 'x'.repeat(257), 'policy:\nwrong']) {
      expect(resolvePolicyEntry(intent, dto([{ ...entry, id }]))).toBeNull();
    }
  });
});

describe('policy navigation rejects incomplete or malformed exact scope', () => {
  it('requires a binding and a matching valid category', () => {
    const missingBinding = params(); missingBinding.delete('binding');
    expect(parsePolicyReview(missingBinding, 'BR').valid).toBe(false);
    expect(parsePolicyReview(params({ category: 'KL' }), 'BR').valid).toBe(false);
    for (const category of ['', 'br', 'BR-', 'B'.repeat(33), 'BR\n']) {
      expect(parsePolicyReview(params({ category }), category).valid).toBe(false);
    }
    for (const id of ['', 'x'.repeat(257), 'binding\u0000id']) {
      expect(parsePolicyReview(params({ binding: id }), 'BR').valid).toBe(false);
    }
  });

  it('rejects every incomplete tuple without downgrading it to a general or target-only view', () => {
    for (const key of ['route', 'language', 'reviewField', 'reviewStore']) {
      const query = tupleParams(); query.delete(key);
      expect(parsePolicyReview(query, 'BR').valid, key).toBe(false);
    }
    expect(parsePolicyReview(params({ reviewField: 'meta_title' }), 'BR').valid).toBe(false);
    expect(parsePolicyReview(params({ reviewStore: 'en' }), 'BR').valid).toBe(false);
  });

  it('rejects duplicate known intent keys even when both copies have equal values', () => {
    const original = tupleParams(); original.set('reviewEntry', entry.id);
    for (const key of ['review', 'binding', 'category', 'reviewEntry', 'route', 'language', 'reviewField', 'reviewStore']) {
      const query = new URLSearchParams(original);
      query.append(key, query.get(key));
      expect(parsePolicyReview(query, 'BR').valid, key).toBe(false);
    }
  });

  it('honors the navigable route bound without truncating the 161-to-200-character interval', () => {
    for (const size of [160, 161, 200]) {
      const route = 'R'.repeat(size);
      const intent = parsePolicyReview(params({ reviewEntry: entry.id, route }), 'BR');
      expect(intent).toMatchObject({ valid: true, route });
    }
    for (const route of ['', 'R'.repeat(201), 'BR\rroute', 'BR\u007froute']) {
      expect(parsePolicyReview(params({ reviewEntry: entry.id, route }), 'BR').valid).toBe(false);
    }
  });

  it('bounds the entry ID and rejects control characters without interpreting its internal format', () => {
    expect(parsePolicyReview(params({ reviewEntry: 'x'.repeat(256) }), 'BR').valid).toBe(true);
    for (const id of ['', 'x'.repeat(257), 'policy:\tbad', 'policy:\u0000bad', 'policy:\u007fbad']) {
      expect(parsePolicyReview(params({ reviewEntry: id }), 'BR').valid).toBe(false);
    }
  });

  it('requires raw base/english scope and bounded target/store codes, without language aliases', () => {
    for (const key of ['reviewField', 'reviewStore']) {
      const query = tupleParams(); query.set(key, 'A'.repeat(100));
      expect(parsePolicyReview(query, 'BR').valid).toBe(true);
      for (const value of ['', '_invalid', '1invalid', 'with space', 'A'.repeat(101), 'en\n']) {
        const invalid = tupleParams(); invalid.set(key, value);
        expect(parsePolicyReview(invalid, 'BR').valid).toBe(false);
      }
    }
    for (const row of ['', 'en', 'UA', 'all', 'english ']) {
      expect(parsePolicyReview(params({ reviewEntry: entry.id, language: row }), 'BR').valid).toBe(false);
    }
  });
});

describe('policy links preserve return context and carry no approval', () => {
  it('round-trips a returned field entry while preserving the distinct original field code and draft context', () => {
    const returnTo = '/attention?category=BR&problem=42';
    const query = params({
      field: 'seo_column', ruleDraft: 'private-template-family', view: 'text',
      productId: '42', question: 'color', value: '0', returnTo,
    });
    const before = query.toString();
    const href = policyReviewUrl(pathname, query, { category: 'BR', binding, source: 'current-publication', entry });
    const url = readUrl(href);
    expect(url.pathname).toBe(pathname);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      review: 'policies', reviewEntry: entry.id, binding, source: 'current-publication',
      route: entry.routeKey, language: 'english', reviewField: 'meta_title', reviewStore: 'en',
      field: 'seo_column', ruleDraft: 'private-template-family', view: 'text',
      productId: '42', question: 'color', value: '0', returnTo,
    });
    expect(resolvePolicyEntry(parsePolicyReview(url.searchParams, 'BR'), dto())).toBe(entry);
    expect(query.toString()).toBe(before);
  });

  it('builds a general table without retaining an old focus or changing its field return scope', () => {
    const query = tupleParams();
    query.set('reviewEntry', entry.id); query.set('field', 'original_column');
    const url = readUrl(policyReviewUrl(pathname, query, { category: 'BR', binding }));
    expect(parsePolicyReview(url.searchParams, 'BR').kind).toBe('general');
    expect(url.searchParams.get('field')).toBe('original_column');
    expect(url.searchParams.get('route')).toBe(entry.routeKey);
    expect(url.searchParams.get('language')).toBe(entry.row);
    for (const key of ['reviewEntry', 'reviewField', 'reviewStore']) expect(url.searchParams.has(key)).toBe(false);
  });

  it('preserves exact 200-character route scope across the older repair-context sanitizer', () => {
    for (const size of [160, 161, 200]) {
      const exact = { ...entry, routeKey: 'R'.repeat(size) };
      const url = readUrl(policyReviewUrl(pathname, new URLSearchParams(), { category: 'BR', binding, entry: exact }));
      expect(url.searchParams.get('route')).toBe(exact.routeKey);
      expect(resolvePolicyEntry(parsePolicyReview(url.searchParams, 'BR'), dto([exact]))).toBe(exact);
    }
    expect(policyReviewUrl(pathname, params(), { category: 'BR', binding, entry: { ...entry, routeKey: 'R'.repeat(201) } })).toBeNull();
  });

  it('refuses an invalid returned entry instead of silently producing a general field link', () => {
    for (const invalid of [
      { ...entry, kind: 'attribute' }, { ...entry, group: 'KL' }, { ...entry, id: '' },
      { ...entry, routeKey: '' }, { ...entry, row: 'en' }, { ...entry, target: 'bad target' },
      { ...entry, label: '' },
    ]) {
      expect(policyReviewUrl(pathname, params(), { category: 'BR', binding, entry: invalid })).toBeNull();
    }
    expect(policyReviewUrl(pathname, params(), { category: 'br', binding })).toBeNull();
    expect(policyReviewUrl(pathname, params(), { category: 'BR', binding: '' })).toBeNull();
    expect(policyReviewUrl(pathname, params(), { category: 'BR', binding, source: 'bad\nsource' })).toBeNull();
  });

  it('drops unsafe repair return addresses and explicit command/proof query fields', () => {
    const query = params({
      returnTo: 'https://external.test/private', productId: '1e3', field: 'bad\nfield',
      apply: 'true', approve: 'true', policy: 'authoritative_create_update',
      previewToken: 'private-proof', reviewHash: 'another-proof', reason: 'not a command',
    });
    const url = readUrl(policyReviewUrl(pathname, query, { category: 'BR', binding }));
    for (const key of ['returnTo', 'productId', 'field', 'apply', 'approve', 'policy', 'previewToken', 'reviewHash', 'reason']) {
      expect(url.searchParams.has(key), key).toBe(false);
    }
    expect(parsePolicyReview(url.searchParams, 'BR').valid).toBe(true);
  });

  it('refuses external, protocol-relative, fragment and control-character paths for either direction', () => {
    for (const path of ['https://external.test', '//external.test', 'admin/catalog', '/admin\\catalog', '/admin/catalog#fragment', '/admin/catalog\n']) {
      expect(policyReviewUrl(path, params(), { category: 'BR', binding })).toBeNull();
      expect(closePolicyReviewUrl(path, params())).toBeNull();
    }
  });

  it('closes into an explicit non-review state while retaining the exact field, binding and private draft', () => {
    const query = tupleParams();
    Object.entries({
      reviewEntry: entry.id, source: 'current-publication', field: 'seo_column',
      ruleDraft: 'private-template-family', view: 'text', productId: '42',
      question: 'color', value: '0', returnTo: '/attention?problem=42',
    }).forEach(([key, value]) => query.set(key, value));
    const before = query.toString();
    const url = readUrl(closePolicyReviewUrl(pathname, query));
    expect(url.searchParams.get('review')).toBe('closed');
    expect(parsePolicyReview(url.searchParams, 'BR')).toBeNull();
    for (const key of ['reviewEntry', 'reviewField', 'reviewStore']) expect(url.searchParams.has(key)).toBe(false);
    for (const key of ['category', 'binding', 'source', 'field', 'ruleDraft', 'view', 'productId', 'question', 'value', 'returnTo', 'route', 'language']) {
      expect(url.searchParams.get(key), key).toBe(query.get(key));
    }
    expect(query.toString()).toBe(before);
  });
});
