// CLI tests. Run the dispatcher via `tsx src/index.ts <args>` as a real
// subprocess so we observe exit codes, stdout, and stderr — the things
// shell consumers actually depend on. The MCP SDK Client is irrelevant
// here; this is a plain CLI surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import {
  startMock,
  HAPPY_FIXTURE,
  TSX_LOADER_URL,
  PKG_VERSION,
} from "./_helpers.js";

const execFileAsync = promisify(execFile);

// Absolute so tests that override the child cwd still locate the entry.
const ENTRY = resolvePath("src/index.ts");

type RunResult = { code: number; stdout: string; stderr: string };

// Runs `tsx src/index.ts <args>` and resolves with the full process result.
// Uses execFile (not raw spawn) so Node owns the stream lifecycle end-to-end
// — manual on("data") + on("exit") plumbing trips a native assertion in the
// libuv check phase under Node's test runner on this version. execFile waits
// for stream close and reports exit code uniformly via promise resolve/reject.
//
// Hard 10s timeout; every test path here finishes well under a second on a
// healthy system, so a hang means something is genuinely wrong (and we want
// a clean fail rather than a stalled run).
async function runCli(
  args: string[],
  env: Record<string, string> = {},
  cwd?: string,
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", TSX_LOADER_URL, ENTRY, ...args],
      {
        env: { ...process.env, ...env } as Record<string, string>,
        cwd,
        timeout: 10_000,
        // 5 MB is well above any markdown the test fixtures produce; raises
        // the default 1 MB cap so a regression that floods stdout fails
        // loudly with a clear assertion rather than a buffer-overflow error.
        maxBuffer: 5_000_000,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    // execFile rejects on non-zero exit; the rejection object carries the
    // same {code, stdout, stderr} we'd otherwise extract manually.
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: e.code ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

test("CLI: happy path → markdown to stdout, stderr empty, exit 0", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HAPPY_FIXTURE);
  });
  try {
    const { code, stdout, stderr } = await runCli([mock.url]);
    assert.equal(code, 0, `exit code should be 0; stderr was: ${stderr}`);
    assert.equal(stderr, "", "stderr must stay empty on happy path");
    assert.match(stdout, /Test Article Title/);
    assert.match(stdout, /## Section heading/);
    assert.ok(!stdout.includes("<nav>"), "nav chrome should be stripped");
  } finally {
    await mock.close();
  }
});

test("CLI: --raw returns the unprocessed body verbatim to stdout", async () => {
  const RAW = '{"hello":"world","n":42}';
  const mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(RAW);
  });
  try {
    const { code, stdout, stderr } = await runCli([mock.url, "--raw"]);
    assert.equal(code, 0, `stderr was: ${stderr}`);
    assert.equal(stderr, "");
    // Byte-for-byte: content-type gate and Readability skipped, no added newline.
    assert.equal(stdout, RAW);
  } finally {
    await mock.close();
  }
});

