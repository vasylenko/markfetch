import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  mkdtemp,
  readFile,
  stat,
  access,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function spawnClient(env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: "tsx",
    args: ["src/index.ts"],
    env: { ...process.env, ...env } as Record<string, string>,
  });
  const client = new Client({ name: "markfetch-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function textOf(result: { content: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content[0]?.text ?? "";
}

async function startMock(
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// Deterministic fixture: a small but Readability-friendly article.
const HAPPY_FIXTURE = `<!DOCTYPE html>
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

test("server boots over stdio and completes the initialize handshake", async () => {
  const client = await spawnClient();
  try {
    const info = client.getServerVersion();
    assert.equal(info?.name, "markfetch");
    assert.equal(info?.version, "0.4.1");
  } finally {
    await client.close();
  }
});

test("fetch_markdown tool is listed", async () => {
  const client = await spawnClient();
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "fetch_markdown");
  } finally {
    await client.close();
  }
});

test("happy path: deterministic fixture → pure markdown body in content[0]", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HAPPY_FIXTURE);
  });
  const client = await spawnClient();
  try {
    const result = await client.callTool({
      name: "fetch_markdown",
      arguments: { url: mock.url },
    });
    assert.equal(result.isError, false);
    const text = textOf(result);
    assert.ok(
      !text.startsWith("---\n"),
      "content text should be pure markdown — no frontmatter",
    );
    assert.match(text, /Test Article Title/);
    assert.match(text, /## Section heading/);
    assert.match(text, /## Another section/);
    // Proves Readability ran (chrome stripped) and turndown produced markdown.
    assert.ok(!text.includes("<nav>"), "nav chrome should be stripped");
    assert.ok(!text.includes("copyright"), "footer should be stripped");
    assert.equal(
      (result as { structuredContent?: unknown }).structuredContent,
      undefined,
      "no structuredContent — single-channel by design",
    );
  } finally {
    await client.close();
    await mock.close();
  }
});

test("zod syntax: malformed URL is rejected at the schema boundary, not by the handler", async () => {
  const client = await spawnClient();
  try {
    let caught = false;
    let result:
      | { isError?: boolean; content?: unknown }
      | undefined;
    try {
      result = (await client.callTool({
        name: "fetch_markdown",
        arguments: { url: "not-a-url" },
      })) as { isError?: boolean; content?: unknown };
    } catch {
      caught = true;
    }
    // F27 regression-guard: locks against the case where Zod is silently
    // removed and "not-a-url" reaches fetch(). The SDK either throws (some
    // versions) OR returns isError:true with schema-error text. Either is
    // fine — but the text must NOT carry one of our [code] prefixes, which
    // would prove the handler ran and returned a tool error.
    if (!caught) {
      assert.equal(result?.isError, true, "schema rejection must surface as isError");
      const text = textOf(result as { content: unknown });
      assert.ok(
        !/^\[(network_error|http_error|timeout|unsupported_content_type|extraction_failed|too_large|save_failed)\]/.test(
          text,
        ),
        `expected schema error, got tool [code] error (handler ran when it shouldn't have): ${text}`,
      );
    }
  } finally {
    await client.close();
  }
});

test("error: network_error on unresolvable host", async () => {
  const client = await spawnClient();
  try {
    const result = await client.callTool({
      name: "fetch_markdown",
      arguments: { url: "http://no-such-host-xyz-12345.invalid" },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^\[network_error\]/);
  } finally {
    await client.close();
  }
});

test("error: http_error on 404 response", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("<html><body>not found</body></html>");
  });
  const client = await spawnClient();
  try {
    const result = await client.callTool({
      name: "fetch_markdown",
      arguments: { url: mock.url },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^\[http_error\]/);
    assert.match(textOf(result), /404/);
  } finally {
    await client.close();
    await mock.close();
  }
});

