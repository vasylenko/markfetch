// CLI tests. Run the dispatcher via `tsx src/index.ts <args>` as a real
// subprocess so we observe exit codes, stdout, and stderr — the things
// shell consumers actually depend on. The MCP SDK Client is irrelevant
// here; this is a plain CLI surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

// Resolved at module load against the test runner's cwd (the project root).
// Tests that override `cwd` to a tmpdir still need to find the tsx loader
// and the source entry — passing relative paths or bare module specifiers
// would resolve against the new cwd and produce a confusing ENOENT (or fail
// module resolution) instead of the behavior under test. Going through
// `node --import <absolute-file-url>` also sidesteps the Windows wrapper
// problem: the .bin shim is `tsx.cmd` on Windows and a shell script on
// POSIX, neither of which child_process can spawn uniformly across hosts.
const NODE_BIN = process.execPath;
const TSX_LOADER_URL = pathToFileURL(
  resolvePath("./node_modules/tsx/dist/loader.mjs"),
).href;
const ENTRY = resolvePath("src/index.ts");

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
    </article>
  </main>
  <footer>copyright</footer>
</body>
</html>`;

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
      NODE_BIN,
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
    // 1500ms allows for tsx cold-start; the timeout itself fires at 200ms.
    assert.ok(elapsed < 1500, `timeout should fire fast; took ${elapsed}ms`);
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
  assert.equal(stdout, "0.5.0\n");
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
