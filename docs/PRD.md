# markfetch — PRD

## 1. Problem & Why

Built-in tools of AI coding agents do not deliver good quality markdown (if they deliver at all); bot-detection systems also block many of them, even when the underlying request is a legitimate single-document fetch. I need a reliable per-call tool to convert public web pages into clean markdown for later information processing.

## 2. Goals & Non-Goals

### Goals

- **Browser-quality markdown for any HTML URL.** Output should be indistinguishable from a human running Reader View → "Save as Markdown."
- **Real-browser HTTP fingerprint.** HTTP/2 transport + coherent Chrome header set, so the wire-level signature matches what a real Chrome browser sends. Sites that score traffic by browser-likeness (Cloudflare, Akamai) accept the requests at Chrome's rate, not curl's.
- **Easy install via `npx markfetch`.** Zero config beyond the MCP client entry. Single-binary distribution is deferred to v2 (see §7).
- **Minimal tool surface.** One tool, one required parameter, one optional escape valve (`savePath`, see §5). Deterministic shape, structured errors. Built for an LLM caller, not a human operator.

### Non-Goals (explicit — do not "helpfully" add later)

- **No alternative tool modes** (`raw` HTML, JSON content, multi-tool surface). One job, one shape.
- **No pagination.** Full document or `too_large` failure. See §5 rationale.
- **No `robots.txt` parsing.** Robots.txt is a crawler-policy file — it tells automated crawlers which URL prefixes to recurse into. markfetch is a per-call fetch tool, not a crawler, so there is no recursion to govern. Users remain responsible for respecting target sites' terms of service (see README §Responsible use).
- **No authentication in v1.** Anonymous fetch only. No cookie jar, no auth headers, no session reuse. Pages behind login walls return whatever the public response is (often a redirect, surfaced as `http_error`). Auth (env-var header injection or Chrome-cookie import) is an explicit v2 target — see §7.
- **No published-binary distribution** in v1. npm + `npx` is the install path; single-binary distribution is a v2 question (see §7).
- **No CloudFlare `/markdown` fallback** in v1.
- **No response caching.** Each call hits the network.
- **No human UX.** No progress output, no colored logs, no interactive prompts. Stderr is fatal-only.

## 3. Design Principles

Behavioral rules that govern *how* the tool acts, not *what* features it has. If a change breaks one of these, it's the wrong change.

1. **Deterministic outputs.** Same URL → same markdown. No LLM in the pipeline, no randomized retries, no probabilistic anything.
2. **Structured failure over silent degradation.** Every failure has a `[code]` prefix (§5). We refuse rather than guess. Empty body means empty body, not "extraction quietly failed."
3. **Whole document or honest failure.** No partial returns, no truncation. See §5.
4. **Stdio-clean.** Stdout is reserved for MCP protocol frames. Stderr is fatal-only — no progress output, no log spam, no ANSI colors that could corrupt stdio framing.
5. **Static configuration.** All knobs are env vars set at server start (§6). The tool surface is identical for every call within a session — agents see no surprises.

## 4. Architecture & Stack

Single TypeScript MCP server on Node.js ≥ 24. No subprocesses, no extra runtimes. End-to-end JS — collapses the original `mcp-server-fetch`'s Python→Node hop.

### Stack

| Concern | Library | Why |
|---|---|---|
| Runtime | Node.js ≥ 24 | Canonical for this category. No bundling drama, no stdio chatter. Distribution via `npx`. Aligned with undici v8's >= 22.19 floor. |
| MCP protocol | `@modelcontextprotocol/sdk` | Official TS SDK, stdio transport |
| HTTP client | `undici` | HTTP/2 native, fine-grained header control |
| HTML parse | `linkedom` | ~10× lighter than jsdom, ESM-native; integrates with Readability via `parseHTML(html).document` (no adapter) |
| Content extraction | `@mozilla/readability` | The actual algorithm browsers use for Reader View |
| HTML → Markdown | `turndown` | Native JS port of the algorithm `markdownify` ports back |
| GFM extensions | `turndown-plugin-gfm` | Adds pipe-tables, strikethrough, and task-list rules — turndown ships none by default |

Explicitly *not* in the stack: Playwright, Puppeteer, headless Chromium, Python, `robots-parser`.

### Data flow

```
URL
  → undici.fetch (HTTP/2, full Chrome header set, follow redirects)
  → response body (UTF-8 decoded per Content-Type charset)
  → linkedom.parseHTML (parse to DOM)
  → @mozilla/readability (extract article DOM)
  → turndown (DOM → markdown)
  → MCP content[0].text
```

### Markdown quality

A small set of named output-shape decisions on top of the canonical extract-and-convert pipeline. Each is a one- or two-line change with an inline comment citing the defect class it addresses; behavior is pinned by snapshot fixtures under `tests/fixtures/`.

