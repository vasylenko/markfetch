# markfetch — SPEC

## Architecture

Text processing pipeline:

```
URL
  → undici.fetch       HTTP/1.1; full Chrome header set; Sec-CH-UA-* derived from UA
  → linkedom.parseHTML
  → @mozilla/readability
  → turndown + GFM     HTML → markdown
  → caller             markdown body, or "Saved N bytes to /path" confirmation
```

`raw` mode (`--raw` / MCP `raw`) returns the body straight from `undici.fetch`, skipping the parse → extract → convert steps.

Errors throw `MarkfetchError` uniformly from core; adapters catch once. Codes: `network_error`, `http_error`, `timeout`, `unsupported_content_type`, `extraction_failed`, `too_large`, `save_failed`; plus `save_forbidden`, emitted by the MCP adapter only (before `fetchMarkdown` runs — see "Asymmetric write sandbox" under Core Decisions). CLI emits `[code] message` to stderr and exits 1; MCP emits `{ isError: true, content: [{ text: "[code] message" }] }`.

## Core Decisions

- **Argv-discriminated dispatch.** `argv.length === 2` (bare invocation) routes to MCP — preserving every existing client config, which all spawn with zero args. Any argument routes to CLI. No `--mcp` flag, no separate `markfetch-mcp` bin, no `isTTY` sniffing.

- **Lazy adapter imports.** The dispatcher uses `await import()` to load exactly one adapter. The only `console.log` in the project lives in `cli.ts`; under MCP, `cli.ts` never loads, so stdout-discipline is enforced by the module graph — not by linter or convention.

- **Core throws, adapters translate.** Seven of the eight error codes surface from `core.ts` — five are thrown explicitly as `MarkfetchError`; `network_error`, `timeout`, and (sometimes) `http_error` are translated by `classifyError` from underlying-API errors (undici TypeErrors, AbortSignal timeouts). The eighth code, `save_forbidden`, is the exception — it's emitted by the MCP adapter before `fetchMarkdown` is invoked (see "Asymmetric write sandbox" below). New core codes need an `ErrorCode` union member + a throw site; adapters don't change.

- **HTTP/1.1 + coherent Chrome header fingerprint.** Headers and UA must agree — a Chrome UA without `Sec-CH-UA-*` is a stronger bot signal than curl, so `Sec-CH-UA-*` is derived from `MARKFETCH_USER_AGENT` at startup and override-coherence is mechanical. Wire protocol is deliberately HTTP/1.1, not h2: undici's h2 path hands a pre-connected socket to `node:http2`, whose first-flight frame pattern some CDNs (Cloudflare, observed on `openai.com`) score as a bot and 403 — the identical request over h1.1 is let through. h2 also buys nothing for single-shot GETs, and every h2 server speaks h1.1, so nothing is lost. (The naive expectation — Chrome-over-h1.1 reads as *more* automated than curl — does not hold for these edges.)

- **`raw` passthrough.** `--raw` (CLI) / `raw` (MCP) returns the fetched body verbatim, skipping Readability and the content-type gate but keeping the fetch layer and the `MARKFETCH_MAX_BYTES` cap. Same `fetchMarkdown` code path via a `raw` flag — no second entry point. `unsupported_content_type` and `extraction_failed` cannot arise in this mode. Body is returned as UTF-8 text; binary is not byte-preserved.

- **Single-channel MCP response.** `content[0].text` only. Several major MCP clients (Claude Code CLI, VS Code/Copilot) forward only `structuredContent` to the model and drop `content[]` when both are present — a single-channel response keeps the markdown reachable from those clients.

- **Whole document or `too_large`.** No pagination. Partial content lets the agent reason over truncated bodies without knowing they're truncated. `savePath` / `-o` is the escape valve for genuinely large documents.

- **Asymmetric `savePath`.** MCP requires absolute paths via zod `refine(path.isAbsolute)` — accepts platform-appropriate shapes on POSIX (`/foo`) and Windows (`C:\foo`, `C:/foo`, `\\server\share`, `\foo`). CLI accepts relative and resolves against `process.cwd()`. CLI has a stable cwd the user typed `cd` into; MCP servers run in whatever cwd the client picks.

- **Asymmetric write sandbox.** MCP `savePath` writes are confined to `realpath(os.tmpdir())` ∪ `realpath(process.cwd())` by default; the env var `MARKFETCH_ALLOWED_WRITE_ROOTS` (path-delimiter-separated) replaces the defaults. CLI writes anywhere the human's shell permits — no sandbox check. The asymmetry reflects the threat model: an LLM driving the MCP tool may be steered by content from the page it just fetched; a human typing into a shell is the security boundary. Symlinks are resolved via `fs.realpath` before the containment check, and the resolved path — not the caller's `savePath` — flows into `writeFile`, so a planted symlink inside the sandbox cannot escape. Containment compare is case-insensitive on `process.platform === "win32"`. Implementation lives in `src/sandbox.ts` (a leaf module — no imports from siblings — so it's unit-testable without spinning up the MCP server). Known limitation: TOCTOU between `realpath` and `writeFile` is not closed — acceptable for a single-user developer tool.

- **Stderr is fatal-only.** Per-request MCP errors round-trip through `{ isError }`; only startup misconfig / unrecoverable crashes touch stderr. CLI is its own session, so its per-request errors *are* fatal for that session. Regression guard: `tests/server.test.ts:336`.

## Ideas for future

- **Authentication.** `MARKFETCH_AUTH_HEADER` env var (simple), or Chrome-cookie import for sites where the user is already logged in (frictionless, platform-specific, security-sensitive). Trigger: first useful internal / paywalled doc.
- **JS rendering fallback for SPAs.** Playwright / headless Chrome as a companion package (`markfetch-heavy`) so the lean package stays lean. Trigger: enough useful sites returning `extraction_failed`.
- **CloudFlare `/markdown` fallback.** Gated by `CF_AUTH_TOKEN`; fall back when Readability fails. Trigger: extraction failure rate stays high after Readability tuning.
- **Browser-grade TLS + HTTP/2 impersonation.** Stricter CDN tiers key on Node's TLS JA3/JA4 + UA mismatch and 403 every protocol — neither h1.1 nor `node:http2` beats them (both carry Node's OpenSSL fingerprint under a Chrome UA). A BoringSSL-based impersonating client (Apify's `impit`) delivers genuine HTTP/2 with a Chrome-matching TLS + h2 fingerprint; near-drop-in for `undici.fetch`, one native addon (~6 MB, prebuilt binaries). Trigger: target sites 403 the current h1.1 + Chrome-header approach.
- **Cookie reuse across redirects within a single fetch.** Currently none. Trigger: a target serves content only after a session-cookie redirect.
- **Proxy support** (`MARKFETCH_PROXY_URL`) and **`Accept-Language` control** (`MARKFETCH_ACCEPT_LANGUAGE`). Trigger: corporate proxy / locale-specific content.
- **Single-binary distribution.** Bun's `build --compile`, Node SEA, or similar. Trigger: `npx` first-run latency feedback, or an offline / airgapped need.
