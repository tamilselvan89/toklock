/**
 * toklock — Token-aware rate-limit queue proxy for the Anthropic Claude API
 * Copyright 2026 Tamilselvan Chandran
 * SPDX-License-Identifier: Apache-2.0
 *
 * How it works:
 *   1. All requests are queued and processed serially.
 *   2. Before each request, the current token budget is checked.
 *   3. If budget is too low, the queue pauses until Anthropic's reset time.
 *   4. After each response, the budget is updated from real response headers
 *      (anthropic-ratelimit-tokens-remaining, anthropic-ratelimit-tokens-reset).
 *   5. On 429: the request is re-queued and the proxy waits for Retry-After.
 *
 * Callers never see a 429. They just wait.
 */

import http from 'http';

const UPSTREAM     = 'https://api.anthropic.com';
const DEFAULT_PORT = 4000;
const SAFETY_MARGIN = 2000; // keep 2k tokens below org limit

// ── State ─────────────────────────────────────────────────────────────────────

let budget      = null;   // null = unknown (will be set from first response)
let resetAt     = 0;      // epoch ms when the current rate-limit window resets
let orgLimit    = null;   // learned from anthropic-ratelimit-tokens-limit header

const queue     = [];
let draining    = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(`[toklock ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

/**
 * Estimate input tokens from a request body buffer.
 * Uses request body content length as a proxy (4 chars ≈ 1 token).
 * Over-estimates to be conservative.
 */
function estimateTokens(bodyBuf) {
  try {
    const body = JSON.parse(bodyBuf.toString());
    let chars = 0;
    if (body.system)   chars += typeof body.system === 'string' ? body.system.length : JSON.stringify(body.system).length;
    if (body.messages) chars += JSON.stringify(body.messages).length;
    return Math.ceil(chars / 4) + (body.max_tokens || 1024);
  } catch {
    return Math.ceil(bodyBuf.length / 4);
  }
}

/** Parse ISO 8601 or numeric seconds reset header into epoch ms */
function parseReset(header) {
  if (!header) return 0;
  const n = Number(header);
  if (!isNaN(n)) return Date.now() + n * 1000;
  const d = new Date(header);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

// ── Queue drain loop ──────────────────────────────────────────────────────────

async function drain() {
  if (draining) return;
  draining = true;

  while (queue.length > 0) {
    const item = queue[0];
    const effectiveLimit = orgLimit ? orgLimit - SAFETY_MARGIN : 28000;

    // If budget is known and low, wait for the reset window
    if (budget !== null && budget < Math.min(item.estimated, 4000)) {
      const wait = Math.max(500, resetAt - Date.now() + 300);
      log(`budget=${budget} need≈${item.estimated} — pausing ${(wait / 1000).toFixed(1)}s (${queue.length} queued)`);
      await new Promise(r => setTimeout(r, wait));
      // After waiting, assume budget refilled (headers will correct it)
      if (Date.now() >= resetAt) budget = effectiveLimit;
    }

    queue.shift();

    // Optimistic deduction before we know the real cost
    if (budget !== null) budget = Math.max(0, budget - item.estimated);

    try {
      const headers = { ...item.headers, host: 'api.anthropic.com' };
      delete headers['content-length'];

      const resp = await fetch(`${UPSTREAM}${item.path}`, {
        method:  item.method,
        headers,
        body:    item.method !== 'GET' && item.body.length ? item.body : undefined,
      });

      // ── 429: re-queue and block ────────────────────────────────────────────
      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get('retry-after') || '60', 10);
        resetAt = Date.now() + retryAfter * 1000;
        budget  = 0;
        log(`429 received — blocking ${retryAfter}s, re-queuing (${queue.length + 1} total)`);
        if (item.estimated && budget !== null) budget += item.estimated; // refund
        queue.unshift(item);
        continue;
      }

      // ── Update budget from real response headers ───────────────────────────
      const remHdr   = resp.headers.get('anthropic-ratelimit-tokens-remaining');
      const resetHdr = resp.headers.get('anthropic-ratelimit-tokens-reset');
      const limHdr   = resp.headers.get('anthropic-ratelimit-tokens-limit');

      if (limHdr)   orgLimit = parseInt(limHdr, 10);
      if (remHdr !== null)  budget  = parseInt(remHdr, 10);
      if (resetHdr) resetAt = parseReset(resetHdr);

      log(`✓ ${resp.status} | budget=${budget ?? '?'} remaining | queue=${queue.length}`);
      item.resolve({ resp });

    } catch (err) {
      log(`upstream error: ${err.message}`);
      item.resolve({ err });
    }
  }

  draining = false;
}

// ── HTTP proxy server ─────────────────────────────────────────────────────────

export function createProxy({ port = DEFAULT_PORT, verbose = false } = {}) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const body      = Buffer.concat(chunks);
      const estimated = estimateTokens(body);
      const headers   = { ...req.headers };

      const { resp, err } = await new Promise(resolve => {
        queue.push({ body, headers, method: req.method, path: req.url, estimated, resolve });
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
    log(`set ANTHROPIC_BASE_URL=http://127.0.0.1:${port} — no 429s will reach your agents`);
  });

  return server;
}
