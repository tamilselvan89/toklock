# Changelog

All notable changes to toklock are documented here.

---

## [1.1.2] — 2026-05-29

### Fixed
- Normalized `repository.url` in `package.json` to `git+https://` format to silence `npm publish` warnings

---

## [1.1.1] — 2026-05-29

### Changed
- Added `fair-queue` and `multi-agent` npm keywords for better discoverability

---

## [1.1.0] — 2026-05-29

This release is a significant internal rewrite. The public interface is unchanged — just set `ANTHROPIC_BASE_URL` and go.

### Added
- **Per-connection fair queuing** — each TCP connection (one per agent process) gets its own FIFO queue. No single agent can starve others when the token budget is scarce
- **Round-robin scheduler** — when budget is low, toklock alternates across all connected agents so every agent makes progress
- **Concurrency** — up to 3 requests run in parallel under normal budget (previously serial)
- **LOW_WATERMARK** (10,000 tokens) — concurrency drops to 1 when budget gets thin
- **CRITICAL_WATERMARK** (3,000 tokens) — all dispatch pauses until the rate-limit window resets
- **`upstream` option** on `createProxy` — allows pointing at a custom upstream URL, used for test isolation
- **Integration test suite** — 7 tests covering forwarding, round-robin fairness, 429 re-queue, 502 fallback, concurrency, and SSE streaming

### Changed
- **Removed token estimation** — `estimateTokens()` is gone. All throttling decisions now come from real Anthropic response headers (`anthropic-ratelimit-tokens-remaining`, `anthropic-ratelimit-tokens-reset`). This fixes inaccurate estimates for images, code, and non-Latin text
- **429 handling** — on a 429, the request is placed back at the front of its own connection queue and `pausedUntil` blocks all new dispatches for the full `Retry-After` duration. Nothing can jump ahead during the wait
- All proxy state moved inside `createProxy` — multiple proxy instances can now run independently on different ports

### Removed
- `estimateTokens` function
- `budget`, `orgLimit`, `SAFETY_MARGIN` module-level globals (replaced by reactive `remaining` from headers)
- Single flat `queue` array (replaced by per-connection `connectionQueues` Map)

---

## [1.0.0] — 2026-05-28

Initial release.

### Features
- Token-aware rate-limit queue proxy for the Anthropic Claude API
- Serial queue with token estimation — callers never see a 429
- Budget tracking from `anthropic-ratelimit-tokens-remaining` response headers
- 429 handling with `Retry-After` support
- SSE / streaming response passthrough
- Zero config — set `ANTHROPIC_BASE_URL` and go
- Docker image available at `ghcr.io/tamilselvan89/toklock`
