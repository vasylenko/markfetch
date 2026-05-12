// Cross-platform test driver. `npm test` invokes this so the glob expansion
// happens in Node, not in the shell — cmd.exe on Windows does not expand
// `tests/*.test.ts` and `node --test <dir>` treats its argument as a single
// file path (not a directory walk). Listing every test file in package.json
// would work but rots when files are added; reading the directory keeps the
// discovery rule centralized.
import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = join(projectRoot, "tests");

const files = readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => join("tests", name))
  .sort();

if (files.length === 0) {
  console.error("No test files found in tests/");
  process.exit(1);
}

// Resolve tsx through node_modules/.bin so platform-specific suffixes
// (.cmd on Windows, the POSIX shell script on Linux/macOS) are picked
// automatically by the platform's spawn loader.
const tsxBin = join(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

const child = spawn(tsxBin, ["--test", ...files], {
  cwd: projectRoot,
  stdio: "inherit",
  // Windows .cmd files require shell:true with execFile/spawn; harmless on
  // POSIX where the resolved tsx is an executable shell script.
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
