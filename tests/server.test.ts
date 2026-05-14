import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  mkdtemp,
  readFile,
  stat,
  access,
  writeFile,
  rm,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import {
  startMock,
  textOf,
  HAPPY_FIXTURE,
  spawnClient,
  assertSchemaRejection,
  spawnAndCaptureExit,
} from "./_helpers.js";

test("server boots over stdio and completes the initialize handshake", async () => {
  const client = await spawnClient();
  try {
    const info = client.getServerVersion();
    assert.equal(info?.name, "markfetch");
    assert.equal(info?.version, "0.6.0");
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

// F27 regression-guard: locks against Zod being silently removed and
// "not-a-url" reaching fetch().
test("zod syntax: malformed URL is rejected at the schema boundary, not by the handler", async () => {
  const client = await spawnClient();
  try {
    await assertSchemaRejection(
      client,
      { url: "not-a-url" },
      "expected schema error, got tool [code] error (handler ran when it shouldn't have)",
    );
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
  const client = await spawnClient({ env: { MARKFETCH_TIMEOUT_MS: "200" } });
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
  const client = await spawnClient({ env: { MARKFETCH_MAX_BYTES: "100" } });
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
  const client = await spawnClient({ env: { MARKFETCH_MAX_BYTES: "100" } });
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
  const { exitCode, stderr } = await spawnAndCaptureExit(["src/index.ts"], {
    MARKFETCH_TIMEOUT_MS: "abc",
  });
  assert.notEqual(exitCode, 0, "subprocess must exit non-zero on bad env var");
  assert.match(stderr, /MARKFETCH_TIMEOUT_MS/);
  assert.match(stderr, /positive integer/);
});

test("env-var validation: negative MARKFETCH_MAX_BYTES is rejected", async () => {
  const { exitCode, stderr } = await spawnAndCaptureExit(["src/index.ts"], {
    MARKFETCH_MAX_BYTES: "-1",
  });
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /MARKFETCH_MAX_BYTES/);
});

test("env-var validation: non-Chrome MARKFETCH_USER_AGENT fails fast at startup", async () => {
  const { exitCode, stderr } = await spawnAndCaptureExit(["src/index.ts"], {
    MARKFETCH_USER_AGENT: "Mozilla/5.0 (X11; FreeBSD) Firefox/120.0",
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
  const client = await spawnClient({ env: { MARKFETCH_USER_AGENT: overrideUa } });
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

test("per-request errors do not leak to stderr (stderr-is-fatal-only invariant per SPEC.md)", async () => {
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
      const match = /^Saved (\d+) bytes to /.exec(text);
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
    await assertSchemaRejection(
      client,
      { url: mock.url, savePath: "relative/path.md" },
      "expected schema error, got tool [code] error (handler ran when it shouldn't have)",
    );
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
    await assertSchemaRejection(
      client,
      { url: mock.url, savePath: "~/x.md" },
      "tilde path must be rejected at schema, not by handler",
    );
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
  // Path lives inside the default sandbox (os.tmpdir() via mkdtemp), so the
  // sandbox check passes and writeFile actually runs. The "nonexistent-subdir"
  // intermediate doesn't exist, so writeFile fails with ENOENT — exercising
  // the save_failed branch of core.ts.
  await withTmpDir(async (dir) => {
    const savePath = join(dir, "nonexistent-subdir", "out.md");
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
});

// T6 — THE Invariant. The file at savePath is only ever the markdown of the URL (per README and SPEC.md).
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
    const client = await spawnClient({ env: { MARKFETCH_MAX_BYTES: "100" } });
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

// T9 — savePath outside the default sandbox → [save_forbidden]; no file.
test("savePath sandbox: path outside default roots → [save_forbidden] and file not written", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HAPPY_FIXTURE);
  });
  // Construct a forbidden path without hardcoding "/etc" or "C:\\Windows".
  // Filesystem root + sentinel filename is outside any mkdtemp dir under
  // tmpdir, and outside the test runner's cwd (the repo root). On POSIX
  // this is "/markfetch-sandbox-forbidden.md"; on Windows it is
  // "C:\\markfetch-sandbox-forbidden.md".
  const forbiddenPath = join(
    parse(tmpdir()).root,
    "markfetch-sandbox-forbidden.md",
  );
  const client = await spawnClient();
  try {
    const result = await client.callTool({
      name: "fetch_markdown",
      arguments: { url: mock.url, savePath: forbiddenPath },
    });
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /^\[save_forbidden\]/);
    assert.ok(
      text.includes("outside the allowed write roots"),
      `error must explain the rule for caller recovery; got: ${text}`,
    );
    await assert.rejects(
      access(forbiddenPath),
      /ENOENT/,
      "save_forbidden must not create the file",
    );
  } finally {
    await client.close();
    await mock.close();
  }
});

// T10 — symlink inside sandbox pointing outside is blocked by realpath.
// POSIX-gated: Windows symlink creation typically requires elevation, and
// the property under test is platform-independent in src/sandbox.ts, so
// POSIX coverage is sufficient.
test(
  "savePath sandbox: symlink escape from inside sandbox is blocked",
  { skip: process.platform === "win32" },
  async () => {
    const mock = await startMock((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HAPPY_FIXTURE);
    });
    await withTmpDir(async (sandboxDir) => {
      // Plant a symlink inside the sandbox dir pointing to filesystem root
      // (definitely outside tmpdir). Then write through the symlink and
      // expect rejection — realpath in checkPath resolves the symlink and
      // the containment check sees the outside-the-sandbox target.
      const innerDir = join(sandboxDir, "inner");
      await mkdir(innerDir);
      const escapeLink = join(innerDir, "escape");
      const outsideRoot = parse(tmpdir()).root;
      await symlink(outsideRoot, escapeLink);
      const target = join(escapeLink, "markfetch-symlink-escape.md");
      const realTarget = join(outsideRoot, "markfetch-symlink-escape.md");
      const client = await spawnClient();
      try {
        const result = await client.callTool({
          name: "fetch_markdown",
          arguments: { url: mock.url, savePath: target },
        });
        assert.equal(result.isError, true);
        assert.match(textOf(result), /^\[save_forbidden\]/);
        await assert.rejects(
          access(realTarget),
          /ENOENT/,
          "symlink-escape attempt must not write to the symlink target",
        );
      } finally {
        await client.close();
        await mock.close();
      }
    });
  },
);

// T10b — symlink + lexical `..` cannot bypass the sandbox.
// path.resolve collapses `..` BEFORE the OS dereferences the symlink, so a
// naive containment check on the resolved string sees the target back inside
// the sandbox while the OS would actually write to <link-target>/.. on
// writeFile. mcp.ts must pass checkPath's canonicalized resolved path — not
// the caller's savePath — through to fetchMarkdown for the write to land at
// the validated location.
//
// Test design: constrain the allowed roots to sandboxDir only (so tmpdir is
// outside the sandbox), plant a symlink inside sandboxDir pointing at an
// outsideDir sibling, then send savePath=`<sandboxDir>/link/../escape.md`.
// Pre-fix: writeFile lands at <tmpdir>/escape.md (outside the sandbox).
// Post-fix: writeFile lands at <sandboxDir>/escape.md.
test(
  "savePath sandbox: symlink + lexical .. attack writes to validated path, not deceptive path",
  { skip: process.platform === "win32" },
  async () => {
    const mock = await startMock((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HAPPY_FIXTURE);
    });
    await withTmpDir(async (sandboxDir) => {
      await withTmpDir(async (outsideDir) => {
        const link = join(sandboxDir, "out-link");
        await symlink(outsideDir, link);
        // Unique filename so a stray file from a crashed run can't satisfy
        // the negative assertion below.
        const escapeFilename = `markfetch-symlink-dotdot-escape-${process.pid}-${Date.now()}.md`;
        // String-concatenate (not path.join) so the literal `..` segment
        // survives transmission to the MCP tool. path.join normalizes `..`
        // lexically, which would mask the very bug under test before the
        // tool ever sees the payload.
        const attackPath = `${link}/../${escapeFilename}`;
        const validatedPath = join(sandboxDir, escapeFilename);
        // Where left-to-right OS path resolution of attackPath would land:
        // enter link → outsideDir; `..` → parent-of-outsideDir (= tmpdir);
        // then escapeFilename.
        const deceptiveTarget = join(parse(outsideDir).dir, escapeFilename);
        await assert.rejects(
          access(deceptiveTarget),
          /ENOENT/,
          "precondition: deceptiveTarget must not pre-exist for this test to be meaningful",
        );
        const client = await spawnClient({
          env: { MARKFETCH_ALLOWED_WRITE_ROOTS: sandboxDir },
        });
        try {
          const result = await client.callTool({
            name: "fetch_markdown",
            arguments: { url: mock.url, savePath: attackPath },
          });
          assert.equal(
            result.isError,
            false,
            `expected success at validated path; got ${textOf(result)}`,
          );
          await access(validatedPath);
          await assert.rejects(
            access(deceptiveTarget),
            /ENOENT/,
            "symlink + .. attack must not produce a file at the OS-resolved deceptive target",
          );
        } finally {
          await client.close();
          await mock.close();
        }
      });
    });
  },
);

// T11 — MARKFETCH_ALLOWED_WRITE_ROOTS REPLACES the defaults (not merges).
test("savePath sandbox: MARKFETCH_ALLOWED_WRITE_ROOTS replaces the defaults", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HAPPY_FIXTURE);
  });
  await withTmpDir(async (customRoot) => {
    // Spawn the MCP server with the override pointing at customRoot only.
    // If the override merged with defaults instead of replacing them, a
    // sibling tmpdir path would still be allowed — the second assertion
    // proves it doesn't.
    const client = await spawnClient({
      env: { MARKFETCH_ALLOWED_WRITE_ROOTS: customRoot },
    });
    try {
      // (a) Inside the override root → success.
      const insideCustom = join(customRoot, "inside.md");
      const ok = await client.callTool({
        name: "fetch_markdown",
        arguments: { url: mock.url, savePath: insideCustom },
      });
      assert.equal(
        ok.isError,
        false,
        `write inside override root must succeed; got: ${textOf(ok)}`,
      );

      // (b) Inside os.tmpdir() but outside the override root → forbidden.
      // A sibling mkdtemp dir is inside tmpdir but outside customRoot.
      await withTmpDir(async (siblingDir) => {
        const outsideCustom = join(siblingDir, "outside-override.md");
        const denied = await client.callTool({
          name: "fetch_markdown",
          arguments: { url: mock.url, savePath: outsideCustom },
        });
        assert.equal(
          denied.isError,
          true,
          "path inside tmpdir-but-outside-override must be rejected (proves replace, not merge)",
        );
        assert.match(textOf(denied), /^\[save_forbidden\]/);
      });
    } finally {
      await client.close();
      await mock.close();
    }
  });
});

