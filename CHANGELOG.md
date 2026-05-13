# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-05-14

### Added
- Cross-platform absolute-path validation for `savePath` (MCP). Windows-style paths (`C:\foo`, `C:/foo`, `\\server\share`, `\foo`) are now accepted alongside POSIX absolute paths. The schema delegates to `path.isAbsolute()` so it stays correct on whichever platform the process runs.
- Write sandbox restricting MCP `savePath` writes. By default the allowed set is `realpath(os.tmpdir())` ∪ `realpath(process.cwd())`. Symlinks are resolved via `fs.realpath` before the containment check, so a planted symlink inside the sandbox cannot be used to escape. Violations return the new `save_forbidden` error code; no file is created. The CLI is intentionally unrestricted (human at the shell is the security boundary; the LLM via MCP is the threat surface).
- `MARKFETCH_ALLOWED_WRITE_ROOTS` env var: platform-delimiter-separated list of absolute paths (`:` on POSIX, `;` on Windows). When set, **replaces** the default allowed roots entirely. Validated at startup with fail-fast-on-stderr semantics matching existing env-var conventions (`MARKFETCH_TIMEOUT_MS`, `MARKFETCH_MAX_BYTES`, `MARKFETCH_USER_AGENT`).
- `save_forbidden` error code (8th in the contract): returned when a `savePath` resolves outside the configured allowed write roots.
- CI test job now runs on `ubuntu-latest`, `macos-latest`, and `windows-latest`. `shell: bash` is set on the `npm test` step so the test-glob expands consistently across runners.

### Changed
- MCP `savePath` schema replaced the literal `startsWith('/')` constraint with `z.string().refine(path.isAbsolute)`. **Breaking change for MCP callers that previously wrote outside `os.tmpdir()` or `process.cwd()`** — they will now receive `save_forbidden` and must either move the target inside the default roots or set `MARKFETCH_ALLOWED_WRITE_ROOTS`. CLI behavior is unchanged (no sandbox there).
- Resolved code smell SonarQube findings (S4325 redundant `Document` casts, S6594 `String#match` → `RegExp#exec`) — no behavior change, all tests pass. ([c993938](https://github.com/vasylenko/markfetch/commit/c9939385edfbe95f7f34a24ba8e33e5a74ac07f4))
- Documentation and inline comments cleaned up across README, SPEC, source, and test descriptions. Text-only, no runtime change. ([#2](https://github.com/vasylenko/markfetch/pull/2))

## [0.5.0] - 2026-05-12

### Added
- CLI mode — `markfetch <url>` fetches a URL and prints clean markdown to stdout. `-o, --output <path>` writes to a file (absolute or relative; relative paths resolve against cwd) with a confirmation on stdout. `--help` / `--version` work as expected. Bare `markfetch` (zero arguments) continues to start the MCP stdio server, so every existing MCP client config keeps working unchanged.
- `commander` runtime dependency (v14.x, 0 transitive deps) — used by the CLI adapter for argv parsing, help, and version.

### Changed
- Source restructured into `src/core.ts` (pipeline + errors), `src/mcp.ts` (MCP adapter), `src/cli.ts` (CLI adapter), and `src/index.ts` (argv-discriminated dispatcher that lazy-imports the right adapter based on `process.argv.length`). No public-API change for MCP consumers — tool name, input schema, error codes, and output shape are byte-identical to 0.4.1. The lazy-import dispatcher makes the "stdout is reserved for MCP frames" invariant structural: `cli.ts` is never loaded in MCP mode, so no code that calls `console.log` is reachable from the MCP path.
- 3 inline `return errorResult(...)` sites in the MCP handler (`extraction_failed`, post-conversion `too_large`, `save_failed`) now `throw MarkfetchError` from core uniformly; both adapters catch and convert. Same observable error messages.

## [0.4.1] - 2026-05-11

### Fixed
- `bin` entry in `package.json` uses `dist/index.js` instead of `./dist/index.js` — npm 10+ stricter validation considered the leading `./` invalid and warned about silently stripping the entry on publish.

### Changed
- README rewritten for npm publication: bold subtitle, badge row (npm/CI/node/license), comparison table vs. alternative approaches (built-in agent fetch, Playwright, `mcp-server-fetch`, CloudFlare `/markdown`), reference table for the 7 error codes, and a "What it is not" scope-boundary section.
- PRD: forward-looking statements consolidated under §7 "Deferred / Open Questions" so the body reflects current state only.

## [0.4.0] - 2026-05-10

### Added
- Single MCP tool `fetch_markdown(url, savePath?)` — returns markdown in `content[0].text`, single channel, no `structuredContent`.
- Real-browser fingerprint: HTTP/2 transport + coherent Chrome header set, with `Sec-CH-UA-*` client hints derived from `MARKFETCH_USER_AGENT` at startup.
- Optional `savePath` parameter routes the markdown directly to disk for callers whose tool-result inline cap would otherwise truncate large responses.
- 7 deterministic error codes: `network_error`, `http_error`, `timeout`, `unsupported_content_type`, `extraction_failed`, `too_large`, `save_failed`.
- Environment-variable validation at startup for `MARKFETCH_TIMEOUT_MS`, `MARKFETCH_MAX_BYTES`, and `MARKFETCH_USER_AGENT` — invalid values fail fast on stderr instead of producing confusing per-request errors.
- Snapshot tests for nine fixtures covering escape policy, anchor chrome, code-fence language hints, multi-line table cells, and other extraction edge cases.

### Notes
- License: MIT.
- Distribution: npm package, invoked via `npx markfetch`.
- Requires Node.js ≥ 24.