test("error: timeout when server hangs and MARKFETCH_TIMEOUT_MS is small", async () => {
  const mock = await startMock(() => {});
  const client = await spawnClient({ MARKFETCH_TIMEOUT_MS: "200" });
  try {
    const result = await client.callTool({
      name: "fetch_markdown",
      arguments: { url: mock.url },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^\[timeout\]/);
  } finally {
    await client.close();
    await mock.close();
  }
});

test("error: unsupported_content_type for non-HTML responses", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"not":"html"}');
  });
  const client = await spawnClient();
  try {
    const result = await client.callTool({
      name: "fetch_markdown",
      arguments: { url: mock.url },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^\[unsupported_content_type\]/);
    assert.match(textOf(result), /application\/json/);
  } finally {
    await client.close();
    await mock.close();
  }
});

test("content-type: case-insensitive match accepts TEXT/HTML", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "TEXT/HTML; charset=utf-8" });
    res.end(HAPPY_FIXTURE);
  });
  const client = await spawnClient();
  try {
    const result = await client.callTool({
      name: "fetch_markdown",
      arguments: { url: mock.url },
    });
    assert.equal(result.isError, false, "uppercase TEXT/HTML must be accepted");
  } finally {
    await client.close();
    await mock.close();
  }
});

test("content-type: application/xhtml+xml is accepted", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/xhtml+xml" });
    res.end(HAPPY_FIXTURE);
  });
  const client = await spawnClient();
  try {
    const result = await client.callTool({
      name: "fetch_markdown",
      arguments: { url: mock.url },
    });
    assert.equal(result.isError, false);
  } finally {
    await client.close();
    await mock.close();
  }
});

test("error: extraction_failed when Readability finds nothing", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<html><body></body></html>");
  });
  const client = await spawnClient();
  try {
    const result = await client.callTool({
      name: "fetch_markdown",
      arguments: { url: mock.url },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^\[extraction_failed\]/);
  } finally {
    await client.close();
    await mock.close();
  }
});

test("error: too_large via Content-Length pre-check", async () => {
  const big = "<html><body>" + "x".repeat(5000) + "</body></html>";
  const mock = await startMock((_req, res) => {
    // Explicit Content-Length pins this test to the pre-check branch; without
    // it, Node may emit chunked transfer-encoding and the body-length branch
    // would fire instead.
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Content-Length": String(Buffer.byteLength(big, "utf8")),
    });
    res.end(big);
  });
  const client = await spawnClient({ MARKFETCH_MAX_BYTES: "100" });
  try {
    const result = await client.callTool({
      name: "fetch_markdown",
      arguments: { url: mock.url },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^\[too_large\]/);
    assert.match(textOf(result), /Content-Length/);
  } finally {
    await client.close();
    await mock.close();
  }
});

test("error: too_large via post-decode body-bytes check (chunked, no Content-Length)", async () => {
  const big = "<html><body>" + "x".repeat(5000) + "</body></html>";
  const mock = await startMock((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Transfer-Encoding": "chunked",
    });
    res.write(big);
    res.end();
  });
  const client = await spawnClient({ MARKFETCH_MAX_BYTES: "100" });
  try {
    const result = await client.callTool({
      name: "fetch_markdown",
      arguments: { url: mock.url },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^\[too_large\]/);
    assert.match(textOf(result), /Body/);
  } finally {
    await client.close();
    await mock.close();
  }
});

test("env-var validation: invalid MARKFETCH_TIMEOUT_MS fails fast at startup", async () => {
  const child = spawn("./node_modules/.bin/tsx", ["src/index.ts"], {
    env: { ...process.env, MARKFETCH_TIMEOUT_MS: "abc" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const exitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? -1));
  });
  assert.notEqual(exitCode, 0, "subprocess must exit non-zero on bad env var");
  assert.match(stderr, /MARKFETCH_TIMEOUT_MS/);
  assert.match(stderr, /positive integer/);
});