test("CLI: -o <absolute-path> writes file, prints confirmation to stdout", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HAPPY_FIXTURE);
  });
  const dir = await mkdtemp(join(tmpdir(), "mf-cli-abs-"));
  const savePath = join(dir, "out.md");
  try {
    const { code, stdout, stderr } = await runCli([mock.url, "-o", savePath]);
    assert.equal(code, 0, `stderr was: ${stderr}`);
    assert.equal(stderr, "", "stderr must stay empty on success");
    assert.match(stdout, /^Saved \d+ bytes to /);
    assert.ok(
      stdout.trim().endsWith(savePath),
      `confirmation should reference the savePath; got: ${stdout}`,
    );
    const onDisk = await readFile(savePath, "utf8");
    assert.match(onDisk, /Test Article Title/);
    // Confirmation byte count must equal on-disk size (regression-guard
    // mirroring server.test.ts T2: catches anyone replacing Buffer.byteLength
    // with markdown.length).
    const match = /^Saved (\d+) bytes to /.exec(stdout);
    assert.ok(match);
    const reported = Number(match![1]);
    const onDiskSize = (await stat(savePath)).size;
    assert.equal(reported, onDiskSize);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test("CLI: -o <relative-path> is resolved against cwd", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HAPPY_FIXTURE);
  });
  const dir = await mkdtemp(join(tmpdir(), "mf-cli-rel-"));
  try {
    // Pass a relative output path; runCli sets cwd to `dir` so the relative
    // path should resolve to <dir>/out.md.
    const { code, stdout, stderr } = await runCli(
      [mock.url, "-o", "out.md"],
      {},
      dir,
    );
    assert.equal(code, 0, `stderr was: ${stderr}`);
    const resolved = join(dir, "out.md");
    assert.ok(
      stdout.trim().endsWith(resolved),
      `confirmation should reference resolved path ${resolved}; got: ${stdout}`,
    );
    const onDisk = await readFile(resolved, "utf8");
    assert.match(onDisk, /Test Article Title/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test("CLI: unresolvable host → [network_error] on stderr, exit non-zero", async () => {
  const { code, stdout, stderr } = await runCli([
    "http://no-such-host-xyz-12345.invalid",
  ]);
  assert.notEqual(code, 0);
  assert.equal(stdout, "", "stdout must stay empty on error");
  assert.match(stderr, /^\[network_error\]/);
});

test("CLI: 404 response → [http_error] on stderr, exit non-zero", async () => {
  const mock = await startMock((_req, res) => {
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("<html><body>not found</body></html>");
  });
  try {
    const { code, stdout, stderr } = await runCli([mock.url]);
    assert.notEqual(code, 0);
    assert.equal(stdout, "");
    assert.match(stderr, /^\[http_error\]/);
    assert.match(stderr, /404/);
  } finally {
    await mock.close();
  }
});

test("CLI: timeout when MARKFETCH_TIMEOUT_MS is small and server hangs", async () => {
  const mock = await startMock(() => {});
  try {
    const start = Date.now();
    const { code, stdout, stderr } = await runCli([mock.url], {
      MARKFETCH_TIMEOUT_MS: "200",
    });
    const elapsed = Date.now() - start;
    assert.notEqual(code, 0);
    assert.equal(stdout, "");
    assert.match(stderr, /^\[timeout\]/);
    // 3000ms is generous headroom for node + tsx ESM-loader cold-start
    // (especially slow Windows runners); the timeout itself fires at 200ms.
    assert.ok(elapsed < 3000, `timeout should fire fast; took ${elapsed}ms`);
  } finally {
    await mock.close();
  }
});

test("CLI: --help prints usage to stdout, exit 0", async () => {
  const { code, stdout, stderr } = await runCli(["--help"]);
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.match(stdout, /Usage: markfetch/);
  assert.match(stdout, /<url>/);
  assert.match(stdout, /--output/);
});

test("CLI: --version prints version to stdout, exit 0", async () => {
  const { code, stdout, stderr } = await runCli(["--version"]);
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.equal(stdout, `${PKG_VERSION}\n`);
});

// This test documents a deliberate asymmetry vs MCP: a malformed URL is NOT
// rejected at the parser level on the CLI side. CLI's argv parser (commander)
// only checks that <url> is *some* string; the actual URL-shape check happens
// inside undici.fetch, which throws a TypeError that classifyError maps to
// [network_error]. MCP mode is stricter — its zod schema rejects malformed
// URLs before they reach core. Both behaviors are correct for their channel:
// MCP clients expect structured pre-call validation; shell users expect
// "whatever you gave me will be attempted, and you get a [code] error back".
test("CLI: malformed URL surfaces as [network_error] (not a parser rejection)", async () => {
  const { code, stdout, stderr } = await runCli(["not-a-url"]);
  assert.notEqual(code, 0);
  assert.equal(stdout, "");
  assert.match(stderr, /^\[network_error\]/);
});
