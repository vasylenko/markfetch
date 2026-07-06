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
import { version } from "./version.js";

// Built once at startup. Bad config throws and surfaces on stderr (same
// fail-fast convention as intEnv() in core.ts).
const ALLOWED_ROOTS = await buildAllowedRoots(process.env);

function errorResult(code: ErrorCode, message: string) {
  return {
    content: [{ type: "text" as const, text: `[${code}] ${message}` }],
    isError: true,
  };
}

const server = new McpServer({ name: "markfetch", version });

server.registerTool(
  "fetch_markdown",
  {
    description:
      "Fetch a public HTTP/S URL and return its main article content as clean markdown. Best for articles, documentation, blog posts, and reference pages. Non-HTML responses return `unsupported_content_type` unless `raw` is set; pure client-rendered SPAs return `extraction_failed`. Set `savePath` to write the output to a file instead of returning it inline.",
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
          "Absolute path to write the output to instead of returning it inline; the response becomes a short confirmation. Use when the output might exceed your client's tool-result cap. Relative and `~` paths are rejected. Writes are sandboxed to allowed roots (defaults: system temp dir and the server's working directory; override with `MARKFETCH_ALLOWED_WRITE_ROOTS`) — paths outside return `save_forbidden`. Existing files are overwritten; the parent directory must exist. Fetch errors never touch the file.",
        ),
      raw: z
        .boolean()
        .optional()
        .describe(
          "Return the response body verbatim as UTF-8 text (binary is not byte-preserved), skipping Readability and the HTML content-type gate — for JSON, APIs, or raw page source. `MARKFETCH_MAX_BYTES` still applies.",
        ),
    },
  },
  async ({ url, savePath, raw }) => {
    // Sandbox gate (MCP-only; CLI is intentionally unbounded). Runs before
    // fetchMarkdown so a forbidden path short-circuits the fetch. The
    // canonicalized check.resolved — not the caller's savePath — is what
    // flows into writeFile, so an in-path symlink followed by `..` cannot
    // erase the sandbox boundary lexically before the OS dereferences it.
    let resolvedSavePath: string | undefined;
    if (savePath !== undefined) {
      const check = await checkPath(savePath, ALLOWED_ROOTS);
      if (!check.ok) {
        return errorResult("save_forbidden", check.reason);
      }
      resolvedSavePath = check.resolved;
    }
    try {
      const { markdown, bytes, savedTo } = await fetchMarkdown({
        url,
        savePath: resolvedSavePath,
        raw,
      });
      if (savedTo !== undefined) {
        // Echo the caller's original savePath in the confirmation. The bytes
        // landed at the canonicalized resolvedSavePath; on hosts where tmpdir
        // is symlinked (macOS /var → /private/var) the realpath form differs
        // from what the caller typed, and the symbolic path is the more
        // useful surface for the caller.
        return {
          content: [
            {
              type: "text" as const,
              text: `Saved ${bytes} bytes to ${savePath}`,
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
