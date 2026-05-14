// Shared test helpers extracted from cli.test.ts / server.test.ts / e2e.test.ts
// / snapshots.test.ts to remove copy-paste duplication. Not a test file itself
// — the runner pattern `tsx --test tests/*.test.ts` (see package.json) excludes
// this file by name.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Absolute file:// URL for tsx's loader entry. Test helpers that spawn the
// CLI via `node --import <url> src/index.ts` use this rather than the
// `./node_modules/.bin/tsx` shim (a `.cmd` file on Windows that Node's
// native child_process.spawn cannot launch without `shell: true`). Resolved
// once at test-startup so it stays correct even when individual tests
// override the child cwd.
//
// spawnClient (below) is intentionally NOT switched to this pattern: it
// relies on the MCP SDK's StdioClientTransport, which uses its own
// cross-platform launcher and already handles `command: "tsx"` correctly
// on Windows. Touching it would couple this code to SDK internals.
export const TSX_LOADER_URL = pathToFileURL(
  resolve("./node_modules/tsx/dist/loader.mjs"),
).href;

export async function startMock(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = createServer(handler);
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = httpServer.address();
  if (!address || typeof address !== "object") {
    throw new Error("mock server address unavailable");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    // closeAllConnections() drops keep-alive sockets so close() actually
    // resolves; without it the server lingers past the test boundary.
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export async function spawnClient(opts?: {
  name?: string;
  env?: Record<string, string>;
}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "tsx",
    args: ["src/index.ts"],
    env: { ...process.env, ...opts?.env } as Record<string, string>,
  });
  const client = new Client({
    name: opts?.name ?? "markfetch-test",
    version: "0.0.0",
  });
  await client.connect(transport);
  return client;
}

export function textOf(result: { content: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content[0]?.text ?? "";
}

// Matches any of the eight [code] error prefixes the tool emits. Used by
// schema-rejection assertions to prove the handler did NOT run — a [code]
// prefix would mean the call escaped Zod and reached core.
export const ERROR_CODE_PREFIX_RE =
  /^\[(network_error|http_error|timeout|unsupported_content_type|extraction_failed|too_large|save_failed|save_forbidden)\]/;

// Asserts that a tool call is rejected at the Zod schema boundary, not by the
// handler. The SDK either throws (some versions) or returns isError:true with
// schema-error text — both are valid rejections. What's NOT valid is a
// [code]-prefixed reply, which would prove the handler ran.
export async function assertSchemaRejection(
  client: Client,
  args: Record<string, unknown>,
  failureMessage: string,
): Promise<void> {
  let caught = false;
  let result: { isError?: boolean; content?: unknown } | undefined;
  try {
    result = (await client.callTool({
      name: "fetch_markdown",
      arguments: args,
    })) as { isError?: boolean; content?: unknown };
  } catch {
    caught = true;
  }
  if (!caught) {
    assert.equal(
      result?.isError,
      true,
      "schema rejection must surface as isError",
    );
    const text = textOf(result as { content: unknown });
    assert.ok(
      !ERROR_CODE_PREFIX_RE.test(text),
      `${failureMessage}: ${text}`,
    );
  }
}

// One-shot subprocess spawn that returns exit code + stderr. Used by
// startup-failure tests that expect a misconfigured env var to fail fast.
export async function spawnAndCaptureExit(
  args: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; stderr: string }> {
  const child = spawn(
    process.execPath,
    ["--import", TSX_LOADER_URL, ...args],
    {
      env: { ...process.env, ...env } as Record<string, string>,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const exitCode = await new Promise<number>((resolve) =>
    child.on("exit", (code) => resolve(code ?? -1)),
  );
  return { exitCode, stderr };
}

// Deterministic Readability-friendly fixture with three <h2> sections so
// server-side tests that assert on multiple sub-headings have material;
// CLI tests assert on a subset and still pass.
export const HAPPY_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head><title>Test Article</title></head>
<body>
  <header><nav>nav links</nav></header>
  <main>
    <article>
      <h1>Test Article Title</h1>
      <p>First substantive paragraph with enough content to pass Readability's heuristics. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. The article contains real prose for the extractor to score positively.</p>
      <h2>Section heading</h2>
      <p>Second paragraph with continuing content. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. More words to give Readability adequate signal.</p>
      <h2>Another section</h2>
      <p>Third paragraph: Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>
    </article>
  </main>
  <footer>copyright</footer>
</body>
</html>`;