// T12 — bad MARKFETCH_ALLOWED_WRITE_ROOTS fails fast at startup.
// Mirrors the existing intEnv fail-fast tests for MARKFETCH_TIMEOUT_MS /
// MARKFETCH_MAX_BYTES / MARKFETCH_USER_AGENT.
test("env-var validation: non-absolute MARKFETCH_ALLOWED_WRITE_ROOTS fails fast at startup", async () => {
  const { exitCode, stderr } = await spawnAndCaptureExit(["src/index.ts"], {
    MARKFETCH_ALLOWED_WRITE_ROOTS: "relative/path",
  });
  assert.notEqual(
    exitCode,
    0,
    "subprocess must exit non-zero when sandbox env var is malformed",
  );
  assert.match(stderr, /MARKFETCH_ALLOWED_WRITE_ROOTS/);
  assert.match(stderr, /absolute path/);
});

// T13 — Windows-shaped absolute path accepted at the schema and writes.
// Win32-gated. Regression guard against reverting the schema from
// path.isAbsolute back to startsWith("/"). The Windows shape must flow
// schema → sandbox check (tmpdir is in defaults) → writeFile.
test(
  "savePath: Windows-shaped absolute path is accepted at the schema and writes (win32-gated)",
  { skip: process.platform !== "win32" },
  async () => {
    const mock = await startMock((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HAPPY_FIXTURE);
    });
    await withTmpDir(async (dir) => {
      // On Windows, join() with a Windows-shaped tmpdir produces a
      // backslash path like C:\Users\...\Temp\xxxxx\win-shape.md.
      const savePath = join(dir, "win-shape.md");
      const client = await spawnClient();
      try {
        const result = await client.callTool({
          name: "fetch_markdown",
          arguments: { url: mock.url, savePath },
        });
        assert.equal(
          result.isError,
          false,
          `Windows-shaped path must be accepted; got: ${textOf(result)}`,
        );
        await access(savePath);
      } finally {
        await client.close();
        await mock.close();
      }
    });
  },
);
