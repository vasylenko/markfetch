# markfetch — SPEC

## Architecture

Text processing pipeline:

```
URL
  → undici.fetch       HTTP/2 via ALPN; full Chrome header set; Sec-CH-UA-* derived from UA
  → linkedom.parseHTML
  → @mozilla/readability
  → turndown + GFM     HTML → markdown
  → caller             markdown body, or "Saved N bytes to /path" confirmation
```

Errors throw `MarkfetchError` uniformly from core; adapters catch once. Codes: `network_error`, `http_error`, `timeout`, `unsupported_content_type`, `extraction_failed`, `too_large`, `save_failed`. CLI emits `[code] message` to stderr and exits 1; MCP emits `{ isError: true, content: [{ text: "[code] message" }] }`.

## Core Decisions

- **Argv-discriminated dispatch.** `argv.length === 2` (bare invocation) routes to MCP — preserving every existing client config, which all spawn with zero args. Any argument routes to CLI. No `--mcp` flag, no separate `markfetch-mcp` bin, no `isTTY` sniffing.

- **Lazy adapter imports.** The dispatcher uses `await import()` to load exactly one adapter. The only `console.log` in the project lives in `cli.ts`; under MCP, `cli.ts` never loads, so stdout-discipline is enforced by the module graph — not by linter or convention.

- **Core throws, adapters translate.** All 7 error codes surface from `core.ts` — five are thrown explicitly as `MarkfetchError`; `network_error`, `timeout`, and (sometimes) `http_error` are translated by `classifyError` from underlying-API errors (undici TypeErrors, AbortSignal timeouts). New codes need an `ErrorCode` union member + a throw site; adapters don't change.

- **HTTP/2 + coherent Chrome fingerprint.** Wire protocol, headers, and UA must agree — a Chrome UA over HTTP/1.1 or without `Sec-CH-UA-*` is *more* suspicious than curl. `Sec-CH-UA-*` is derived from `MARKFETCH_USER_AGENT` at startup so override-coherence is mechanical.

- **Single-channel MCP response.** `content[0].text` only. Modern MCP clients hide `content[]` when `structuredContent` is present, which would route the response away from the LLM that called the tool.

- **Whole document or `too_large`.** No pagination. Partial content lets the agent reason over truncated bodies without knowing they're truncated. `savePath` / `-o` is the escape valve for genuinely large documents.

- **Asymmetric `savePath`.** MCP requires absolute paths (zod `startsWith("/")`); CLI accepts relative and resolves against `process.cwd()`. CLI has a stable cwd the user typed `cd` into; MCP servers run in whatever cwd the client picks.

- **Stderr is fatal-only.** Per-request MCP errors round-trip through `{ isError }`; only startup misconfig / unrecoverable crashes touch stderr. CLI is its own session, so its per-request errors *are* fatal for that session. Regression guard: `tests/server.test.ts:436`.

## Ideas for future

- **Authentication.** `MARKFETCH_AUTH_HEADER` env var (simple), or Chrome-cookie import for sites where the user is already logged in (frictionless, platform-specific, security-sensitive). Trigger: first useful internal / paywalled doc.
- **JS rendering fallback for SPAs.** Playwright / headless Chrome as a companion package (`markfetch-heavy`) so the lean package stays lean. Trigger: enough useful sites returning `extraction_failed`.
- **CloudFlare `/markdown` fallback.** Gated by `CF_AUTH_TOKEN`; fall back when Readability fails. Trigger: extraction failure rate stays high after Readability tuning.
- **Cookie reuse across redirects within a single fetch.** Currently none. Trigger: a target serves content only after a session-cookie redirect.
- **Proxy support** (`MARKFETCH_PROXY_URL`) and **`Accept-Language` control** (`MARKFETCH_ACCEPT_LANGUAGE`). Trigger: corporate proxy / locale-specific content.
- **Single-binary distribution.** Bun's `build --compile`, Node SEA, or similar. Trigger: `npx` first-run latency feedback, or an offline / airgapped need.
- **Windows-friendly `savePath` schema.** Currently Unix-shaped (`startsWith("/")`). Trigger: someone needs this on Windows.
