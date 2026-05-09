import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

// UPDATE_SNAPSHOTS=1 regenerates .expected.md files instead of asserting
// against them. The standard snapshot-test workflow: run once with the env
// to capture current behaviour, commit the baselines, then run without it
// to detect drift on subsequent edits.
const UPDATE_MODE = process.env.UPDATE_SNAPSHOTS === "1";

type Mock = {
  url: string;
  setHtml: (html: string) => void;
  close: () => Promise<void>;
};

let mock: Mock;
let client: Client;

before(async () => {
  let currentHtml = "";
  const httpServer = createServer(
    (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(currentHtml);
    },
  );
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = httpServer.address();
  if (!address || typeof address !== "object") {
    throw new Error("mock server address unavailable");
  }
  mock = {
    url: `http://127.0.0.1:${address.port}`,
    setHtml: (html) => {
      currentHtml = html;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };

  const transport = new StdioClientTransport({
    command: "tsx",
    args: ["src/index.ts"],
    env: process.env as Record<string, string>,
  });
  client = new Client({ name: "snapshot-test", version: "0.0.0" });
  await client.connect(transport);
});

after(async () => {
  await client.close();
  await mock.close();
});

const fixtureNames = (await readdir(FIXTURES_DIR))
  .filter((f) => f.endsWith(".html"))
  .map((f) => f.replace(/\.html$/, ""))
  .sort();

for (const name of fixtureNames) {
  test(`snapshot: ${name}`, async () => {
    const html = await readFile(join(FIXTURES_DIR, `${name}.html`), "utf8");
    mock.setHtml(html);

    const result = await client.callTool({
      name: "fetch_markdown",
      arguments: { url: mock.url },
    });

    assert.equal(
      result.isError,
      false,
      `extraction returned isError=true for ${name}`,
    );
    const content = result.content as Array<{ type: string; text?: string }>;
    // Mock server binds to an ephemeral port per run; normalize the dynamic
    // origin to a fixed placeholder so snapshots are stable across invocations.
    const actual = (content[0]?.text ?? "").replaceAll(mock.url, "http://mock");

    const expectedPath = join(FIXTURES_DIR, `${name}.expected.md`);
    if (UPDATE_MODE) {
      await writeFile(expectedPath, actual, "utf8");
      return;
    }

    let expected: string;
    try {
      expected = await readFile(expectedPath, "utf8");
    } catch {
      throw new Error(
        `missing snapshot ${expectedPath} — run with UPDATE_SNAPSHOTS=1 to create it`,
      );
    }

    assert.equal(
      actual,
      expected,
      `${name} markdown does not match snapshot — re-run with UPDATE_SNAPSHOTS=1 to update if intentional`,
    );
  });
}
