# markfetch

**Reader View for AI agents and your shell. Fetch any URL, get back clean markdown — with a real Chrome's request fingerprint, not curl's.**

[![npm](https://img.shields.io/npm/v/markfetch.svg?color=10b981&label=npm)](https://www.npmjs.com/package/markfetch)
[![ci](https://github.com/vasylenko/markfetch/actions/workflows/ci.yml/badge.svg)](https://github.com/vasylenko/markfetch/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/markfetch.svg?color=10b981)](https://nodejs.org/)
[![license](https://img.shields.io/npm/l/markfetch.svg?color=10b981)](https://github.com/vasylenko/markfetch/blob/main/LICENSE)

The built-in fetch tools that ship with AI coding agents return raw HTML, broken markdown, or `403` from Cloudflare more often than you'd like. `markfetch` sends **HTTP/2 with a coherent Chrome header set** so bot-detection systems see a real browser, then runs the response through the **same Reader View pipeline your browser uses** (Mozilla's Readability → turndown). The output is markdown indistinguishable from a human running "Save as Markdown" — on sites that would block a naive curl.

One command, two surfaces:

- **CLI** — pass a URL. Print to stdout or `-o` to a file.
```
npm i -g markfetch

markfetch https://en.wikipedia.org/wiki/Markdown

```

- **MCP stdio server** — bare invocation. Drop into Claude Desktop / Claude Code / Cursor / Goose / any stdio-MCP client.

```json
{
  "mcpServers": {
    "markfetch": {
      "command": "npx",
      "args": ["-y", "markfetch"]
    }
  }
}
```

That snippet is the whole MCP setup — or jump to [CLI usage](#cli-usage) to drive the same command from a shell.

## MCP install commands

### Claude Code
```
claude mcp add --scope user markfetch -- npx -y markfetch
```

### Codex
```
codex mcp add markfetch -- npx -y markfetch
```

### Gemini CLI
```
gemini mcp add -s user markfetch npx -y markfetch
```

## Why markfetch?

|  | Real-browser fingerprint | Reader-View extraction | Structured errors | Zero config |
|---|:---:|:---:|:---:|:---:|
| Built-in agent fetch tools | – | – | – | ✓ |
| Generic Playwright / Puppeteer | ✓ | – | – | – |
| `mcp-server-fetch` (Python) | – | basic | – | – |
| CloudFlare `/markdown` | ✓ | ✓ | – | paid |
| **`markfetch`** | **✓** | **✓** | **✓ (8 codes)** | **✓** |

- **Real-browser HTTP/2 + Chrome fingerprint.** ALPN-negotiated h2, `User-Agent`, `Sec-CH-UA-*`, `Sec-Fetch-*`, `Accept-*`. A Chrome UA with no client hints is a *stronger* automation signal than curl — `markfetch` sends the full coherent set, derived from the UA at startup so an override stays internally consistent.

- **Reader-View-quality extraction.** [linkedom](https://github.com/WebReflection/linkedom) → [@mozilla/readability](https://github.com/mozilla/readability) → [turndown](https://github.com/mixmark-io/turndown) with GFM tables, strikethrough, and task lists. Code fences preserve `language-X` hints. Sphinx-style bare `<pre>` blocks render as code, not escaped prose. Intraword underscores stay un-escaped — no more `list\_tools`.

- **One tool, one shape (MCP).** `fetch_markdown(url, savePath?)` returns markdown in `content[0].text`. No `structuredContent`, no frontmatter, no metadata fields. Several major MCP clients (Claude Code CLI, VS Code/Copilot) forward only `structuredContent` to the model and drop `content[]` when both are present — `markfetch` deliberately stays on the channel your LLM can actually read.

- **`savePath` / `-o` escape valve.** Pass an absolute path (MCP `savePath`) or `-o <path>` (CLI) and the markdown lands on disk instead of the response channel. Use it when your client's inline tool-result cap would truncate large responses, or to redirect output from a shell pipeline. The file is only ever the markdown of the URL — fetch errors return a `[code]` string and never touch the disk.

- **Whole document or honest failure.** No pagination, no truncation. If the document doesn't fit in `MARKFETCH_MAX_BYTES`, you get `too_large` — never a half-truth.

- **Stdio-clean.** Stdout is reserved for MCP frames. Stderr is fatal-only. No log spam, no ANSI escapes — keeping stderr parseable for shell consumers.

- **Pure Node, no subprocesses.** No Playwright, no headless Chromium, no Python hop. Single Node process — one Node process whether you invoke it as an MCP server or from the shell.

## CLI usage

`markfetch` doubles as a shell tool: when invoked with at least one argument it parses argv as a CLI instead of starting the MCP server. Bare invocation (zero args) keeps the existing MCP-server behavior — every MCP client config in the wild keeps working unchanged.

```sh
# Print clean markdown to stdout
npx -y markfetch https://example.com/article

# Save to a file (absolute or relative path)
npx -y markfetch https://example.com/article -o article.md

# Pipe into another tool
npx -y markfetch https://example.com/article | pandoc -o article.pdf
```

For repeat use, install once:

```sh
npm i -g markfetch         # then anywhere: markfetch <url>
# or, as a project devDependency
npm i -D markfetch         # then in package.json scripts: "markfetch <url>"
```

Flags:

| Flag | Purpose |
|---|---|
| `-o, --output <path>` | Save markdown to a file (absolute or relative path). Default is stdout. |
| `-V, --version` | Print version and exit. |
| `-h, --help` | Print usage and exit. |

Errors go to stderr with the same `[code] message` shape the MCP tool returns (see the table below), and the process exits with a non-zero status. The same env vars (`MARKFETCH_TIMEOUT_MS`, `MARKFETCH_MAX_BYTES`, `MARKFETCH_USER_AGENT`) apply in both modes. `MARKFETCH_ALLOWED_WRITE_ROOTS` is MCP-only — see [Write sandbox](#write-sandbox).

Errors carry one of eight deterministic codes:

| Code | Meaning |
|---|---|
| `network_error` | DNS / TCP / TLS failure, or an unexpected internal error from the fetcher. |
| `http_error` | Upstream returned a non-2xx status. |
| `timeout` | Per-request budget `MARKFETCH_TIMEOUT_MS` exceeded. |
| `unsupported_content_type` | Response was not `text/html` or `application/xhtml+xml`. |
| `extraction_failed` | Readability returned no article content (typical for pure client-rendered SPAs). |
| `too_large` | Response body or extracted markdown exceeded `MARKFETCH_MAX_BYTES`. |
| `save_failed` | `savePath` was given but `writeFile` failed (parent directory missing, permission denied, etc.). |
| `save_forbidden` | `savePath` resolves outside the allowed write roots — see [Write sandbox](#write-sandbox). MCP-only; the CLI has no sandbox. |

## What it is not

- **Not a crawler.** No recursion, no `robots.txt` parsing, no rate-limit orchestration. One URL in, one document out.
- **Not authenticated.** Anonymous fetch only — no cookie jar, no auth headers, no session reuse. Pages behind login walls return whatever the public response is, usually surfaced as `http_error`.
- **Not a JS renderer.** Pure client-rendered SPAs with no static content return `extraction_failed`. SPAs with server-rendered or SEO-prerendered HTML will extract whatever static content they ship.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MARKFETCH_TIMEOUT_MS` | `30000` | Per-request timeout in ms |
| `MARKFETCH_MAX_BYTES` | `5000000` | Cap on response body and extracted markdown |
| `MARKFETCH_USER_AGENT` | Pinned Chrome 130 string | Override the UA. Must be a Chrome UA — `Sec-CH-UA-*` client hints are derived from it at startup; non-Chrome strings fail fast |
| `MARKFETCH_ALLOWED_WRITE_ROOTS` | `os.tmpdir()` + `process.cwd()` | MCP-only. Path-delimiter-separated list of absolute paths permitted as MCP `savePath` write roots. Replaces the defaults entirely — see [Write sandbox](#write-sandbox) |

Pass overrides via the `env` block of your MCP client config:

```json
{
  "mcpServers": {
    "markfetch": {
      "command": "npx",
      "args": ["-y", "markfetch"],
      "env": {
        "MARKFETCH_TIMEOUT_MS": "60000"
      }
    }
  }
}
```

### Write sandbox

MCP `savePath` writes are confined to a set of allowed root directories. By default the allowed set is `os.tmpdir()` ∪ `process.cwd()` (each resolved via `fs.realpath` once at startup). A `savePath` outside that set returns `save_forbidden` and no file is created.

Override the default set with `MARKFETCH_ALLOWED_WRITE_ROOTS` — a list of absolute paths separated by the platform's path delimiter (`:` on POSIX, `;` on Windows). When set, the override **replaces** the defaults entirely — it does not merge. To keep `os.tmpdir()` or `process.cwd()` accessible, list them yourself; the example below shows `/tmp` for that reason. A malformed value (non-absolute entry, or a directory that doesn't exist) fails fast on stderr at startup.

```json
{
  "mcpServers": {
    "markfetch": {
      "command": "npx",
      "args": ["-y", "markfetch"],
      "env": {
        "MARKFETCH_ALLOWED_WRITE_ROOTS": "/Users/me/markfetch-out:/tmp"
      }
    }
  }
}
```

On Windows, use backslashes and `;` as the delimiter:

```json
{
  "mcpServers": {
    "markfetch": {
      "command": "npx",
      "args": ["-y", "markfetch"],
      "env": {
        "MARKFETCH_ALLOWED_WRITE_ROOTS": "C:\\Users\\me\\markfetch-out;C:\\Users\\me\\AppData\\Local\\Temp"
      }
    }
  }
}
```

Notes:

- **The sandbox is MCP-only by design.** The CLI is unrestricted — a human at the shell is the security boundary, and the markfetch CLI doesn't run any sandbox check at all. The asymmetry exists because the MCP tool is driven by a language model, which may be steered by content from a page it just fetched.
- **Symlinks pointing outside are blocked.** Each candidate `savePath` is resolved via `fs.realpath` to its real destination before the containment check, so a symlink planted inside the sandbox cannot be used to escape.
- **Containment is case-insensitive on Windows** (`C:\Users\Bob` and `c:\users\bob` are the same path).

## Develop

Requires Node.js ≥ 24. Tested on Linux, macOS, and Windows in CI.

When iterating on CLI changes, `tsx src/index.ts <url>` and `tsx src/index.ts --help` route through the same argv-discriminated dispatcher as the built `dist/index.js` — no rebuild needed between edits.

To point an MCP client at a local source build, swap `npx` for `node` + an absolute path to `dist/index.js`:

```json
{
  "mcpServers": {
    "markfetch": {
      "command": "node",
      "args": ["/absolute/path/to/markfetch/dist/index.js"]
    }
  }
}
```

## Responsible use

`markfetch` is a per-call fetch tool, not a crawler. Use it on URLs whose targets you have permission to fetch, and respect the terms of service of any site you query. The maintainer assumes no liability for misuse — see [LICENSE](LICENSE).

## License

[MIT](LICENSE)
