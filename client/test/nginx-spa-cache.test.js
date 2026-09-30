import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const nginx = fs.readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8');

function locationBody(modifier, path) {
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = nginx.match(new RegExp(`location\\s+${modifier ? `${modifier}\\s+` : ''}${escapedPath}\\s*\\{([^{}]*)\\}`));
  assert.ok(match, `nginx location for ${path} must exist`);
  return match[1];
}

test('Vite assets use a terminal 404 and immutable caching', () => {
  const assets = locationBody('\\^~', '/assets/');
  assert.match(assets, /try_files\s+\$uri\s+=404\s*;/);
  assert.doesNotMatch(assets, /index\.html/);
  assert.match(assets, /add_header\s+Cache-Control\s+"[^"]*max-age=31536000[^"]*immutable[^"]*"\s*;/i);
});

test('SPA HTML is never stored while application routes retain fallback', () => {
  const html = locationBody('=', '/index.html');
  assert.match(html, /add_header\s+Cache-Control\s+"[^"]*no-store[^"]*"\s*;/i);
  assert.match(locationBody('', '/'), /try_files\s+\$uri\s+\/index\.html\s*;/);
});
