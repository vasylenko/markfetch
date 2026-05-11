# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
