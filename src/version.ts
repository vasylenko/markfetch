// Single source of truth for the version both adapters announce (CLI
// `--version` and the MCP initialize handshake). Read from package.json at
// load rather than hardcoded, so a release bump can't drift from the published
// version. package.json sits one level above this module in both layouts
// (src/ in dev, dist/ when built) and npm always ships it in the tarball.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const version: string = pkg.version;
