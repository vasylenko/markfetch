// E2E tests against the BUILT JS output (`node dist/index.js`), not the dev
// source. server.test.ts already exercises the full surface via tsx; this file
// verifies that `tsc` output is itself correct and runnable. If server.test.ts
// passes but this file fails, the bug lives in the build pipeline, not the
// runtime logic.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { startMock, textOf } from "./_helpers.js";

const execFileAsync = promisify(execFile);

// Resolved absolute paths so a test that overrides cwd still locates the
// built JS entry. node is on PATH, so a bare command name is fine for it.
const BUILT_JS = resolvePath("dist/index.js");

before(() => {
  // Always rebuild so e2e tests run against current source, not a stale dist/.
  execSync("npm run build", { stdio: "inherit" });
});

async function spawnBuilt(env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, ...env } as Record<string, string>,
  });
  const client = new Client({ name: "markfetch-e2e", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const HAPPY_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head><title>E2E Fixture</title></head>
<body>
  <header><nav>nav</nav></header>
  <main>
    <article>
      <h1>E2E Fixture Heading</h1>
      <p>This is a deterministic fixture for verifying the built output's full pipeline. The article contains enough prose to pass Readability scoring without depending on any external network resource.</p>
      <h2>Sub-section</h2>
      <p>Second paragraph adds more substance so the extracted markdown has multiple structural elements to assert against. Lorem ipsum dolor sit amet.</p>
    </article>
  </main>
  <footer>page footer</footer>
</body>
</html>`;

test("e2e: built output boots, exposes fetch_markdown, pins version", async () => {
  const client = await spawnBuilt();
  try {
    const info = client.getServerVersion();
    assert.equal(info?.name, "markfetch");
    assert.equal(info?.version, "0.6.0");
    const { tools } = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "fetch_markdown");
  } finally {
    await client.close();
  }
});

test("e2e: built output returns markdown for a mock fixture", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HAPPY_FIXTURE);
  });
  const client = await spawnBuilt();
  try {
    const result = await client.callTool({
      name: "fetch_markdown",
      arguments: { url: mock.url },
    });
    assert.equal(result.isError, false);
    const text = textOf(result);
    assert.ok(!text.startsWith("---\n"), "no frontmatter expected");
    assert.match(text, /E2E Fixture Heading/);
    assert.match(text, /## Sub-section/);
    assert.ok(!text.includes("<nav>"), "nav chrome stripped");
    assert.ok(!text.includes("page footer"), "footer stripped");
  } finally {
    await client.close();
    await mock.close();
  }
});

test("e2e: built output returns [network_error] for invalid host", async () => {
  const client = await spawnBuilt();
  try {
    const result = await client.callTool({
      name: "fetch_markdown",
      arguments: { url: "http://no-such-host-zzz-99999.invalid" },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^\[network_error\]/);
  } finally {
    await client.close();
  }
});

// E1 — savePath against the built JS output. Pins the build pipeline against
// the new code path. If T1 (server.test) passes but this fails, the bug is
// in tsc/postbuild, not the runtime logic.
test("e2e: built output writes markdown to savePath, returns confirmation", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HAPPY_FIXTURE);
  });
  const dir = await mkdtemp(join(tmpdir(), "mf-e2e-savepath-"));
  const savePath = join(dir, "out.md");
  const client = await spawnBuilt();
  try {
    const result = await client.callTool({
      name: "fetch_markdown",
      arguments: { url: mock.url, savePath },
    });
    assert.equal(result.isError, false);
    const text = textOf(result);
    assert.ok(
      text.startsWith("Saved ") && text.endsWith(` bytes to ${savePath}`),
      `expected 'Saved N bytes to ${savePath}', got: ${text}`,
    );
    const onDisk = await readFile(savePath, "utf8");
    assert.match(onDisk, /E2E Fixture Heading/, "file must contain extracted markdown");
  } finally {
    await client.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// CLI-mode e2e tests. These spawn the built JS output with arguments so the
// dispatcher in dist/index.js routes to dist/cli.js — exercising the lazy
// import path that tsc must emit correctly. If the corresponding cli.test
// passes but these fail, the bug is in the build pipeline, not runtime logic.

test("e2e: built output CLI prints markdown to stdout, exit 0", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HAPPY_FIXTURE);
  });
  try {
    const { stdout, stderr } = await execFileAsync(
      "node",
      [BUILT_JS, mock.url],
      { timeout: 10_000, maxBuffer: 5_000_000 },
    );
    assert.equal(stderr, "", "stderr must stay empty on happy path");
    assert.match(stdout, /E2E Fixture Heading/);
  } finally {
    await mock.close();
  }
});

test("e2e: built output --version prints package version, exit 0", async () => {
  const { stdout, stderr } = await execFileAsync(
    "node",
    [BUILT_JS, "--version"],
    { timeout: 10_000 },
  );
  assert.equal(stderr, "");
  assert.equal(stdout, "0.6.0\n");
});
