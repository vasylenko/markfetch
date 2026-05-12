// Sets execute bit on dist/index.js so the shebang-based launch works —
// both when npm links the `bin` entry (npm/npx exec the linked target)
// and when running ./dist/index.js directly. tsc preserves the shebang
// but doesn't chmod its outputs.
import { chmodSync } from "node:fs";

chmodSync("dist/index.js", 0o755);