- **GFM tables, strikethrough, task lists** via `turndown-plugin-gfm`. Vanilla turndown ships no `<table>` rule and emits raw HTML; the gfm plugin gives us pipe-tables that both Markdown renderers and LLM consumers parse.
- **Code-fence language hints preserved.** Readability is configured with `keepClasses: true` so `class="language-X"` on `<code>` survives to turndown's default fenced-code rule, which emits the language tag after the opening backticks. Default Readability strips all classes except `page`; the resulting bare fence loses syntax-language information that LLM consumers benefit from.
- **Minimal escape policy.** turndown's default `escape()` over-fires on intraword underscores (`list_tools` → `list\_tools`) and on hyphens/equals signs at text-node start after inline elements (`[foo](url)\-based`) — patterns CommonMark cannot interpret as structural. The override drops those escapes while preserving every other default (brackets, asterisks, true line-leading list and heading markers). A negative-lookbehind guard on the second strip preserves literal backslashes that source HTML occasionally carries (e.g. `\-X` in CLI/TeX prose).
- **Bare `<pre>` code-block rule.** Sphinx-style code samples (Python docs, many tech blogs) emit bare `<pre>` without a nested `<code>`. Turndown's default fenced-code rule only fires on `<pre><code>`; bare `<pre>` falls through to general block handling and emits the contents as escaped prose (`\>\>\>`, `\$`). A custom `barePre` rule fires on `<pre>` without a `<code>` child and emits the `textContent` inside an unlabeled fenced block, keeping source code raw.

