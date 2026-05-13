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
import { z } from "zod";
import { fetchMarkdown, classifyError, type ErrorCode } from "./core.js";
import { isAbsolute } from "node:path";
import { buildAllowedRoots, checkPath } from "./sandbox.js";

// Write-sandbox allowed roots, built once at startup. Failures here (e.g.,
// MARKFETCH_ALLOWED_WRITE_ROOTS pointing at a non-existent directory) escape
// module init and surface on stderr — same fail-fast convention as intEnv()
// in core.ts. No try/catch: a bad write-roots config is a startup error,
// not a per-request error.
const ALLOWED_ROOTS = await buildAllowedRoots(process.env);

function errorResult(code: ErrorCode, message: string) {
  return {
    content: [{ type: "text" as const, text: `[${code}] ${message}` }],
    isError: true,
  };
}

const server = new McpServer({ name: "markfetch", version: "0.5.0" });

server.registerTool(
  "fetch_markdown",
  {
    description:
      "Fetch a single public HTTP/S URL and return its main article content as clean markdown. Best for articles, documentation, blog posts, news, and reference pages. Non-HTML responses return `unsupported_content_type`. Pure client-rendered SPAs with no extractable static HTML return `extraction_failed`; SPAs that ship server-rendered or SEO-prerendered HTML will extract whatever static content they expose. Also supports saving the markdown to a file, e.g., to bypass client tool-result size limits or to reuse later.",
    inputSchema: {
      url: z
        .string()
        .url()
        .describe(
          "Absolute http(s) URL of the page to fetch. The server follows redirects automatically. No authentication headers, cookies, or session state are sent.",
        ),
      savePath: z
        .string()
        .refine(isAbsolute, "savePath must be an absolute filesystem path")
        .optional()
        .describe(
          "Optional. When provided, the fetched markdown is written to this absolute filesystem path and the response becomes a small confirmation. Use this when the markdown might exceed your client's tool-result inline cap. Must be an absolute path on the host platform (e.g., `/foo/bar.md` on POSIX; `C:\\foo\\bar.md` or `\\\\server\\share\\bar.md` on Windows); relative paths and tilde paths (`~/...`) are rejected by the schema. Existing files are overwritten; the parent directory must exist (caller's responsibility). The file is written only on fetch success — fetch / extraction / size-cap errors return a `[code]` string and never touch the file.",
        ),
    },
  },
  async ({ url, savePath }) => {
    // Sandbox gate: MCP-only by design. The CLI adapter does not run this
    // check — the human at the shell is the security boundary there.
    // Run before fetchMarkdown so a forbidden path short-circuits the
    // network round-trip entirely.
    if (savePath !== undefined) {
      const check = await checkPath(savePath, ALLOWED_ROOTS);
      if (!check.ok) {
        return errorResult("save_forbidden", check.reason);
      }
    }
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
