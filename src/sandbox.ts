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

// Per-entry validation for MARKFETCH_ALLOWED_WRITE_ROOTS. Each entry must be
// absolute, resolvable via realpath, and a directory; any failure throws with
// the entry quoted in the message so misconfiguration is easy to diagnose.
async function resolveAllowedRoot(entry: string): Promise<string> {
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
  return resolvedEntry;
}

// Defaults: realpath(os.tmpdir()) ∪ realpath(process.cwd()).
// MARKFETCH_ALLOWED_WRITE_ROOTS REPLACES the defaults (no merge) — deliberate;
// setting it is asserting a policy, so additive defaults would weaken it.
// Callers who want tmpdir/cwd back must list them explicitly. Bad config
// throws at module init — same fail-fast contract as intEnv().
export async function buildAllowedRoots(
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const raw = env[ENV_VAR];
  if (raw == null || raw === "") {
    return [await realpath(tmpdir()), await realpath(process.cwd())];
  }
  // Sequential (not Promise.all) to preserve ordering and fail-fast-on-first-
  // error semantics that the multi-entry test relies on.
  const resolved: string[] = [];
  for (const entry of raw.split(delimiter)) {
    resolved.push(await resolveAllowedRoot(entry));
  }
  return resolved;
}

// Walk up `start` until an extant ancestor is found, accumulating the
// synthetic suffix that has to be reattached afterwards. Returns null when
// the filesystem root is reached without finding anything that exists — the
// caller fails closed in that case.
async function walkToExtantAncestor(
  start: string,
): Promise<{ ancestor: string; trailing: string[] } | null> {
  let ancestor = start;
  const trailing: string[] = [];
  while (true) {
    try {
      await stat(ancestor);
      return { ancestor, trailing };
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return null;
      trailing.unshift(parse(ancestor).base);
      ancestor = parent;
    }
  }
}

// True iff `target` is `root` itself or a descendant. Both inputs must be
// pre-folded by the caller when running on a case-insensitive filesystem.
function isContainedIn(target: string, root: string): boolean {
  const rel = relative(root, target);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

// Resolve savePath through fs.realpath (defeating symlink escape) and check
// containment against allowed roots. Walks up to the deepest extant ancestor
// because the leaf usually doesn't exist yet — that's the point of "save".
export async function checkPath(
  savePath: string,
  roots: string[],
): Promise<CheckResult> {
  const normalized = resolve(savePath);

  const walked = await walkToExtantAncestor(normalized);
  if (walked === null) {
    return {
      ok: false,
      reason: `cannot resolve any extant ancestor for '${savePath}'`,
    };
  }

  const resolvedAncestor = await realpath(walked.ancestor);
  const reattached =
    walked.trailing.length === 0
      ? resolvedAncestor
      : join(resolvedAncestor, ...walked.trailing);

  // Win32 case-fold: filesystem is case-insensitive and fs.realpath doesn't
  // reliably canonicalize case, so compare both sides lowercased.
  const fold =
    process.platform === "win32"
      ? (s: string) => s.toLowerCase()
      : (s: string) => s;
  const foldedTarget = fold(reattached);

  for (const root of roots) {
    if (isContainedIn(foldedTarget, fold(root))) {
      return { ok: true, resolved: reattached };
    }
  }

  const rootsList = roots.map((r) => `'${r}'`).join(", ");
  return {
    ok: false,
    reason: `'${reattached}' is outside the allowed write roots: [${rootsList}]`,
  };
}
