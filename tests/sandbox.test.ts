// Unit tests for src/sandbox.ts — narrow path-edge-cases that are painful
// to validate via the integration boundary in server.test.ts (../ traversal,
// prefix-overlap, multi-entry env split, fail-fast variants without an
// integration analog, win32 case-fold). All other sandbox behaviors are
// covered by T9–T13 in server.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { buildAllowedRoots, checkPath } from "../src/sandbox.js";

// realpath the mkdtemp so containment compares against the same form the
// sandbox uses internally (on macOS, /var → /private/var).
async function withSandboxTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "sandbox-test-")));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// buildAllowedRoots — env-parsing edge cases not exercised by integration.
// ---------------------------------------------------------------------------

test("buildAllowedRoots: multi-entry env split by path.delimiter", async () => {
  await withSandboxTmpDir(async (a) => {
    await withSandboxTmpDir(async (b) => {
      const roots = await buildAllowedRoots({
        MARKFETCH_ALLOWED_WRITE_ROOTS: `${a}${delimiter}${b}`,
      });
      assert.deepEqual(roots, [a, b]);
    });
  });
});

test("buildAllowedRoots: non-existent entry throws fail-fast (realpath fails)", async () => {
  await withSandboxTmpDir(async (dir) => {
    const nope = join(dir, "does-not-exist");
    await assert.rejects(
      () => buildAllowedRoots({ MARKFETCH_ALLOWED_WRITE_ROOTS: nope }),
      /could not resolve/,
    );
  });
});

test("buildAllowedRoots: empty entry from leading/trailing/consecutive delimiter throws fail-fast", async () => {
  await assert.rejects(
    () =>
      buildAllowedRoots({
        MARKFETCH_ALLOWED_WRITE_ROOTS: `${delimiter}/some/path`,
      }),
    /every entry must be an absolute path/,
  );
});

test("buildAllowedRoots: regular-file entry throws fail-fast (must be a directory)", async () => {
  await withSandboxTmpDir(async (dir) => {
    const filePath = join(dir, "regular-file.txt");
    await writeFile(filePath, "");
    await assert.rejects(
      () => buildAllowedRoots({ MARKFETCH_ALLOWED_WRITE_ROOTS: filePath }),
      /not a directory/,
    );
  });
});

// ---------------------------------------------------------------------------
// checkPath — narrow containment-logic edge cases.
// ---------------------------------------------------------------------------

test("checkPath: ../ traversal that escapes a root is not ok", async () => {
  await withSandboxTmpDir(async (dir) => {
    // dir/sub/../../escape resolves to dir/../escape — a sibling of dir.
    // path.resolve normalizes the ..; path.relative then rejects.
    const escape = join(dir, "sub", "..", "..", "escape.md");
    const result = await checkPath(escape, [dir]);
    assert.equal(result.ok, false);
  });
});

test("checkPath: prefix-overlap trap (root /tmp vs target /tmp-evil)", async () => {
  await withSandboxTmpDir(async (root) => {
    // Sibling sharing root's prefix. A naive target.startsWith(root) would
    // pass this incorrectly; path.relative returns "../<sibling>/trap.md".
    const target = join(`${root}-evil`, "trap.md");
    const result = await checkPath(target, [root]);
    assert.equal(result.ok, false);
  });
});

test(
  "checkPath: case-variant paths compare equal on win32",
  { skip: process.platform !== "win32" },
  async () => {
    await withSandboxTmpDir(async (dir) => {
      const variant = dir.charAt(0) + dir.slice(1).toLowerCase();
      const target = join(dir.toUpperCase(), "out.md");
      const result = await checkPath(target, [variant]);
      assert.equal(result.ok, true);
    });
  },
);
