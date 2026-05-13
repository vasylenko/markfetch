import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnClient, startMock } from "./_helpers.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

// UPDATE_SNAPSHOTS=1 regenerates .expected.md files instead of asserting
// against them. The standard snapshot-test workflow: run once with the env
// to capture current behaviour, commit the baselines, then run without it
// to detect drift on subsequent edits.
const UPDATE_MODE = process.env.UPDATE_SNAPSHOTS === "1";

// Mutated per test to control what the shared mock server responds with;
// captured by the startMock handler's closure below.
let currentHtml = "";
let mock: Awaited<ReturnType<typeof startMock>>;
let client: Awaited<ReturnType<typeof spawnClient>>;

before(async () => {
  mock = await startMock((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(currentHtml);
  });
  client = await spawnClient({ name: "snapshot-test" });
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
    currentHtml = html;

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
