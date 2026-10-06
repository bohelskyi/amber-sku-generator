const test = require('node:test');
const assert = require('node:assert/strict');
const photos = require('../src/services/product-photos.service');
const lifecycle = require('../src/services/full-product-cutover-gate');
const { createApp } = require('../src/app');
let server; let base; let writes = 0;
test.before(async () => {
  test.mock.method(lifecycle, 'readGate', async () => ({ phase: 'legacy' }));
  test.mock.method(photos, 'stage', async (body, options) => {
    if (body.name) photos.validateUpload(body);
    writes++;
    return { receivedBytes: body.base64.length, actorId: options.mutationContext.actorUserId };
  });
  const app = createApp({ sessionMiddleware(req, _res, next) {
    const sub = req.get('X-Test-Actor');
    req.session = sub ? { identity: { issuer: 'https://auth.example.invalid', sub, authenticatedAt: new Date().toISOString() }, csrfToken: 'photo-csrf' } : {};
    next();
  }, applicationUserService: { async getOrCreateApplicationAccess(identity) {
    return { applicationUser: { id: 42, status: identity.sub === 'disabled' ? 'disabled' : 'active' }, roles: [],
      permissions: identity.sub === 'creator' ? ['products.create'] : [] };
  } } });
  server = await new Promise(resolve => { const live = app.listen(0, '127.0.0.1', () => resolve(live)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); test.mock.restoreAll(); });
const request = (body, actor, csrf = 'photo-csrf', path = '/api/product-photos/stage', extraHeaders = {}) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(actor ? { 'X-Test-Actor': actor } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...extraHeaders }, body,
});
test('large photo bodies cannot bypass session, active access, CSRF or upload permission', async () => {
  const body = JSON.stringify({ base64: 'a'.repeat(200000) });
  for (const [actor, csrf, expected] of [[null, null, 401], ['disabled', 'photo-csrf', 403], ['creator', null, 403], ['viewer', 'photo-csrf', 403]]) {
    const result = await request(body, actor, csrf);
    assert.equal(result.status, expected);
  }
  assert.equal(writes, 0);
});
test('authorized photo staging accepts its scoped larger body but preserves the ordinary route limit', async () => {
  const body = JSON.stringify({ base64: 'a'.repeat(200000) });
  const result = await request(body, 'creator');
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { receivedBytes: 200000, actorId: 42 });
  const other = await request(body, 'creator', 'photo-csrf', '/api/preview');
  assert.notEqual(other.status, 200); assert.equal(writes, 1);
});
test('malformed and oversized photo bodies fail before the staging service', async () => {
  assert.equal((await request('{', 'creator')).status, 400);
  assert.equal((await request(JSON.stringify({ base64: 'a'.repeat(8 * 1024 * 1024) }), 'creator')).status, 413);
  assert.equal(writes, 1);
});

function originalPng(size) {
  const tiny=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE5sAAAAASUVORK5CYII=','base64');
  const chunk=Buffer.alloc(size-tiny.length);
  chunk.writeUInt32BE(chunk.length-12,0);chunk.write('paDd',4,'ascii');
  let crc=0xffffffff;
  for(const byte of chunk.subarray(4,-4)) {
    crc^=byte;
    for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4);
  return Buffer.concat([tiny.subarray(0,-12),chunk,tiny.subarray(-12)]);
}

const {gzipSync,deflateSync,brotliCompressSync}=require('node:zlib');
test('all supported JSON content encodings enforce the decoded 1 MiB original boundary',async()=>{
  const raw=originalPng(1048576),large=originalPng(1048577);
  const payload=(bytes)=>JSON.stringify({idempotencyKey:'00000000-0000-4000-8000-000000000001',name:'фото.png',mimeType:'image/png',base64:bytes.toString('base64')});
  for(const [encoding,encode] of [['identity',v=>v],['gzip',gzipSync],['deflate',deflateSync],['br',brotliCompressSync]]) {
    const accepted=await request(encode(payload(raw)),'creator','photo-csrf','/api/product-photos/stage',{'Content-Encoding':encoding});
    assert.equal(accepted.status,200,encoding);
    assert.equal((await accepted.json()).receivedBytes,raw.toString('base64').length);
    const rejected=await request(encode(payload(large)),'creator','photo-csrf','/api/product-photos/stage',{'Content-Encoding':encoding});
    assert.equal(rejected.status,413,encoding);
    assert.equal((await rejected.json()).code,'PHOTO_SIZE_LIMIT_EXCEEDED');
  }
});
test('parser bypass and compressed aggregate bodies return clear JSON before staging',async()=>{
  const before=writes;
  const body=JSON.stringify({base64:'a'.repeat(photos.MAX_PHOTO_REQUEST_BYTES)});
  for(const [encoding,encode] of [['identity',v=>v],['gzip',gzipSync],['deflate',deflateSync],['br',brotliCompressSync]]) {
    const result=await request(encode(body),'creator','photo-csrf','/api/product-photos/stage',{'Content-Encoding':encoding});
    assert.equal(result.status,413);assert.match(result.headers.get('content-type'),/application\/json/);
    const error=await result.json();assert.equal(error.code,'PHOTO_SIZE_LIMIT_EXCEEDED');assert.match(error.error,/1048576/);
  }
  const aggregate=JSON.stringify({photos:Array.from({length:8},()=>({base64:originalPng(1048576).toString('base64')}))});
  const result=await request(gzipSync(aggregate),'creator','photo-csrf','/api/product-photos/stage',{'Content-Encoding':'gzip'});
  assert.equal(result.status,413);assert.equal((await result.json()).code,'PHOTO_SIZE_LIMIT_EXCEEDED');
  assert.equal(writes,before);
});
test('chunked JSON bodies enforce the same parser limit without Content-Length',async()=>{
  const http=require('node:http');const body=JSON.stringify({base64:'a'.repeat(photos.MAX_PHOTO_REQUEST_BYTES)});
  const result=await new Promise((resolve,reject)=>{
    const req=http.request(base+'/api/product-photos/stage',{method:'POST',headers:{'Content-Type':'application/json','X-Test-Actor':'creator','X-CSRF-Token':'photo-csrf'}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())}));
    });req.on('error',reject);for(let pos=0;pos<body.length;pos+=16384)req.write(body.slice(pos,pos+16384));req.end();
  });
  assert.equal(result.status,413);assert.equal(result.body.code,'PHOTO_SIZE_LIMIT_EXCEEDED');
});

test('supported trailing slash and case variants retain the scoped original limit',async()=>{
  const body=JSON.stringify({idempotencyKey:'00000000-0000-4000-8000-000000000001',name:'original.png',mimeType:'image/png',base64:originalPng(1048576).toString('base64')});
  for(const path of ['/api/product-photos/stage/','/api/PRODUCT-PHOTOS/STAGE']) {
    const result=await request(body,'creator','photo-csrf',path);
    assert.equal(result.status,200);assert.equal((await result.json()).receivedBytes,4*Math.ceil(1048576/3));
  }
});
