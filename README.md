# markfetch

**Reader View for AI agents and your shell. Fetch any URL, get back clean markdown — at a real Chrome's request rate, not curl's.**

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
| **`markfetch`** | **✓** | **✓** | **✓ (7 codes)** | **✓** |

- **Real-browser HTTP/2 + Chrome fingerprint.** ALPN-negotiated h2, `User-Agent`, `Sec-CH-UA-*`, `Sec-Fetch-*`, `Accept-*`. A Chrome UA with no client hints is a *stronger* automation signal than curl — `markfetch` sends the full coherent set, derived from the UA at startup so an override stays internally consistent.

- **Reader-View-quality extraction.** [linkedom](https://github.com/WebReflection/linkedom) → [@mozilla/readability](https://github.com/mozilla/readability) → [turndown](https://github.com/mixmark-io/turndown) with GFM tables, strikethrough, and task lists. Code fences preserve `language-X` hints. Sphinx-style bare `<pre>` blocks render as code, not escaped prose. Intraword underscores stay un-escaped — no more `list\_tools`.

- **One tool, one shape (MCP).** `fetch_markdown(url, savePath?)` returns markdown in `content[0].text`. No `structuredContent`, no frontmatter, no metadata fields. Modern MCP clients hide `content[]` when `structuredContent` is present — `markfetch` deliberately stays on the channel your LLM can actually read.

- **`savePath` / `-o` escape valve.** Pass an absolute path (MCP `savePath`) or `-o <path>` (CLI) and the markdown lands on disk instead of the response channel. Use it when your client's inline tool-result cap would truncate large responses, or to redirect output from a shell pipeline. The file is only ever the markdown of the URL — fetch errors return a `[code]` string and never touch the disk.

- **Whole document or honest failure.** No pagination, no truncation. If the document doesn't fit in `MARKFETCH_MAX_BYTES`, you get `too_large` — never a half-truth.

- **Stdio-clean.** Stdout is reserved for MCP frames. Stderr is fatal-only. No log spam, no ANSI escapes that could corrupt protocol framing.

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

Errors go to stderr with the same `[code] message` shape the MCP tool returns (see the table below), and the process exits with a non-zero status. The same env vars (`MARKFETCH_TIMEOUT_MS`, `MARKFETCH_MAX_BYTES`, `MARKFETCH_USER_AGENT`) apply in both modes.

## What it is not

- **Not a crawler.** No recursion, no `robots.txt` parsing, no rate-limit orchestration. One URL in, one document out.
- **Not authenticated.** Anonymous fetch only — no cookie jar, no auth headers, no session reuse. Pages behind login walls return whatever the public response is, usually surfaced as `http_error`.
- **Not a JS renderer.** Single-page apps that paint their content client-side return `extraction_failed`. Use this on server-rendered pages.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MARKFETCH_TIMEOUT_MS` | `30000` | Per-request timeout in ms |
| `MARKFETCH_MAX_BYTES` | `5000000` | Cap on response body and extracted markdown |
| `MARKFETCH_USER_AGENT` | Pinned Chrome 130 string | Override the UA. Must be a Chrome UA — `Sec-CH-UA-*` client hints are derived from it at startup; non-Chrome strings fail fast |

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

## Develop

Requires Node.js ≥ 24.

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
