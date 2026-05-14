// Write-path containment for the MCP adapter. MCP's caller is a language
// model — possibly steered by the page it just fetched — so this module
// bounds the filesystem paths it can write to. CLI is intentionally
// unbounded (human at the shell is the security boundary); only MCP uses
// this module.
//
// Invariants:
//   - Leaf module: no imports from siblings, unit-testable in isolation.
//   - No console.* — buildAllowedRoots throws (escapes module init in
//     mcp.ts, surfaces on stderr); checkPath returns a discriminated union.
//   - No hardcoded platform paths; every platform-dependent value comes
//     from a Node API.

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

// Defaults: realpath(os.tmpdir()) ∪ realpath(process.cwd()).
// MARKFETCH_ALLOWED_WRITE_ROOTS REPLACES the defaults (no merge); every
// entry must be absolute, resolvable via realpath, and a directory. Bad
// config throws at module init — same fail-fast contract as intEnv().
export async function buildAllowedRoots(
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const raw = env[ENV_VAR];
  if (raw != null && raw !== "") {
    const resolved: string[] = [];
    for (const entry of raw.split(delimiter)) {
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

// Resolve savePath through fs.realpath (defeating symlink escape) and check
// containment against allowed roots. Walks up to the deepest extant ancestor
// because the leaf usually doesn't exist yet — that's the point of "save".
export async function checkPath(
  savePath: string,
  roots: string[],
): Promise<CheckResult> {
  const normalized = resolve(savePath);

  let ancestor = normalized;
  const trailing: string[] = [];
  while (true) {
    try {
      await stat(ancestor);
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        // Reached filesystem root with no extant ancestor — fail closed.
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

  // Win32 case-fold: filesystem is case-insensitive and fs.realpath doesn't
  // reliably canonicalize case, so compare both sides lowercased.
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
