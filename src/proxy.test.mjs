/**
 * toklock proxy tests
 * Run: node --test src/proxy.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxy } from './proxy.mjs';

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Start a mock upstream server. handler(req, res) controls each response. */
function mockUpstream(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

/** Start the proxy pointing at a mock upstream, return { proxy, port }. */
function startProxy(upstreamPort) {
  return new Promise(resolve => {
    const proxy = createProxy({
      port: 0,
      upstream: `http://127.0.0.1:${upstreamPort}`,
    });
    proxy.once('listening', () => {
      resolve({ proxy, port: proxy.address().port });
    });
  });
}

/** Make one HTTP request to the proxy. Returns { status, headers, body }. */
function request(proxyPort, { path = '/v1/messages', method = 'POST', body = '{}', agent } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: proxyPort, path, method, agent,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Close a server and wait for it to finish. */
function close(server) {
  return new Promise(resolve => server.close(resolve));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('forwards request and returns 200 response', async () => {
  const { server: up, port: upPort } = await mockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1' }));
  });

  const { proxy, port } = await startProxy(upPort);

  const { status, body } = await request(port);
  assert.equal(status, 200);
  assert.deepEqual(JSON.parse(body), { id: 'msg_1' });

  await close(proxy);
  await close(up);
});

test('forwards request headers to upstream', async () => {
  let receivedHeaders;
  const { server: up, port: upPort } = await mockUpstream((req, res) => {
    receivedHeaders = req.headers;
    res.writeHead(200);
    res.end('{}');
  });

  const { proxy, port } = await startProxy(upPort);

  await request(port, { body: '{"model":"claude-3"}' });
  assert.equal(receivedHeaders['content-type'], 'application/json');

  await close(proxy);
  await close(up);
});

test('round-robin: alternates between connections under single concurrency', async () => {
  const dispatched = [];

  // Upstream blocks each request until manually released
  const pending = [];
  const { server: up, port: upPort } = await mockUpstream((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      dispatched.push(body.tag);
      pending.push(() => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'anthropic-ratelimit-tokens-remaining': '5000',
        });
        res.end('{}');
      });
    });
  });

  const { proxy, port } = await startProxy(upPort);
  const agentA = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const agentB = new http.Agent({ keepAlive: true, maxSockets: 1 });

  // Wait until N requests have arrived and are held at upstream
  function waitForPending(n) {
    return new Promise(r => {
      const id = setInterval(() => { if (pending.length >= n) { clearInterval(id); r(); } }, 5);
    });
  }

  // Pre-warm both connections sequentially so both sockets exist before the test
  const warmA = request(port, { body: JSON.stringify({ tag: 'A_warm' }), agent: agentA });
  await waitForPending(1);
  pending.shift()();
  await warmA;

  const warmB = request(port, { body: JSON.stringify({ tag: 'B_warm' }), agent: agentB });
  await waitForPending(1);
  pending.shift()();
  await warmB;

  // Budget is now 5000 (below LOW_WATERMARK) — concurrencyLimit = 1.
  // Both connections are warm. Send A1 and B1 simultaneously.
  const r1 = request(port, { body: JSON.stringify({ tag: 'A1' }), agent: agentA });
  const r2 = request(port, { body: JSON.stringify({ tag: 'B1' }), agent: agentB });

  // One gets dispatched, the other waits in the toklock queue.
  // Wait for the first to reach upstream.
  await waitForPending(1);
  pending.shift()(); // release first — triggers dispatch of second

  // Wait for second to reach upstream, then release it.
  await waitForPending(1);
  pending.shift()();

  await Promise.all([r1, r2]);

  // A1 and B1 must be consecutive — proves round-robin, not starvation
  const a1 = dispatched.indexOf('A1');
  const b1 = dispatched.indexOf('B1');
  assert.ok(a1 !== -1 && b1 !== -1, `Both agents should be served. Got: ${dispatched}`);
  assert.equal(Math.abs(a1 - b1), 1, `A1 and B1 should be dispatched back-to-back. Got: ${dispatched}`);

  agentA.destroy();
  agentB.destroy();
  await close(proxy);
  await close(up);
});

test('429 re-queues request to front and pauses dispatch', async () => {
  let callCount = 0;

  const { server: up, port: upPort } = await mockUpstream((req, res) => {
    callCount++;
    if (callCount === 1) {
      // First call returns 429
      res.writeHead(429, { 'retry-after': '1' });
      res.end('rate limited');
    } else {
      // Retry succeeds
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ retried: true }));
    }
  });

  const { proxy, port } = await startProxy(upPort);

  const start = Date.now();
  const { status, body } = await request(port);
  const elapsed = Date.now() - start;

  assert.equal(status, 200);
  assert.deepEqual(JSON.parse(body), { retried: true });
  assert.equal(callCount, 2, 'Should have been called twice (429 then retry)');
  assert.ok(elapsed >= 900, `Should have waited ~1s for retry-after, got ${elapsed}ms`);

  await close(proxy);
  await close(up);
});

test('responds with 502 when upstream is unreachable', async () => {
  // Point at a port nothing is listening on
  const { proxy, port } = await startProxy(19999);

  const { status, body } = await request(port);
  assert.equal(status, 502);
  assert.ok(JSON.parse(body).error.type === 'toklock_upstream_error');

  await close(proxy);
});

test('handles concurrent requests from same connection', async () => {
  let count = 0;
  const { server: up, port: upPort } = await mockUpstream((req, res) => {
    count++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(`{"n":${count}}`);
  });

  const { proxy, port } = await startProxy(upPort);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 5 });

  const results = await Promise.all([
    request(port, { agent }),
    request(port, { agent }),
    request(port, { agent }),
  ]);

  assert.ok(results.every(r => r.status === 200));
  assert.equal(count, 3);

  agent.destroy();
  await close(proxy);
  await close(up);
});

test('streams response body through', async () => {
  const { server: up, port: upPort } = await mockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: chunk1\n\n');
    res.write('data: chunk2\n\n');
    res.end();
  });

  const { proxy, port } = await startProxy(upPort);

  const { status, body } = await request(port);
  assert.equal(status, 200);
  assert.ok(body.includes('chunk1'));
  assert.ok(body.includes('chunk2'));

  await close(proxy);
  await close(up);
});
