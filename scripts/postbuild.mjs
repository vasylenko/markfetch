// Sets execute bit on dist/index.js so the npm `bin` entry resolves correctly
// when invoked via `npx markfetch` or as a direct script. tsc preserves the
// shebang but doesn't chmod its outputs.
import { chmodSync } from "node:fs";

chmodSync("dist/index.js", 0o755);
