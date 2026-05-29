# toklock

**Token-aware rate-limit queue proxy for the Anthropic Claude API.**  
Your AI agents never see a 429. They just wait — and every agent gets a fair share.

[![npm version](https://img.shields.io/npm/v/toklock)](https://www.npmjs.com/package/toklock)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

---

## The Problem

Every existing LLM proxy handles rate limits by **returning a 429 to the caller**.  
Your agent crashes. You add retry logic. The retry collides with other agents. You crash again.

Worse — when you run multiple agents against a shared token budget, one greedy agent
can exhaust the quota and starve every other agent waiting in the same queue.

```
Agent A ──→ Anthropic API  ✓ (consumes entire budget)
Agent B ──→ Anthropic API  ✗ 429  ← crashes
Agent C ──→ Anthropic API  ✗ 429  ← crashes
```

## The Solution

toklock sits between your agents and `api.anthropic.com`.  
It gives **each agent its own queue** and serves them in round-robin order,
so no single agent can starve others. Budget decisions use real Anthropic
response headers — no guessing, no estimation.

```
Agent A ──→ toklock ──→ Anthropic API  ✓
Agent B ──→ toklock     [fair share]   ✓  ← round-robin scheduled
Agent C ──→ toklock     [fair share]   ✓  ← round-robin scheduled
```

### What makes toklock different

| Tool | Approach | Caller sees 429? | Fair across agents? |
|------|----------|-----------------|---------------------|
| Anthropic SDK | Retry 2x with backoff | Yes (after retries) | No |
| Helicone | Bounded retry | Yes (after N retries) | No |
| LiteLLM OSS | Returns 429 immediately | Yes | No |
| LiteLLM Enterprise | Queue (paid) | No | No |
| **toklock** | **Per-agent queue, round-robin** | **Never** | **Yes** |

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

## Use with Claude Code agents

Set `ANTHROPIC_BASE_URL` before launching your agents:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4000
./run-agent.sh ceo
./run-agent.sh backend-engineer
./run-agent.sh qa-engineer
# All three share the same token budget fairly. None will crash.
# Each agent gets equal scheduling priority via round-robin.
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

### Per-connection fair queuing

Each TCP connection to toklock gets its own FIFO queue. Since each agent process
opens its own connection, this maps naturally to one queue per agent — no
configuration needed.

When the token budget is scarce, toklock round-robins across all connection queues.
An agent that sends 100 requests gets the same scheduling share as an agent that
sends 1.

### Reactive budget control

toklock never estimates token costs. All throttling decisions are made from
Anthropic's real response headers:

| Header | Used for |
|--------|----------|
| `anthropic-ratelimit-tokens-remaining` | Current budget after each response |
| `anthropic-ratelimit-tokens-reset` | When the window resets |
| `retry-after` | How long to pause on a 429 |

### Three budget states

```
remaining > 10,000   →  full concurrency (3 parallel requests)
remaining < 10,000   →  slow lane (1 at a time)
remaining < 3,000    →  full pause until reset window
429 received         →  pause for Retry-After, re-queue to front
```

### 429 handling

On a 429, the request is placed back at the **front of its own connection queue**
and all new dispatches pause for the full `Retry-After` duration. When the pause
clears, that request is next — nothing jumps ahead of it during the wait.

### Request flow

1. **Queue** — request enters its connection's FIFO queue
2. **Schedule** — round-robin picks the next request across all connections
3. **Check** — budget state determines concurrency level
4. **Dispatch** — request is forwarded to `api.anthropic.com`
5. **Correct** — real token counts from response headers update the budget
6. **Repeat** — next queued request is evaluated

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
