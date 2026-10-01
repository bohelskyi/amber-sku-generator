import http from 'node:http';

http.createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  if (request.url.startsWith('/api/auth/login')) {
    response.writeHead(302, {
      Location: 'http://server:5000/api/auth/callback?code=fixture&state=fixture',
      'Set-Cookie': 'amber_fixture=session; Path=/; HttpOnly; SameSite=Lax',
    });
    response.end();
    return;
  }
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ identity: process.env.FIXTURE_ID, url: request.url,
    method: request.method, headers: request.headers, body }));
}).listen(5000, '0.0.0.0');