Pre-Readability robustness patches (URL absolutization for linkedom; entity-decoded Webflow-style `<code>` tags; DOM normalization for Readability's known quirks on `<aside>`, `<details>`, MediaWiki heading wrappers) sit below PRD level — they don't change the output contract, only the corpus of pages on which extraction succeeds. They live as small named functions in, each with a comment naming the specific defect that motivated it.

### Browser fingerprint

Real-browser fingerprint, not just a `User-Agent`. A Chrome UA with no accompanying headers is a *stronger* automation signal than a curl UA — it's clearly lying. Always sent:

- `User-Agent` (Chrome, configurable via env)
- `Accept`, `Accept-Language`, `Accept-Encoding`
- `Sec-Fetch-Dest`, `Sec-Fetch-Mode`, `Sec-Fetch-Site`, `Sec-Fetch-User`
- `Sec-CH-UA`, `Sec-CH-UA-Mobile`, `Sec-CH-UA-Platform` — must be coherent with the UA string
- `Upgrade-Insecure-Requests`

HTTP/2 is the transport, not HTTP/1.1. This is a load-bearing decision: modern bot-detection scoring weighs wire protocol alongside headers, and HTTP/1.1 with a Chrome header set is internally inconsistent.

## 5. Tools

**Name**: `fetch_markdown`. Descriptive, on-brand with the project, unambiguous about what comes back.

### Input

| Field | Type | Required | Purpose |
|---|---|---|---|
| `url` | `string` | yes | Absolute http(s) URL of the page to fetch. |
| `savePath` | `string` | no | Absolute filesystem path where the fetched markdown should be written. When provided, the response becomes a small confirmation instead of the full markdown body (see Output). Schema requires `startsWith("/")` — relative paths and tilde-paths (`~/x.md`) are rejected at the boundary. The caller is responsible for ensuring the parent directory exists; existing files are overwritten. **Invariant**: the file at `savePath` is only ever the markdown of the URL — fetch errors do not touch the file (see Errors). |

No pagination, no per-call overrides for fetch behavior. Everything else (`user_agent`, timeout, byte cap) is env-var-configured — see §6.

**Why no pagination**: an agent calling this tool wants the whole document, not a window into it. Pagination would push chunk-bookkeeping onto the agent (which it does poorly) and lets it reason over partial content without knowing it's partial — a correctness hazard. If the document doesn't fit, we refuse with `too_large` rather than ship a half-truth. The server's contract is full document or honest failure.

**Why `savePath`**: every consumer of `fetch_markdown` (Claude Code's harness, other clients) imposes its own opinion on how big an inline tool-result string is allowed to be. Those caps are external to markfetch and outside our control. Letting the caller route bytes directly to disk turns a "did the harness inline this or did it spill?" probability into a deterministic file-on-disk. Same pattern as `curl` vs `curl -o file` — the option doesn't make the default worse for small responses, it gives big-response callers an escape valve. The default ("fetch and read") is unchanged.

### Output

**Single channel always: `content[0].text`. Nothing else.** No `structuredContent`, no `outputSchema`, no frontmatter, no metadata fields.

The text content depends on whether `savePath` was provided in the input:

- **Without `savePath`** (default — "fetch and read"): `content[0].text` is the full markdown body.
- **With `savePath`** ("fetch and save"): the markdown is written to disk at the given path; `content[0].text` is a single-line confirmation in the form `Saved {bytes} bytes to {path}`. The byte count is `Buffer.byteLength(markdown, "utf8")` — i.e. the size on disk, useful as a hash-free integrity check for downstream readers.

Both paths stay on the same channel deliberately: modern MCP clients hide `content[]` when `structuredContent` is present, which would make the response unreachable to the very LLM that called the tool. Both ends of the call already know the input URL and any savePath they passed; embedding source/title metadata in the response is dead weight either way. If a downstream consumer needs more structure, they construct it on their side: the URL they passed in is the source; the title can be derived from the first heading; nothing in the response is hidden from them.

As of May 2026, this is the shape used by `mcp-server-fetch`, `mcp-server-filesystem`, Linear MCP, and most production MCP servers — the spec's `structuredContent` channel exists, but the LLM-facing-tool ecosystem hasn't moved to it yet.

### Errors

Returned as MCP tool errors (`isError: true`) with a `[code]` prefix in the message so agents can branch on prefix match without JSON parsing.

| Code | Trigger |
|---|---|
| `network_error` | DNS / TCP / TLS failure |
| `http_error` | Non-2xx response (status code in message) |
| `timeout` | Exceeded `MARKFETCH_TIMEOUT_MS` |
| `unsupported_content_type` | Non-HTML response — we deliberately refuse (see §2 non-goals) |
| `extraction_failed` | HTML fetched but Readability returned no article content. Message: "Readability returned no article content." Common causes (not enumerated in the message): JS-rendered SPAs, paywalls, body-less pages. |
| `too_large` | Response body or extracted markdown exceeds `MARKFETCH_MAX_BYTES`. Hard failure — we never return partial documents (see Input). |
| `save_failed` | `savePath` was provided and the fetch+extract+convert pipeline succeeded, but `fs.writeFile` rejected. Format: `[save_failed] {errno_code}: {message}` — e.g. `ENOENT` (parent directory missing), `EACCES` (permissions), `EISDIR` (path is a directory). The file is not created on failure. **Note**: this code only fires when the fetch itself succeeded; a fetch error with `savePath` set returns its own `[code]` and never touches the disk (see Input invariant). |

## 6. Distribution & Config

### Build

`tsc` compiles `src/` to `dist/` (ESM). Distributed as an npm package; users invoke via `npx markfetch` (the `bin` field in `package.json` registers the binary name).

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MARKFETCH_TIMEOUT_MS` | `30000` | Per-request timeout — triggers `timeout` (§5) when exceeded |
| `MARKFETCH_MAX_BYTES` | `5000000` (5 MB) | Cap on response body and extracted markdown — triggers `too_large` (§5) |
| `MARKFETCH_USER_AGENT` | Current pinned Chrome UA | Override the UA. Must be a coherent Chrome string since `Sec-CH-UA*` headers are derived from it |

`MARKFETCH_TIMEOUT_MS` and `MARKFETCH_MAX_BYTES` are validated at startup — invalid values (empty, NaN, negative, non-integer) fail fast with a clear stderr error rather than silently turning into a confusing per-request error.

## 7. Deferred / Open Questions

Captured here so v1 stays small. Each item names a possible feature and the trigger that would prompt picking it up.

### Likely v2 candidates

- **Authentication.** Two shapes worth considering:
  - (a) `MARKFETCH_AUTH_HEADER` env var injected on every request — simple, generic.
  - (b) Chrome-cookie import for sites where the user is already logged in (e.g., read cookies from `~/Library/Application Support/Google/Chrome/Default/Cookies`) — frictionless but platform-specific and security-sensitive.
  - **Trigger**: first time we hit a useful internal/paywalled doc.
- **Cookie jar within a single fetch.** Some sites set a session cookie on first request and serve content only after a redirect that includes it. We don't reuse cookies across redirects in v1. **Trigger**: a target site returns content only after accepting a cookie.
- **JS rendering fallback (SPAs).** Playwright / headless Chrome — too heavy for the main binary, would ship as a separate companion (e.g., `markfetch-heavy`) so the lean binary stays lean. **Trigger**: enough useful sites returning `extraction_failed` to be annoying.
- **CloudFlare `/markdown` fallback.** Gated by `CF_AUTH_TOKEN`; fall back when Readability fails. Trade-off: dependency on an external paid API. **Trigger**: extraction failure rate stays high after Readability tuning.
- **Proxy support** (`MARKFETCH_PROXY_URL`). Useful for testing and geo-restricted content. **Trigger**: first time we want to fetch through a corporate proxy.
- **Accept-Language control** (`MARKFETCH_ACCEPT_LANGUAGE`). For sites that serve locale-specific content. **Trigger**: getting wrong-language content from a global site.
- **Single-binary distribution.** Investigation paths: Bun, Node SEA (built-in, experimental in Node 20, stabilizing), `pkg` (deprecated), `nexe`, or revisit bun once `bun build --compile` bundling stabilizes for jsdom-class issues. **Trigger**: feedback that `npx` install-on-first-run latency is a problem, or a need for offline/airgapped distribution.

### Less likely / uncertain

- **Response caching with TTL.** Trade-off: speed vs. freshness. Probably the agent's job, not ours.
- **Header profile selector** (Firefox / Safari / mobile fingerprints). Single Chrome profile is probably enough; Chrome alone is the dominant browser-likeness signal most CDNs accept by default.
- **Native passthrough for non-HTML content** (PDF, plain text, JSON). Currently `unsupported_content_type` failure. Each handler bloats scope.
