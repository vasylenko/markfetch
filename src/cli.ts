// CLI adapter. Imported lazily by index.ts when any argument is present
// (bare invocation routes to mcp.ts instead, preserving the existing MCP
// server contract for every client config that doesn't pass args).
//
// Output channels:
//   - stdout: markdown body (no -o) OR "Saved N bytes to <path>" confirmation
//     (with -o). The markdown is written via `process.stdout.write` so its
//     own trailing whitespace is preserved verbatim — same bytes as the MCP
//     adapter would emit in content[0].text.
//   - stderr: "[code] message" on any error path. Exits with non-zero code.
//     The project principle "no ANSI escapes" extends here — keep stderr
//     plain so shell pipelines can grep / split on the [code] prefix.

import { Command } from "commander";
import { resolve } from "node:path";
import { fetchMarkdown, classifyError } from "./core.js";

const program = new Command();

program
  .name("markfetch")
  .description(
    "Fetch a URL and return clean markdown.\n" +
      "Run with no arguments to start the MCP stdio server.",
  )
  .version("0.6.0")
  .argument("<url>", "absolute http(s) URL to fetch")
  .option(
    "-o, --output <path>",
    "save markdown to file (absolute or relative path); default is stdout",
  )
  .action(async (url: string, options: { output?: string }) => {
    // CLI resolves relative output paths against cwd before calling core;
    // core requires an absolute path so the contract is unambiguous regardless
    // of which adapter invokes it. Tilde expansion is intentionally NOT done
    // here — the shell expands `~/foo` before argv reaches the process, and
    // a quoted literal `'~/foo'` should produce a file named `~/foo` in cwd
    // (standard tool behavior).
    const savePath = options.output
      ? resolve(process.cwd(), options.output)
      : undefined;
    try {
      const { markdown, bytes, savedTo } = await fetchMarkdown({
        url,
        savePath,
      });
      if (savedTo === undefined) {
        // Raw markdown body — no added newline, matches MCP content[0].text.
        process.stdout.write(markdown);
      } else {
        // Confirmation message — the only stdout newline the CLI ever adds.
        console.log(`Saved ${bytes} bytes to ${savedTo}`);
      }
    } catch (err) {
      const { code, message } = classifyError(err);
      console.error(`[${code}] ${message}`);
      // Use exitCode (not exit()) so pending output drains before the process
      // exits — relevant when stdout is piped to a slow consumer.
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);
