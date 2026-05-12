#!/usr/bin/env node

// Argv-discriminated dispatcher.
//
// `process.argv.length === 2` means the user provided zero arguments
// (argv[0] is the node binary, argv[1] is this script path). That's the
// shape every MCP client uses when spawning a server — so bare invocation
// routes to the MCP adapter and preserves every existing client config.
//
// Any extra arg (a URL, `--help`, `--version`, `-o`, even an unknown flag)
// routes to the CLI adapter, which uses commander to parse and validate.
//
// The dynamic `import("./mcp.js")` vs `import("./cli.js")` is intentional:
// it ensures the MCP path never loads commander, and the CLI path never
// loads @modelcontextprotocol/sdk. More importantly, it makes the stdout
// invariant structural — code reachable from MCP mode literally cannot
// reach `console.log` in cli.ts because cli.ts is never imported. The
// invariant is enforced by the module graph, not by developer discipline.

if (process.argv.length === 2) {
  await import("./mcp.js");
} else {
  await import("./cli.js");
}
