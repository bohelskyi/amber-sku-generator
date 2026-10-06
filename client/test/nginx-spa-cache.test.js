import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const nginx = fs.readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8');

test('API resolves Docker service addresses at runtime and preserves the original URI', () => {
  assert.match(nginx, /resolver\s+127\.0\.0\.11\s+valid=1s\s+ipv6=off;/);
  const api = locationBody('', '/api/');
  assert.match(api, /set\s+\$amber_api_upstream\s+"\$\{SERVER_HOST\}:\$\{SERVER_PORT\}";/);
  assert.match(api, /proxy_pass\s+http:\/\/\$amber_api_upstream\$request_uri;/);
  assert.match(api, /proxy_redirect\s+http:\/\/\$\{SERVER_HOST\}:\$\{SERVER_PORT\}\/api\/\s+\/api\/;/);
  for (const header of ['Host', 'X-Real-IP', 'X-Forwarded-For', 'X-Forwarded-Proto']) {
    assert.match(api, new RegExp(`proxy_set_header\\s+${header}\\s+`));
  }
});

function locationBody(modifier, path) {
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = nginx.match(new RegExp(`location\\s+${modifier ? `${modifier}\\s+` : ''}${escapedPath}\\s*\\{([\\s\\S]*?)\\n  \\}`));
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

test('photo upload alone has enough space for one 5 MiB base64 image and retains the exact proxy transport', () => {
  const upload=locationBody('=', '/api/product-photos/stage');
  assert.match(upload,/client_max_body_size\s+8m;/);
  assert.match(upload,/proxy_pass\s+http:\/\/\$amber_api_upstream\$request_uri;/);
  assert.doesNotMatch(locationBody('', '/api/'),/client_max_body_size/);
  for(const header of ['Host','X-Real-IP','X-Forwarded-For','X-Forwarded-Proto']) {
    assert.match(upload,new RegExp(`proxy_set_header\\s+${header}\\s+`));
  }
});
