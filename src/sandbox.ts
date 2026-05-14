// Write-path containment for the MCP adapter.
//
// The MCP tool exposes a `savePath` argument that lands on disk verbatim,
// and the caller is a language model — possibly steered by the page it just
// fetched. Without bounds, a hallucinated or injected path can target
// arbitrary filesystem locations under the process's UID. This module is
// the bound: it builds an allowed-roots set at startup and verifies each
// savePath stays inside it.
//
// Invariants (load-bearing — keep this list synchronized with SPEC.md):
//   - Leaf module. No imports from siblings (core.ts, mcp.ts, cli.ts) so
//     it stays unit-testable without spinning up the MCP server or pulling
//     in undici / turndown / etc.
//   - No console.* calls. buildAllowedRoots throws (the throw escapes
//     module init in mcp.ts and surfaces on stderr per existing intEnv
//     convention). checkPath returns a discriminated union so the caller
//     decides the user-facing channel.
//   - No hardcoded platform paths. Every platform-dependent value comes
//     from a Node API: os.tmpdir(), process.cwd(), path.isAbsolute,
//     path.delimiter, fs.realpath, process.platform. This is a non-
//     negotiable review criterion for the module.
//
// Threat model: CLI is unrestricted (human is the security boundary).
// MCP is sandboxed (LLM caller is the threat surface). The asymmetry
// lives in the call site (mcp.ts uses this module; cli.ts does not).

import { realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
} from "node:path";

const ENV_VAR = "MARKFETCH_ALLOWED_WRITE_ROOTS";

export type CheckResult =
  | { ok: true; resolved: string }
  | { ok: false; reason: string };

// Build the set of directories MCP `savePath` writes are allowed into.
//
// If MARKFETCH_ALLOWED_WRITE_ROOTS is set, its entries REPLACE the default
// set entirely — "if you set it, you own the policy." Each entry must be
// absolute and must resolve via fs.realpath at startup; we error early so
// a bad config surfaces at module init rather than at first-write time
// (consistent with intEnv's fail-fast contract in core.ts).
//
// If unset, the default set is [realpath(os.tmpdir()), realpath(cwd)].
// Both are realpath'd once at startup so symlink-following is stable
// across all later checkPath calls.
export async function buildAllowedRoots(
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const raw = env[ENV_VAR];
  if (raw != null && raw !== "") {
    const entries = raw.split(delimiter);
    const resolved: string[] = [];
    for (const entry of entries) {
      if (!isAbsolute(entry)) {
        throw new Error(
          `Invalid ${ENV_VAR} entry ${JSON.stringify(entry)} — every entry must be an absolute path.`,
        );
      }
      let resolvedEntry: string;
      try {
        resolvedEntry = await realpath(entry);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Invalid ${ENV_VAR} entry ${JSON.stringify(entry)} — could not resolve: ${message}`,
        );
      }
      const stats = await stat(resolvedEntry);
      if (!stats.isDirectory()) {
        throw new Error(
          `Invalid ${ENV_VAR} entry ${JSON.stringify(entry)} — resolved to ${JSON.stringify(resolvedEntry)} which is not a directory.`,
        );
      }
      resolved.push(resolvedEntry);
    }
    return resolved;
  }
  return [await realpath(tmpdir()), await realpath(process.cwd())];
}

// Check whether a savePath, after symlink resolution, sits inside the
// allowed roots. Steps:
//   1. path.resolve to normalize "../" segments.
//   2. Walk upward to the deepest extant ancestor — the leaf usually
//      doesn't exist yet (that's the point of "save"), so we can't realpath
//      it directly; we realpath the closest existing directory and reattach
//      the not-yet-existing trailing segments.
//   3. fs.realpath the extant ancestor — defeats symlink escape: a symlink
//      planted inside the sandbox that points outside resolves to its
//      outside-target before the containment check.
//   4. Reattach the trailing segments via path.join.
//   5. For each root, path.relative(root, reattached). Contained iff the
//      relative path is empty (target == root), or doesn't start with ".."
//      and isn't itself absolute (target is below root). On win32, fold
//      both sides to lowercase first — the filesystem is case-insensitive
//      and realpath doesn't reliably canonicalize case.
export async function checkPath(
  savePath: string,
  roots: string[],
): Promise<CheckResult> {
  const normalized = resolve(savePath);

  // Walk up to find an extant ancestor. cwd or filesystem root is always
  // extant in practice; this terminates at parse(p).root for the pathological
  // "non-existent drive letter on Windows" case, where we fail closed.
  let ancestor = normalized;
  const trailing: string[] = [];
  // Deliberate single-pass loop; iteration count is bounded by path depth.
  while (true) {
    try {
      await stat(ancestor);
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        return {
          ok: false,
          reason: `cannot resolve any extant ancestor for '${savePath}'`,
        };
      }
      trailing.unshift(parse(ancestor).base);
      ancestor = parent;
    }
  }

  const resolvedAncestor = await realpath(ancestor);
  const reattached =
    trailing.length === 0
      ? resolvedAncestor
      : join(resolvedAncestor, ...trailing);

  // win32-only case fold. On POSIX this is identity, so paths flow through
  // unchanged on case-sensitive filesystems (Linux, most macOS APFS setups).
  const fold =
    process.platform === "win32"
      ? (s: string) => s.toLowerCase()
      : (s: string) => s;
  const foldedTarget = fold(reattached);

  for (const root of roots) {
    const rel = relative(fold(root), foldedTarget);
    if (rel === "") return { ok: true, resolved: reattached };
    if (!rel.startsWith("..") && !isAbsolute(rel)) {
      return { ok: true, resolved: reattached };
    }
  }
  return {
    ok: false,
    reason: `'${reattached}' is outside the allowed write roots: [${roots.map((r) => `'${r}'`).join(", ")}]`,
  };
}
