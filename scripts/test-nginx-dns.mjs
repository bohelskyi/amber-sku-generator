// Isolated Docker smoke: no Compose services, database, or Magento credentials.
// node scripts/test-nginx-dns.mjs <built-client-image> [--negative-control]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const image = process.argv[2];
if (!image || image.startsWith('--')) throw new Error('Specify the built client image');
const negative = process.argv.includes('--negative-control');
const prefix = `amber-dns-${process.pid}-${Date.now()}`;
const network = `${prefix}-network`;
const client = `${prefix}-client`;
const server = `${prefix}-server`;
const directory = mkdtempSync(path.join(tmpdir(), 'amber-dns-'));
const fixture = fileURLToPath(new URL('./fixtures/dns-server.mjs', import.meta.url));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const inspect = (name) => JSON.parse(docker('inspect', name))[0];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const names = new Set();

async function startServer(identity, address) {
  docker('run', '-d', '--name', server, '--network', network, '--network-alias', 'server',
    '--ip', address, '-e', `FIXTURE_ID=${identity}`, '--mount', `type=bind,source=${fixture},target=/fixture.mjs,readonly`,
    'node:20-bookworm-slim', 'node', '/fixture.mjs');
  names.add(server);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      docker('exec', server, 'node', '-e', "fetch('http://127.0.0.1:5000/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))");
      return;
    } catch { await pause(200); }
  }
  throw new Error('Isolated fixture did not become ready');
}

