# markfetch

MCP server: fetch a URL, return clean markdown. Built for AI agents.

Generic stdio snippet — works for Claude Desktop / Claude Code / Cursor / Goose / any stdio-MCP client:

```json
{
  "mcpServers": {
    "markfetch": {
      "command": "npx",
      "args": ["-y", "markfetch"],
      "env": {
        "MARKFETCH_TIMEOUT_MS": "30000"
      }
    }
  }
}
```

## Capabilities:
- Single MCP tool: `fetch_markdown(url: string)` → pure markdown in `content[0].text` (single channel, no frontmatter, no `structuredContent`)
- 7 deterministic error codes: `network_error`, `http_error`, `timeout`, `unsupported_content_type`, `extraction_failed`, `too_large`, `save_failed`
- Real-browser HTTP/2 + Chrome fingerprint via [undici](https://github.com/nodejs/undici)
- Extraction pipeline: [linkedom](https://github.com/WebReflection/linkedom) → [@mozilla/readability](https://github.com/mozilla/readability) → [turndown](https://github.com/mixmark-io/turndown)

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MARKFETCH_TIMEOUT_MS` | `30000` | Per-request timeout in ms |
| `MARKFETCH_MAX_BYTES` | `5000000` | Cap on response body and extracted markdown |
| `MARKFETCH_USER_AGENT` | Pinned Chrome 130 string | Override the User-Agent. Must be a Chrome UA — the `Sec-CH-UA-*` client hints are derived from it at startup; non-Chrome strings fail fast |

## Develop

Requires Node.js ≥ 24.

To point an MCP client at your local source build, replace the install snippet's `"command": "npx"` / `"args": ["-y", "markfetch"]` with `"command": "node"` / `"args": ["/absolute/path/to/markfetch/dist/index.js"]`.
```json
{
  "mcpServers": {
    "markfetch": {
      "command": "node",
      "args": ["/absolute/path/to/markfetch/dist/index.js"],
      "env": {
        "MARKFETCH_TIMEOUT_MS": "30000"
      }
    }
  }
}
```

## Responsible use

markfetch is a per-call fetch tool, not a crawler. Use it on URLs whose targets you have permission to fetch, and respect the terms of service of any site you query. The maintainer assumes no liability for misuse — see [LICENSE](LICENSE).

## License

[MIT](LICENSE)
