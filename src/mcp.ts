// MCP adapter. Imported lazily by index.ts when invoked with zero arguments
// (the standard MCP client spawn shape). Wraps the unified `fetchMarkdown`
// from core in the MCP tool-content shape and connects over stdio.
//
// Invariant: nothing in this module — or anything reachable from it — may
// write to stdout. Stdout is the JSON-RPC frame channel; arbitrary writes
// corrupt protocol framing and the client disconnects. Errors are returned
// inside the MCP `{isError: true, content: [...]}` envelope, not printed.
// Stderr is also reserved (project principle: stderr is fatal-only) — every
// per-request error round-trips through `errorResult`, never through logging.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { fetchMarkdown, classifyError, type ErrorCode } from "./core.js";

function errorResult(code: ErrorCode, message: string) {
  return {
    content: [{ type: "text" as const, text: `[${code}] ${message}` }],
    isError: true,
  };
}

// Accept only host-absolute filesystem paths. POSIX hosts accept paths from
// the root (`/…`) via path.isAbsolute. Windows hosts require an explicit
// root: a drive-letter (`C:\…` / `C:/…`) or a UNC (`\\server\share\…` or
// `//server/share/…`). path.isAbsolute on Windows also returns true for a
// bare `/foo` — that's current-drive-relative and ambiguous, so we reject it
// here. The branch is taken from process.platform at runtime, so the same
// schema enforces the right contract on whichever host the server runs on.
function isHostAbsolutePath(p: string): boolean {
  if (process.platform === "win32") {
    const driveRoot = /^[A-Za-z]:[\\/]/.test(p);
    const uncRoot = /^[\\/][\\/]/.test(p);
    return driveRoot || uncRoot;
  }
  return isAbsolute(p);
}

const server = new McpServer({ name: "markfetch", version: "0.5.0" });

server.registerTool(
  "fetch_markdown",
  {
    description:
      "Fetch a single public HTTP/S URL and return its main article content as clean markdown. Best for articles, documentation, blog posts, news, and reference pages. JavaScript-rendered SPAs and non-HTML responses return structured errors instead of partial content. Also supports saving the markdown to a file, e.g., to bypass client tool-result size limits or to reuse later.",
    inputSchema: {
      url: z
        .string()
        .url()
        .describe(
          "Absolute http(s) URL of the page to fetch. The server follows redirects automatically. No authentication headers, cookies, or session state are sent.",
        ),
      savePath: z
        .string()
        .refine(isHostAbsolutePath, {
          message:
            "Must be a host-absolute path (POSIX `/…` on Linux/macOS, drive-letter or UNC on Windows).",
        })
        .optional()
        .describe(
          "Optional. When provided, the fetched markdown is written to this host-absolute filesystem path and the response becomes a small confirmation. Use this when the markdown might exceed your client's tool-result inline cap. Must be absolute for the host the server runs on: a POSIX path (`/…`) on Linux/macOS, or a drive-letter (`C:\\…` / `C:/…`) or UNC (`\\\\server\\share\\…`) path on Windows. Relative paths and tilde-paths (`~/…`) are rejected by the schema. Existing files are overwritten; the parent directory must exist (caller's responsibility). The file is written only on fetch success — fetch / extraction / size-cap errors return a [code] string and never touch the file.",
        ),
    },
  },
  async ({ url, savePath }) => {
    try {
      const { markdown, bytes, savedTo } = await fetchMarkdown({
        url,
        savePath,
      });
      if (savedTo !== undefined) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Saved ${bytes} bytes to ${savedTo}`,
            },
          ],
          isError: false,
        };
      }
      return {
        content: [{ type: "text" as const, text: markdown }],
        isError: false,
      };
    } catch (err) {
      const { code, message } = classifyError(err);
      return errorResult(code, message);
    }
  },
);

await server.connect(new StdioServerTransport());
