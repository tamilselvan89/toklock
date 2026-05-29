/**
 * toklock — Token-aware rate-limit queue proxy for the Anthropic Claude API
 * Copyright 2026 Tamilselvan Chandran
 * SPDX-License-Identifier: Apache-2.0
 *
 * How it works:
 *   1. Each TCP connection gets its own FIFO queue (one connection per agent process).
 *   2. A round-robin scheduler picks the next request across all connections,
 *      so no single agent can starve others when the budget is scarce.
 *   3. Up to MAX_CONCURRENCY requests run in parallel under normal budget.
 *   4. After every response, real token remaining is read from Anthropic headers.
 *   5. If remaining < LOW_WATERMARK, concurrency drops to 1.
 *   6. If remaining < CRITICAL_WATERMARK, all dispatch pauses until reset.
 *   7. On 429: request re-queues to the front of its own connection queue
 *      and all dispatch pauses for Retry-After seconds.
 *
 * Callers never see a 429. They just wait.
 * No token estimation — all budget decisions use real Anthropic response headers.
 */

import http from 'http';

const DEFAULT_UPSTREAM   = 'https://api.anthropic.com';
const DEFAULT_PORT       = 4000;
const MAX_CONCURRENCY    = 3;
const LOW_WATERMARK      = 10000;  // tokens — slow to 1 concurrent
const CRITICAL_WATERMARK = 3000;   // tokens — pause all dispatch

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseReset(header) {
  if (!header) return 0;
  const n = Number(header);
  if (!isNaN(n)) return Date.now() + n * 1000;
  const d = new Date(header);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function log(msg) {
  process.stdout.write(`[toklock ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

// ── Proxy factory ─────────────────────────────────────────────────────────────

export function createProxy({ port = DEFAULT_PORT, upstream = DEFAULT_UPSTREAM } = {}) {

  // All state is local to this instance — safe for multiple instances and tests
  let remaining   = null;  // real tokens remaining (null = unknown)
  let resetAt     = 0;     // epoch ms when current rate-limit window resets
  let pausedUntil = 0;     // epoch ms — no new dispatches until this clears (429 wait)
  let inFlight    = 0;     // currently dispatched requests

  const connectionQueues = new Map();  // socket → item[]
  let rrCursor = 0;
  let draining = false;

  function concurrencyLimit() {
    if (remaining === null || remaining >= LOW_WATERMARK) return MAX_CONCURRENCY;
    return 1;
  }

  function hasWork() {
    for (const q of connectionQueues.values()) if (q.length > 0) return true;
    return false;
  }

  function queuedCount() {
    let n = 0;
    for (const q of connectionQueues.values()) n += q.length;
    return n;
  }

  // Round-robin pick across connection queues
  function nextItem() {
    const keys = [...connectionQueues.keys()];
    for (let i = 0; i < keys.length; i++) {
      const idx = (rrCursor + i) % keys.length;
      const q = connectionQueues.get(keys[idx]);
      if (q && q.length > 0) {
        rrCursor = (idx + 1) % keys.length;
        return q.shift();
      }
    }
    return null;
  }

  // ── Dispatch ────────────────────────────────────────────────────────────────

  async function dispatchItem(item) {
    try {
      const headers = { ...item.headers, host: new URL(upstream).host };
      delete headers['content-length'];

      const resp = await fetch(`${upstream}${item.path}`, {
        method:  item.method,
        headers,
        body:    item.method !== 'GET' && item.body.length ? item.body : undefined,
      });

      // ── 429: pause all dispatch, re-queue to front of this connection ───────
      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get('retry-after') || '60', 10);
        pausedUntil = Date.now() + retryAfter * 1000;
        log(`429 — pausing ${retryAfter}s, re-queuing to front (${queuedCount()} queued)`);

        const q = connectionQueues.get(item.socket);
        if (q) {
          q.unshift(item);
        } else {
          // Socket closed while in flight — re-register so drain picks it up
          connectionQueues.set(item.socket, [item]);
        }
        return;
      }

      // ── Update budget from real response headers ────────────────────────────
      const remHdr   = resp.headers.get('anthropic-ratelimit-tokens-remaining');
      const resetHdr = resp.headers.get('anthropic-ratelimit-tokens-reset');

      if (remHdr !== null) remaining = parseInt(remHdr, 10);
      if (resetHdr)        resetAt   = parseReset(resetHdr);

      log(`✓ ${resp.status} | remaining=${remaining ?? '?'} | inflight=${inFlight - 1} | queued=${queuedCount()}`);
      item.resolve({ resp });

    } catch (err) {
      log(`upstream error: ${err.message}`);
      item.resolve({ err });
    }
  }

  // ── Round-robin drain loop ──────────────────────────────────────────────────

  async function drain() {
    if (draining) return;
    draining = true;

    while (hasWork()) {
      // Wait out 429 pause
      if (Date.now() < pausedUntil) {
        const wait = pausedUntil - Date.now() + 50;
        log(`paused — resuming in ${(wait / 1000).toFixed(1)}s | queued=${queuedCount()}`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      // Critical watermark — pause before next dispatch
      if (remaining !== null && remaining < CRITICAL_WATERMARK) {
        const wait = Math.max(500, resetAt - Date.now() + 300);
        log(`critical watermark (${remaining} tokens) — pausing ${(wait / 1000).toFixed(1)}s`);
        await new Promise(r => setTimeout(r, wait));
        remaining = null;  // will be corrected by next response header
        continue;
      }

      // At concurrency limit — wait for a slot to open
      if (inFlight >= concurrencyLimit()) {
        await new Promise(r => setTimeout(r, 20));
        continue;
      }

      const item = nextItem();
      if (!item) break;

      inFlight++;
      dispatchItem(item).finally(() => {
        inFlight--;
        if (hasWork() && !draining) drain();
      });
      // Do not await — loop continues to fill remaining concurrency slots
    }

    draining = false;
    // Guard against work arriving in the gap between hasWork()=false and draining=false
    if (hasWork()) setImmediate(drain);
  }

  // ── HTTP proxy server ───────────────────────────────────────────────────────

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const body    = Buffer.concat(chunks);
      const headers = { ...req.headers };
      const socket  = req.socket;

      // Register connection queue on first request from this socket
      if (!connectionQueues.has(socket)) {
        connectionQueues.set(socket, []);
        socket.once('close', () => {
          const q = connectionQueues.get(socket);
          if (q) {
            // Client is gone — resolve pending items as error so promises don't hang
            for (const item of q) item.resolve({ err: new Error('client disconnected') });
            connectionQueues.delete(socket);
          }
        });
      }

      const { resp, err } = await new Promise(resolve => {
        connectionQueues.get(socket).push({ body, headers, method: req.method, path: req.url, socket, resolve });
        drain();
      });

      if (err) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message, type: 'toklock_upstream_error' } }));
        return;
      }

      // Forward status + headers
      const outHeaders = {};
      resp.headers.forEach((v, k) => { outHeaders[k] = v; });
      res.writeHead(resp.status, outHeaders);

      // Stream body through — handles SSE for Claude streaming responses
      if (resp.body) {
        const reader = resp.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    });
  });

  server.listen(port, '127.0.0.1', () => {
    log(`listening on 127.0.0.1:${port}`);
    log(`set ANTHROPIC_BASE_URL=http://127.0.0.1:${port} — no 429s, fair round-robin across agents`);
  });

  return server;
}
