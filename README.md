# toklock

**Token-aware rate-limit queue proxy for the Anthropic Claude API.**  
Your AI agents never see a 429. They just wait.

[![npm version](https://img.shields.io/npm/v/toklock)](https://www.npmjs.com/package/toklock)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

---

## The Problem

Every existing LLM proxy handles rate limits by **returning a 429 to the caller**.  
Your agent crashes. You add retry logic. The retry collides with other agents. You crash again.

```
Agent A ──→ Anthropic API  ✓ (30k tokens used)
Agent B ──→ Anthropic API  ✗ 429 Too Many Requests  ← agent crashes
Agent C ──→ Anthropic API  ✗ 429 Too Many Requests  ← agent crashes
```

## The Solution

toklock sits between your agents and `api.anthropic.com`.  
It **queues requests** and releases them the moment Anthropic's response headers say capacity is available.  
Callers never see a 429. They just wait transparently.

```
Agent A ──→ toklock ──→ Anthropic API  ✓
Agent B ──→ toklock     [queued 47s]   ✓  ← released when budget refills
Agent C ──→ toklock     [queued 47s]   ✓  ← released when budget refills
```

### What makes toklock different

| Tool | Approach | Caller sees 429? |
|------|----------|-----------------|
| Anthropic SDK | Retry 2x with backoff | Yes (after retries) |
| Helicone | Bounded retry | Yes (after N retries) |
| LiteLLM OSS | Returns 429 immediately | Yes |
| LiteLLM Enterprise | Queue (paid) | No |
| **toklock** | **Infinite transparent queue** | **Never** |

toklock uses **real Anthropic response headers** (`anthropic-ratelimit-tokens-remaining`, `anthropic-ratelimit-tokens-reset`) as ground truth — not estimates, not timers. The queue releases at exactly the right moment.

---

## Quickstart

```bash
# Terminal 1 — start the proxy
npx toklock

# Terminal 2 — point your agents at it
export ANTHROPIC_BASE_URL=http://127.0.0.1:4000
claude  # Claude Code
# or any Anthropic SDK call in any language
```

That's it. No config file. No API key changes. Just set `ANTHROPIC_BASE_URL`.

---

## Install

```bash
# Run without installing
npx toklock

# Install globally
npm install -g toklock
toklock --port 4000

# Docker
docker run -p 4000:4000 ghcr.io/tamilselvan89/toklock
```

---

## Options

```bash
toklock --port 4000          # custom port (default: 4000)
TOKLOCK_PORT=4000 toklock    # via env var
```

---

## Use with Claude Code agents (Paperclip, custom frameworks)

Set `ANTHROPIC_BASE_URL` before launching your agents:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4000
./run-agent.sh ceo
./run-agent.sh backend-engineer
./run-agent.sh qa-engineer
# All three share the same token budget. None will crash.
```

## Use with Docker Compose

```yaml
services:
  toklock:
    image: ghcr.io/tamilselvan89/toklock
    ports:
      - "4000:4000"

  agent:
    environment:
      ANTHROPIC_BASE_URL: http://toklock:4000
      ANTHROPIC_API_KEY: sk-ant-...
```

---

## How it works

1. **Queue** — all requests enter a serial queue
2. **Estimate** — token cost is estimated from request body before sending
3. **Check** — if remaining budget < estimated cost, the queue pauses
4. **Wait** — pause until `anthropic-ratelimit-tokens-reset` (exact reset time from headers)
5. **Release** — request is forwarded to `api.anthropic.com`
6. **Correct** — real token counts from response headers update the budget
7. **Repeat** — next queued request is evaluated

On 429: request is re-queued, proxy waits for `Retry-After`, then retries.

---

## Why Apache 2.0?

Apache 2.0 includes an explicit **patent grant** — anyone using toklock is protected from patent claims related to this implementation. We chose this license deliberately to keep the ecosystem open.

---

## Contributing

PRs welcome. Please open an issue first for major changes.

## Author

**Tamilselvan Chandran** — creator of [Visibrand](https://visibrand.app)  
The problem was discovered while building an autonomous AI agent organization running 11 Claude-powered agents in parallel.

## License

Apache 2.0 — see [LICENSE](LICENSE)
