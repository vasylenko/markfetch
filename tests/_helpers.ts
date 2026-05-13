// Shared test helpers extracted from cli.test.ts / server.test.ts / e2e.test.ts
// to remove copy-paste duplication. Not a test file itself — the runner pattern
// `tsx --test tests/*.test.ts` (see package.json) excludes this file by name.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export async function startMock(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = createServer(handler);
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = httpServer.address();
  if (!address || typeof address !== "object") {
    throw new Error("mock server address unavailable");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    // closeAllConnections() drops keep-alive sockets so close() actually
    // resolves; without it the server lingers past the test boundary.
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export function textOf(result: { content: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content[0]?.text ?? "";
}

// Deterministic Readability-friendly fixture with three <h2> sections so
// server-side tests that assert on multiple sub-headings have material;
// CLI tests assert on a subset and still pass.
export const HAPPY_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head><title>Test Article</title></head>
<body>
  <header><nav>nav links</nav></header>
  <main>
    <article>
      <h1>Test Article Title</h1>
      <p>First substantive paragraph with enough content to pass Readability's heuristics. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. The article contains real prose for the extractor to score positively.</p>
      <h2>Section heading</h2>
      <p>Second paragraph with continuing content. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. More words to give Readability adequate signal.</p>
      <h2>Another section</h2>
      <p>Third paragraph: Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>
    </article>
  </main>
  <footer>copyright</footer>
</body>
</html>`;
