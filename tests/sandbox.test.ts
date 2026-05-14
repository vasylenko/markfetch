// Unit tests for src/sandbox.ts.
//
// Sandbox is a pure leaf module (no MCP server spin-up needed), so this
// suite exercises buildAllowedRoots and checkPath directly. That gives
// fast, deterministic coverage for the path-edge-case logic (prefix
// overlap, symlink escape, ../ traversal, win32 case-fold) that would
// be painful to validate through the integration boundary alone.
//
// Every fixture is constructed via os.tmpdir() + mkdtemp + path.join —
// no hardcoded platform paths, per the project's review criterion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, parse } from "node:path";
import { buildAllowedRoots, checkPath } from "../src/sandbox.js";

// Scoped mkdtemp + cleanup. We realpath the directory because the sandbox
// module realpath's its inputs internally; testing against an un-resolved
// path on macOS (where /var is a symlink to /private/var) would produce
// containment mismatches that aren't bugs in the module under test.
async function withSandboxTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "sandbox-test-")));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// buildAllowedRoots
// ---------------------------------------------------------------------------

test("buildAllowedRoots: unset env returns realpath(tmpdir) + realpath(cwd)", async () => {
  const roots = await buildAllowedRoots({});
  assert.equal(roots.length, 2);
  assert.equal(roots[0], await realpath(tmpdir()));
  assert.equal(roots[1], await realpath(process.cwd()));
});

test("buildAllowedRoots: empty-string env behaves like unset (defaults apply)", async () => {
  const roots = await buildAllowedRoots({ MARKFETCH_ALLOWED_WRITE_ROOTS: "" });
  assert.equal(roots.length, 2);
});

test("buildAllowedRoots: whitespace-only env throws fail-fast (malformed entry, not treated as unset)", async () => {
  await assert.rejects(
    () => buildAllowedRoots({ MARKFETCH_ALLOWED_WRITE_ROOTS: "   " }),
    /every entry must be an absolute path/,
  );
});

test("buildAllowedRoots: single-entry env REPLACES the defaults (not merge)", async () => {
  await withSandboxTmpDir(async (dir) => {
    const roots = await buildAllowedRoots({
      MARKFETCH_ALLOWED_WRITE_ROOTS: dir,
    });
    assert.deepEqual(roots, [dir]);
  });
});

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

test("buildAllowedRoots: non-absolute entry throws fail-fast", async () => {
  await assert.rejects(
    () =>
      buildAllowedRoots({ MARKFETCH_ALLOWED_WRITE_ROOTS: "relative/path" }),
    /every entry must be an absolute path/,
  );
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
// checkPath
// ---------------------------------------------------------------------------

test("checkPath: path inside a root is ok", async () => {
  await withSandboxTmpDir(async (dir) => {
    const result = await checkPath(join(dir, "out.md"), [dir]);
    assert.equal(result.ok, true);
  });
});

test("checkPath: path outside all roots is not ok; message names the roots", async () => {
  await withSandboxTmpDir(async (dir) => {
    // Filesystem root is always outside an mkdtemp dir under tmpdir.
    // Use parse(dir).root so the test stays portable to Windows drive
    // letters (`C:\\`) without hardcoding.
    const outside = join(parse(dir).root, "very-unlikely-target.md");
    const result = await checkPath(outside, [dir]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /outside the allowed write roots/);
      assert.ok(
        result.reason.includes(dir),
        "reason should name the allowed root for caller-side recovery",
      );
    }
  });
});

test("checkPath: ../ traversal that escapes a root is not ok", async () => {
  await withSandboxTmpDir(async (dir) => {
    // dir/sub/../../escape resolves to dir/../escape — a sibling of dir.
    // path.resolve handles the `..` normalization; path.relative then
    // refuses the resulting outside-root path.
    const escape = join(dir, "sub", "..", "..", "escape.md");
    const result = await checkPath(escape, [dir]);
    assert.equal(result.ok, false);
  });
});

test("checkPath: prefix-overlap trap (root /tmp vs target /tmp-evil)", async () => {
  await withSandboxTmpDir(async (root) => {
    // Construct a sibling whose name shares a prefix with root. A naive
    // `target.startsWith(root)` would pass this incorrectly; path.relative
    // returns "../<sibling-name>/..." which we reject.
    const sibling = `${root}-evil`;
    const target = join(sibling, "trap.md");
    const result = await checkPath(target, [root]);
    assert.equal(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// Symlink escape — POSIX-gated.
// Windows symlink creation typically requires elevation; the platform-
// independent property under test (realpath defeats symlink escape) is
// implemented identically on both, so POSIX coverage is sufficient.
// ---------------------------------------------------------------------------

test(
  "checkPath: symlink inside sandbox pointing outside is blocked by realpath",
  { skip: process.platform === "win32" },
  async () => {
    await withSandboxTmpDir(async (sandbox) => {
      await withSandboxTmpDir(async (outside) => {
        const inner = join(sandbox, "inner");
        await mkdir(inner);
        const link = join(inner, "escape");
        await symlink(outside, link);
        // The intent: write through inner/escape (a symlink) into outside.
        // realpath resolves the symlink, and the containment check then
        // sees `outside/should-not-write.md`, which is outside `sandbox`.
        const target = join(link, "should-not-write.md");
        const result = await checkPath(target, [sandbox]);
        assert.equal(result.ok, false, "symlink escape must be blocked");
        if (!result.ok) {
          assert.match(result.reason, /outside the allowed write roots/);
        }
      });
    });
  },
);

// ---------------------------------------------------------------------------
// Windows case-insensitivity — win32-gated.
// ---------------------------------------------------------------------------

test(
  "checkPath: case-variant paths compare equal on win32",
  { skip: process.platform !== "win32" },
  async () => {
    await withSandboxTmpDir(async (dir) => {
      // Construct a case-variant root: leave the drive letter as-is but
      // case-flip everything after it. The filesystem treats them as the
      // same directory; the sandbox must too.
      const variant = dir.charAt(0) + dir.slice(1).toLowerCase();
      const target = join(dir.toUpperCase(), "out.md");
      const result = await checkPath(target, [variant]);
      assert.equal(
        result.ok,
        true,
        "win32 containment compare must be case-insensitive",
      );
    });
  },
);