test("env-var validation: negative MARKFETCH_MAX_BYTES is rejected", async () => {
  const child = spawn("./node_modules/.bin/tsx", ["src/index.ts"], {
    env: { ...process.env, MARKFETCH_MAX_BYTES: "-1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const exitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? -1));
  });
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /MARKFETCH_MAX_BYTES/);
});

test("env-var validation: non-Chrome MARKFETCH_USER_AGENT fails fast at startup", async () => {
  const child = spawn("./node_modules/.bin/tsx", ["src/index.ts"], {
    env: {
      ...process.env,
      MARKFETCH_USER_AGENT: "Mozilla/5.0 (X11; FreeBSD) Firefox/120.0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const exitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? -1));
  });
  assert.notEqual(
    exitCode,
    0,
    "subprocess must exit non-zero on non-Chrome UA",
  );
  assert.match(stderr, /MARKFETCH_USER_AGENT/);
  assert.match(stderr, /Chrome/);
});

test("Sec-CH-UA-* client hints are derived from MARKFETCH_USER_AGENT", async () => {
  // Capture inbound headers on the mock server. The override is a Chrome 125
  // Windows UA — the derivation must produce v="125" + Sec-CH-UA-Platform
  // "Windows", proving the env var actually changes the fingerprint (and not
  // just the UA string while client hints stay pinned to Chrome 130 macOS).
  const captured: { headers?: Record<string, string | string[] | undefined> } = {};
  const mock = await startMock((req, res) => {
    captured.headers = req.headers;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HAPPY_FIXTURE);
  });
  const overrideUa =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
  const client = await spawnClient({ MARKFETCH_USER_AGENT: overrideUa });
  try {
    const result = await client.callTool({
      name: "fetch_markdown",
      arguments: { url: mock.url },
    });
    assert.equal(result.isError, false);
    const headers = captured.headers ?? {};
    assert.equal(headers["user-agent"], overrideUa);
    const brands = String(headers["sec-ch-ua"] ?? "");
    assert.match(brands, /v="125"/, `Sec-CH-UA brands should reflect Chrome 125: ${brands}`);
    assert.equal(headers["sec-ch-ua-mobile"], "?0");
    assert.equal(headers["sec-ch-ua-platform"], '"Windows"');
  } finally {
    await client.close();
    await mock.close();
  }
});

test("per-request errors do not leak to stderr (Principle #4: stderr is fatal-only)", async () => {
  // Connect with stderr: "pipe" so we observe the server's stderr directly
  // while it handles a per-request failure. A network_error from an
  // unresolvable host is the cheapest reliable per-request failure.
  const transport = new StdioClientTransport({
    command: "tsx",
    args: ["src/index.ts"],
    env: process.env as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "markfetch-test", version: "0.0.0" });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "fetch_markdown",
      arguments: { url: "http://no-such-host-xyz-12345.invalid" },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^\[network_error\]/);
  } finally {
    await client.close();
  }
  // errorResult() must return its [code]-prefixed message via MCP only — never
  // duplicate it to stderr. Allow brief drain time after close.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(
    stderr.trim(),
    "",
    `stderr should stay empty for per-request errors; got: ${stderr}`,
  );
});

// ---------------------------------------------------------------------------
// savePath: "fetch and save" channel
// ---------------------------------------------------------------------------

// Multibyte fixture for T2: em-dashes, accents, non-Latin chars. Enough to
// make a `markdown.length` regression visibly disagree with `stat(file).size`.
const MULTIBYTE_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head><title>Multibyte Test</title></head>
<body>
  <main>
    <article>
      <h1>Café — résumé — façade</h1>
      <p>The em-dash (—), the en-dash (–), the ellipsis (…), and naïve diacritics combine to make this paragraph multibyte under UTF-8. Lorem ipsum dolor sit amet — consectetur adipiscing elit — sed do eiusmod tempor incididunt ut labore et dolore magna aliqua résumé naïveté.</p>
      <h2>Section — diacritics</h2>
      <p>More words: cliché, naïve, café, résumé, façade, jalapeño, Zürich, Москва. The Readability extractor should score this paragraph positively despite the non-ASCII content. Every em-dash here is three bytes in UTF-8 but one UTF-16 code unit, which is the whole point of T2.</p>
    </article>
  </main>
