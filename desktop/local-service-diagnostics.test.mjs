import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { tcpHealth, localHttpRequest, httpHealth, discoverApi, jsonShape } from './local-service-diagnostics.mjs';

test('loopback diagnostics discover API metadata and never follow redirects', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/openapi.json') return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ openapi: '3.1.0', info: { title: 'Test API' }, paths: { '/items': { get: {}, post: {} } } }));
    if (request.url === '/redirect') return response.writeHead(302, { location: 'https://example.com/' }).end();
    return response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal((await tcpHealth(port)).reachable, true);
    assert.equal((await httpHealth({ port, pathname: '/' })).healthy, true);
    const redirect = await localHttpRequest({ port, pathname: '/redirect' });
    assert.equal(redirect.status, 302);
    const api = await discoverApi(port);
    assert.equal(api.title, 'Test API');
    assert.deepEqual(api.endpoints.map((item) => item.method), ['GET', 'POST']);
    assert.equal(api.schemaSha256.length, 64);
    assert.deepEqual(jsonShape({ items: [{ id: 1 }] }).nodes.map((node) => node.path), ['/', '/items', '/items/0', '/items/0/id']);
    await assert.rejects(localHttpRequest({ port, pathname: '//example.com/' }), /one slash/);
    await assert.rejects(localHttpRequest({ port, pathname: '/\\example.com/' }), /one slash/);
    await assert.rejects(localHttpRequest({ port, pathname: '/?%74oken=hidden' }), /Credential-bearing/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('API discovery can inspect bounded GraphQL metadata without exposing resolver data', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/graphql' && request.method === 'POST') return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { __schema: { queryType: { name: 'Query', fields: [{ name: 'projects' }] }, mutationType: null } } }));
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const api = await discoverApi(server.address().port);
    assert.equal(api.kind, 'graphql');
    assert.equal(api.endpoints[0].name, 'projects');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
