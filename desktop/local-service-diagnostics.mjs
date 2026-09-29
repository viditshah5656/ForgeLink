import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { redactDiagnostic } from './agent-diagnostics.mjs';

const MAX_BODY = 64 * 1024;

export function jsonShape(value, maxNodes = 200) {
  const nodes = [];
  const walk = (item, pointer, depth) => {
    if (nodes.length >= maxNodes || depth > 8) return;
    const type = Array.isArray(item) ? 'array' : item === null ? 'null' : typeof item;
    nodes.push({ path: pointer || '/', type, ...(type === 'array' ? { length: item.length } : {}) });
    if (type === 'object') for (const key of Object.keys(item).slice(0, 50)) walk(item[key], `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, depth + 1);
    if (type === 'array' && item.length) walk(item[0], `${pointer}/0`, depth + 1);
  };
  walk(value, '', 0);
  return { nodes, truncated: nodes.length >= maxNodes };
}

export async function tcpHealth(port, timeoutMs = 1500) {
  return await new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = (reachable, error = null) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ port, reachable, latencyMs: Date.now() - started, error });
    };
    socket.setTimeout(timeoutMs, () => finish(false, 'TIMEOUT'));
    socket.once('connect', () => finish(true));
    socket.once('error', (error) => finish(false, error.code || 'CONNECT_ERROR'));
  });
}

export async function localHttpRequest({ port, pathname = '/', protocol = 'http', method = 'GET', timeoutMs = 3000 }) {
  if (!pathname.startsWith('/') || pathname.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(pathname)) throw new Error('Path must start with one slash and contain no backslashes or controls');
  if (!['http', 'https'].includes(protocol)) throw new Error('Only HTTP and HTTPS are supported');
  if (!['GET', 'HEAD'].includes(method)) throw new Error('Only GET and HEAD are supported');
  const url = new URL(`${protocol}://127.0.0.1:${port}${pathname}`);
  if (url.hostname !== '127.0.0.1' || Number(url.port) !== port) throw new Error('HTTP diagnostics are restricted to the supplied loopback port');
  if ([...url.searchParams.keys()].some((key) => /(?:api[_-]?key|key|token|secret|password|auth|credential)/i.test(key))) throw new Error('Credential-bearing query parameters are not supported');
  const started = Date.now();
  const response = await fetch(url, {
    method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json, text/plain, */*' },
  });
  const headers = {};
  for (const name of ['content-type', 'content-length', 'server', 'cache-control', 'access-control-allow-origin', 'etag', 'vary', 'content-encoding', 'x-request-id']) {
    const value = response.headers.get(name);
    if (value) headers[name] = redactDiagnostic(value).slice(0, 200);
  }
  const chunks = [];
  let size = 0;
  let truncated = false;
  if (response.body && method !== 'HEAD') {
    const reader = response.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = MAX_BODY - size;
      if (chunk.value.length > remaining) {
        if (remaining > 0) chunks.push(chunk.value.slice(0, remaining));
        size += remaining;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(chunk.value);
      size += chunk.value.length;
    }
  }
  const body = Buffer.concat(chunks);
  const bodyText = body.toString('utf8');
  let shape = null;
  if (!truncated && /(?:json|graphql)/i.test(headers['content-type'] || '')) {
    try { shape = jsonShape(JSON.parse(bodyText)); } catch {}
  }
  const elapsedMs = Date.now() - started;
  return { port, pathname, protocol, method, status: response.status, ok: response.ok, elapsedMs, headers, bytesRead: size, truncated, bodySha256: crypto.createHash('sha256').update(body).digest('hex'), jsonShape: shape, trace: { request: { method, path: pathname, host: '127.0.0.1', port, protocol }, response: { status: response.status, headers, bodyBytesCaptured: size, truncated }, timings: { totalMs: elapsedMs } }, bodyText };
}

export async function httpHealth(options) {
  try {
    let response = await localHttpRequest({ ...options, method: 'HEAD' });
    if ([405, 501].includes(response.status)) response = await localHttpRequest({ ...options, method: 'GET' });
    return { ...response, healthy: response.status >= 200 && response.status < 400, bodyText: undefined, checkedAt: new Date().toISOString() };
  } catch (error) {
    return { port: options.port, healthy: false, error: error.code || error.name || 'REQUEST_ERROR', message: redactDiagnostic(error.message).slice(0, 200) };
  }
}

export async function tlsInspect(port, timeoutMs = 3000) {
  return await new Promise((resolve) => {
    const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false });
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve({ port, ...result });
    };
    socket.setTimeout(timeoutMs, () => finish({ reachable: false, error: 'TIMEOUT' }));
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate(true);
      const expiry = cert?.valid_to ? Date.parse(cert.valid_to) : NaN;
      const chain = [];
      let current = cert;
      while (current && Object.keys(current).length && chain.length < 8 && !chain.some((item) => item.fingerprint256 === current.fingerprint256)) {
        chain.push({ subject: current.subject, issuer: current.issuer, validFrom: current.valid_from, validTo: current.valid_to, fingerprint256: current.fingerprint256 });
        current = current.issuerCertificate;
      }
      finish({ reachable: true, authorized: socket.authorized, authorizationError: socket.authorizationError ?? null, protocol: socket.getProtocol(), cipher: socket.getCipher()?.name ?? null, chain, certificate: cert && Object.keys(cert).length ? { subject: cert.subject, issuer: cert.issuer, validFrom: cert.valid_from, validTo: cert.valid_to, daysUntilExpiry: Number.isFinite(expiry) ? Math.floor((expiry - Date.now()) / 86400000) : null, fingerprint256: cert.fingerprint256, hostnameMatch: tls.checkServerIdentity('localhost', cert)?.message ?? 'match' } : null });
    });
    socket.once('error', (error) => finish({ reachable: false, error: error.code || 'TLS_ERROR' }));
  });
}

export async function discoverApi(port) {
  const candidates = ['/openapi.json', '/swagger.json', '/v3/api-docs', '/.well-known/openapi.json'];
  for (const pathname of candidates) {
    try {
      const response = await localHttpRequest({ port, pathname, timeoutMs: 2000 });
      if (!response.ok || response.truncated) continue;
      const schema = JSON.parse(response.bodyText);
      if (schema.openapi || schema.swagger) {
        const endpoints = Object.entries(schema.paths || {}).slice(0, 200).flatMap(([route, methods]) => Object.entries(methods).filter(([method]) => /^(get|post|put|patch|delete|head|options)$/i.test(method)).map(([method, operation]) => ({ method: method.toUpperCase(), path: route, operationId: operation?.operationId ?? null, tags: Array.isArray(operation?.tags) ? operation.tags.slice(0, 5) : [], responses: Object.keys(operation?.responses || {}).slice(0, 10) })));
        return { found: true, kind: 'openapi', schemaPath: pathname, schemaSha256: response.bodySha256, version: schema.openapi || schema.swagger, title: schema.info?.title ?? null, endpoints, truncated: Object.keys(schema.paths || {}).length > 200 };
      }
    } catch {}
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/graphql`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(2000), headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ query: '{ __schema { queryType { name fields { name } } mutationType { name fields { name } } } }' }) });
    const length = Number(response.headers.get('content-length') || 0);
    if (response.ok && length <= MAX_BODY && response.body) {
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (size <= MAX_BODY) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > MAX_BODY) { await reader.cancel(); break; }
        chunks.push(chunk.value);
      }
      if (size <= MAX_BODY) {
        const bytes = Buffer.concat(chunks);
        const schema = JSON.parse(bytes.toString('utf8')).data?.__schema;
        if (schema?.queryType) {
          const endpoints = [['QUERY', schema.queryType], ['MUTATION', schema.mutationType]].flatMap(([kind, type]) => (type?.fields || []).slice(0, 100).map((field) => ({ method: 'POST', path: '/graphql', operation: kind, name: field.name })));
          return { found: true, kind: 'graphql', schemaPath: '/graphql', schemaSha256: crypto.createHash('sha256').update(bytes).digest('hex'), title: schema.queryType.name, endpoints, truncated: (schema.queryType.fields?.length || 0) > 100 || (schema.mutationType?.fields?.length || 0) > 100 };
        }
      }
    } else if (response.body) await response.body.cancel();
  } catch {}
  return { found: false, checked: [...candidates, '/graphql'], note: 'gRPC reflection requires a compatible gRPC client and was not probed' };
}