</body>
</html>`;

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "mf-savepath-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// T1
test("savePath happy path: file written, response is confirmation, contents === inline-call output", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HAPPY_FIXTURE);
  });
  await withTmpDir(async (dir) => {
    const savePath = join(dir, "out.md");
    const client = await spawnClient();
    try {
      const saved = await client.callTool({
        name: "fetch_markdown",
        arguments: { url: mock.url, savePath },
      });
      assert.equal(saved.isError, false, "savePath success must not be isError");
      const confirmation = textOf(saved);
      assert.ok(
        confirmation.startsWith("Saved ") &&
          confirmation.endsWith(` bytes to ${savePath}`),
        `expected 'Saved N bytes to ${savePath}', got: ${confirmation}`,
      );
      const onDisk = await readFile(savePath, "utf8");

      // Same URL, no savePath → inline markdown must equal what landed on disk.
      const inline = await client.callTool({
        name: "fetch_markdown",
        arguments: { url: mock.url },
      });
      assert.equal(inline.isError, false);
      assert.equal(
        onDisk,
        textOf(inline),
        "file content must equal the inline call's content[0].text",
      );
    } finally {
      await client.close();
      await mock.close();
    }
  });
});

// T2 — UTF-8 multibyte regression-guard
test("savePath multibyte: confirmation byte count === stat(file).size", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(MULTIBYTE_FIXTURE);
  });
  await withTmpDir(async (dir) => {
    const savePath = join(dir, "multibyte.md");
    const client = await spawnClient();
    try {
      const result = await client.callTool({
        name: "fetch_markdown",
        arguments: { url: mock.url, savePath },
      });
      assert.equal(result.isError, false);
      const text = textOf(result);
      const match = text.match(/^Saved (\d+) bytes to /);
      assert.ok(match, `confirmation must declare a byte count: got ${text}`);
      const reportedBytes = Number(match[1]);
      const onDisk = await stat(savePath);
      assert.equal(
        reportedBytes,
        onDisk.size,
        `reported bytes (${reportedBytes}) must === on-disk size (${onDisk.size}). UTF-8 regression: someone replaced Buffer.byteLength with markdown.length.`,
      );
    } finally {
      await client.close();
      await mock.close();
    }
  });
});

// T3 — F27-style boundary check, extended for save_failed
test("savePath: relative path is rejected at the schema boundary, not by the handler", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HAPPY_FIXTURE);
  });
  const client = await spawnClient();
  try {
    let caught = false;
    let result: { isError?: boolean; content?: unknown } | undefined;
    try {
      result = (await client.callTool({
        name: "fetch_markdown",
        arguments: { url: mock.url, savePath: "relative/path.md" },
      })) as { isError?: boolean; content?: unknown };
    } catch {
      caught = true;
    }
    if (!caught) {
      assert.equal(result?.isError, true, "schema rejection must surface as isError");
      const text = textOf(result as { content: unknown });
      assert.ok(
        !/^\[(network_error|http_error|timeout|unsupported_content_type|extraction_failed|too_large|save_failed)\]/.test(
          text,
        ),
        `expected schema error, got tool [code] error (handler ran when it shouldn't have): ${text}`,
      );
    }
  } finally {
    await client.close();
    await mock.close();
  }
});