try {
  docker('network', 'create', network);
  const subnet = JSON.parse(docker('network', 'inspect', network))[0].IPAM.Config[0].Subnet;
  const [base, mask] = subnet.split('/');
  assert.ok(Number(mask) <= 27, `Unexpectedly small Docker network: ${subnet}`);
  const octets = base.split('.').map(Number);
  const address = (offset) => {
    const number = octets.reduce((value, octet) => value * 256 + octet, 0) + offset;
    return [24, 16, 8, 0].map((shift) => (number >>> shift) & 255).join('.');
  };
  await startServer('A', address(10));
  const args = ['run', '-d', '--name', client, '--network', network,
    '-p', '127.0.0.1::80', '-e', 'SERVER_HOST=server', '-e', 'SERVER_PORT=5000',
    '-e', 'NGINX_ENVSUBST_FILTER=^SERVER_'];
  if (negative) {
    let template = readFileSync(new URL('../client/nginx.conf', import.meta.url), 'utf8');
    template = template.replace(/    set \$amber_api_upstream[^\n]*\n    proxy_pass[^\n]*\n    proxy_redirect[^\n]*\n/g, '    proxy_pass http://${SERVER_HOST}:${SERVER_PORT}/api/;\n');
    const filename = path.join(directory, 'default.conf.template');
    writeFileSync(filename, template);
    args.push('--mount', `type=bind,source=${filename},target=/etc/nginx/templates/default.conf.template,readonly`);
  }
  docker(...args, image);
  names.add(client);
  docker('exec', client, 'nginx', '-t');
  const before = inspect(client);
  const processes = docker('top', client, '-eo', 'pid,args');
  const url = `http://127.0.0.1:${before.NetworkSettings.Ports['80/tcp'][0].HostPort}`;
  const get = (uri, options = {}) => fetch(url + uri, { ...options, redirect: 'manual' });
  const first = await get('/api/auth/me?probe=%2F&repeat=1&repeat=2', { headers: { 'X-Forwarded-Proto': 'https', Cookie: 'amber_fixture=session' } });
  assert.equal(first.status, 200);
  const echoed = await first.json();
  assert.equal(echoed.identity, 'A');
  assert.equal(echoed.url, '/api/auth/me?probe=%2F&repeat=1&repeat=2');
  assert.equal(echoed.headers['x-forwarded-proto'], 'https');
  assert.equal(echoed.headers.cookie, 'amber_fixture=session');
  assert.equal(echoed.headers.host, '127.0.0.1');
  assert.ok(echoed.headers['x-real-ip']);
  assert.ok(echoed.headers['x-forwarded-for']);
  const post = await get('/api/name/preview?x=1', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture' }, body: '{"name":"Тест"}' });
  const posted = await post.json();
  assert.equal(posted.body, '{"name":"Тест"}');
  assert.equal(posted.headers['x-csrf-token'], 'fixture');
  const photoBody = JSON.stringify({ base64: 'a'.repeat(2 * 1024 * 1024) });
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  async function checkPhotoProxy(identity) {
    const result = await get('/api/product-photos/stage?probe=%2F', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'photo-fixture',
        Cookie: 'amber_fixture=photo-session', 'X-Forwarded-Proto': 'https' }, body: photoBody });
    assert.equal(result.status, 200);
    const photo = await result.json();
    assert.equal(photo.identity, identity);
    assert.equal(photo.url, '/api/product-photos/stage?probe=%2F');
    assert.equal(photo.method, 'POST');
    assert.equal(digest(photo.body), digest(photoBody));
    assert.equal(photo.headers['x-csrf-token'], 'photo-fixture');
    assert.equal(photo.headers.cookie, 'amber_fixture=photo-session');
    assert.equal(photo.headers['x-forwarded-proto'], 'https');
  }
  if (!negative) {
    await checkPhotoProxy('A');
    assert.equal((await get('/api/name/preview', { method: 'POST', body: photoBody })).status, 413);
    assert.equal((await get('/api/product-photos/stage', { method: 'POST', body: 'a'.repeat(9 * 1024 * 1024) })).status, 413);
  }
  const login = await get('/api/auth/login');
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), 'http://127.0.0.1/api/auth/callback?code=fixture&state=fixture');
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const html = await get('/index.html');
  const htmlText = await html.text();
  assert.match(html.headers.get('cache-control'), /no-store/);
  const asset = htmlText.match(/(?:src|href)="(\/assets\/[^" ]+)"/)[1];
  const assetResponse = await get(asset);
  assert.equal(assetResponse.status, 200);
  assert.match(assetResponse.headers.get('cache-control'), /immutable/);
  assert.equal((await get('/assets/missing-dns-fixture.js')).status, 404);
  assert.equal(await (await get('/admin/corrections/history')).text(), htmlText);
  await get('/api/auth/callback?code=DO_NOT_LOG_FIXTURE&state=DO_NOT_LOG_FIXTURE');
  assert.doesNotMatch(docker('logs', client), /DO_NOT_LOG_FIXTURE/);

  // A fixed address for B makes address replacement deterministic without touching any other network.
  const oldAddress = inspect(server).NetworkSettings.Networks[network].IPAddress;
  docker('rm', '-f', server);
  const retired = `${prefix}-retired-address`;
  docker('run', '-d', '--name', retired, '--network', network, '--ip', oldAddress,
    'node:20-bookworm-slim', 'node', '-e', 'setInterval(()=>{},1000)');
  names.add(retired);
  await startServer('B', address(11));
  const newAddress = inspect(server).NetworkSettings.Networks[network].IPAddress;
  assert.notEqual(newAddress, oldAddress);
  // Bound the expected recovery: ready replacement + one DNS validity interval. No success-until-retry loop.
  await pause(2000);
  for (let request = 0; request < 5; request += 1) {
    const response = await get(`/api/auth/me?replacement=${request}`);
    if (negative) { assert.equal(response.status, 502); continue; }
    assert.equal(response.status, 200);
    assert.equal((await response.json()).identity, 'B');
  }
  if (!negative) await checkPhotoProxy('B');
  const after = inspect(client);
  assert.equal(after.Id, before.Id);
  assert.equal(after.State.StartedAt, before.State.StartedAt);
  assert.equal(after.RestartCount, before.RestartCount);
  assert.equal(docker('top', client, '-eo', 'pid,args'), processes);
  console.log(JSON.stringify({ result: negative ? 'negative control reproduced stale DNS' : 'passed', oldAddress, newAddress,
    clientId: after.Id, startedAt: after.State.StartedAt, restartCount: after.RestartCount, processesUnchanged: true }));
} finally {
  for (const name of names) { try { docker('rm', '-f', name); } catch { /* already removed */ } }
  try { docker('network', 'rm', network); } catch { /* failure before network creation */ }
  rmSync(directory, { recursive: true, force: true });
}
