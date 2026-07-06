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

// Built once at startup. Bad config throws and surfaces on stderr (same
// fail-fast convention as intEnv() in core.ts).
const ALLOWED_ROOTS = await buildAllowedRoots(process.env);

function errorResult(code: ErrorCode, message: string) {
  return {
    content: [{ type: "text" as const, text: `[${code}] ${message}` }],
    isError: true,
  };
}

const server = new McpServer({ name: "markfetch", version: "0.6.0" });

server.registerTool(
  "fetch_markdown",
  {
    description:
      "Fetch a single public HTTP/S URL and return its main article content as clean markdown. Best for articles, documentation, blog posts, news, and reference pages. Non-HTML responses return `unsupported_content_type` unless `raw` is set. Pure client-rendered SPAs with no extractable static HTML return `extraction_failed`; SPAs that ship server-rendered or SEO-prerendered HTML will extract whatever static content they expose. Also supports saving the output to a file, e.g., to bypass client tool-result size limits or to reuse later. Saved files must land inside the allowed write roots (defaults: system temp dir and the server's working directory; configurable via `MARKFETCH_ALLOWED_WRITE_ROOTS`); paths outside return `save_forbidden`.",
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
          "Optional. When provided, the fetched output (extracted markdown, or the raw body with `raw`) is written to this absolute filesystem path and the response becomes a small confirmation. Use this when the markdown might exceed your client's tool-result inline cap. Must be an absolute path on the host platform (e.g., `/foo/bar.md` on POSIX; `C:\\foo\\bar.md` or `\\\\server\\share\\bar.md` on Windows); relative paths and tilde paths (`~/...`) are rejected by the schema. Writes are confined to an allow-listed sandbox — defaults are the system temp dir (`os.tmpdir()`) and the server's working directory; operators can override with `MARKFETCH_ALLOWED_WRITE_ROOTS` (path-delimiter-separated). A `savePath` outside the allowed roots returns `save_forbidden` and no file is created. Existing files are overwritten; the parent directory must exist (caller's responsibility). The file is written only on fetch success — fetch / extraction / size-cap errors return a `[code]` string and never touch the file.",
        ),
      raw: z
        .boolean()
        .optional()
        .describe(
          "Optional. When true, returns the response body verbatim and skips both Readability extraction and the HTML content-type gate — so non-HTML responses (JSON, XML, plain text, source) come back as-is instead of `unsupported_content_type`. The `MARKFETCH_MAX_BYTES` size cap still applies. Use for APIs, raw page source, or when you want the unprocessed document rather than extracted article markdown. The body is decoded as UTF-8 text; binary or non-UTF-8 responses are not byte-preserved.",
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