// T4 — locks the deliberate no-tilde-expansion decision
test("savePath: tilde-path '~/x.md' is rejected at the schema boundary (no auto-expansion)", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HAPPY_FIXTURE);
  });
  const client = await spawnClient();
  try {
    let caught = false;
    let result: { isError?: boolean; content?: unknown } | undefined;
    try {
      result = (await client.callTool({
        name: "fetch_markdown",
        arguments: { url: mock.url, savePath: "~/x.md" },
      })) as { isError?: boolean; content?: unknown };
    } catch {
      caught = true;
    }
    if (!caught) {
      assert.equal(result?.isError, true);
      const text = textOf(result as { content: unknown });
      assert.ok(
        !/^\[(network_error|http_error|timeout|unsupported_content_type|extraction_failed|too_large|save_failed)\]/.test(
          text,
        ),
        `tilde path must be rejected at schema, not by handler: ${text}`,
      );
    }
  } finally {
    await client.close();
    await mock.close();
  }
});

// T5
test("savePath: writeFile rejection surfaces as [save_failed] with errno; file is not created", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HAPPY_FIXTURE);
  });
  const savePath = "/nonexistent-parent-zzz-savepath-test/out.md";
  const client = await spawnClient();
  try {
    const result = await client.callTool({
      name: "fetch_markdown",
      arguments: { url: mock.url, savePath },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^\[save_failed\]/);
    assert.match(textOf(result), /ENOENT/);
    await assert.rejects(
      access(savePath),
      /ENOENT/,
      "file must not have been created on save failure",
    );
  } finally {
    await client.close();
    await mock.close();
  }
});

// T6 — THE Invariant. PRD §5: file at savePath is only ever the markdown.
test("savePath INVARIANT: fetch error + savePath → file is NOT written", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("<html><body>not found</body></html>");
  });
  await withTmpDir(async (dir) => {
    const savePath = join(dir, "should-not-exist.md");
    const client = await spawnClient();
    try {
      const result = await client.callTool({
        name: "fetch_markdown",
        arguments: { url: mock.url, savePath },
      });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /^\[http_error\]/);
      await assert.rejects(
        access(savePath),
        /ENOENT/,
        "fetch errors must not create or modify the file at savePath",
      );
    } finally {
      await client.close();
      await mock.close();
    }
  });
});

// T7 — locks the size-cap-before-save ordering
test("savePath INVARIANT: too_large + savePath → file is NOT written (cap runs before save)", async () => {
  const big = "<html><body><p>" + "x".repeat(5000) + "</p></body></html>";
  const mock = await startMock((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Content-Length": String(Buffer.byteLength(big, "utf8")),
    });
    res.end(big);
  });
  await withTmpDir(async (dir) => {
    const savePath = join(dir, "should-not-exist.md");
    const client = await spawnClient({ MARKFETCH_MAX_BYTES: "100" });
    try {
      const result = await client.callTool({
        name: "fetch_markdown",
        arguments: { url: mock.url, savePath },
      });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /^\[too_large\]/);
      await assert.rejects(
        access(savePath),
        /ENOENT/,
        "too_large must short-circuit before writeFile — the cap is not bypassable via savePath",
      );
    } finally {
      await client.close();
      await mock.close();
    }
  });
});

// T8 — locks the KISS overwrite decision against future flag:'wx' changes
test("savePath: existing file is overwritten", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HAPPY_FIXTURE);
  });
  await withTmpDir(async (dir) => {
    const savePath = join(dir, "preexisting.md");
    await writeFile(savePath, "old content from a previous run", "utf8");
    const client = await spawnClient();
    try {
      const result = await client.callTool({
        name: "fetch_markdown",
        arguments: { url: mock.url, savePath },
      });
      assert.equal(result.isError, false);
      const onDisk = await readFile(savePath, "utf8");
      assert.notEqual(
        onDisk,
        "old content from a previous run",
        "savePath must overwrite the existing file",
      );
      assert.match(
        onDisk,
        /Test Article Title/,
        "file must contain the new markdown",
      );
    } finally {
      await client.close();
      await mock.close();
    }
  });
});
