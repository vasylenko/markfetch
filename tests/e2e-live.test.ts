// Live end-to-end tests against real production web pages.
//
// These tests exercise the full markfetch pipeline (HTTP/2 + Chrome
// fingerprint + linkedom + Readability + turndown) against actual
// public URLs — the only place we get signal that the bot-detection
// fingerprint and Reader-View extraction still work in production.
//
// They are EXCLUDED from the default `npm test` run via a per-test
// skip gate, so the default suite stays deterministic and offline-safe.
// To enable:
//
//   POSIX:   MARKFETCH_LIVE_E2E=1 npm test
//   PowerShell:  $env:MARKFETCH_LIVE_E2E=1; npm test
//   cmd.exe: set MARKFETCH_LIVE_E2E=1 && npm test
//
// You can also run only this file:
//
//   MARKFETCH_LIVE_E2E=1 npx tsx --test tests/e2e-live.test.ts
//
// Assertions are property-based (title presence, structural counts,
// chrome stripped) — they intentionally do NOT match exact upstream
// strings, because the target pages will rewrite their copy over time.
// If a test starts failing, first check whether the target page still
// exists and still has roughly the structure described in the comment
// above each test, then investigate the pipeline.
//
// CI: these tests are not part of the default CI matrix. Wiring them
// into a nightly schedule (or a manual-dispatch live-check workflow)
// is a deliberate follow-up — flakiness from network / rate limits /
// upstream content drift should not gate every PR.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve as resolvePath } from "node:path";

const execFileAsync = promisify(execFile);

const LIVE_E2E_ENABLED = process.env.MARKFETCH_LIVE_E2E === "1";
const BUILT_JS = resolvePath("dist/index.js");

// Generous timeout: real network round-trips + large article body
// extraction can take a few seconds even on a healthy connection.
// 10 MB buffer cap accommodates Wikipedia's longer articles without
// the default 1 MB execFile cap truncating output.
async function fetchLive(url: string): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("node", [BUILT_JS, url], {
    timeout: 30_000,
    maxBuffer: 10_000_000,
  });
  return { stdout, stderr };
}

// ---------------------------------------------------------------------------
// Wikipedia — the canonical Reader-View target. Long article with a
// dense table-of-contents, multiple section headings, citations, and
// chrome (nav, sidebar, footer) that Readability must strip.
// ---------------------------------------------------------------------------

test(
  "live: en.wikipedia.org/wiki/Markup_language extracts title, sections, and strips chrome",
  { skip: !LIVE_E2E_ENABLED },
  async () => {
    const { stdout, stderr } = await fetchLive(
      "https://en.wikipedia.org/wiki/Markup_language",
    );

    assert.equal(stderr, "", "stderr must stay empty on a successful fetch");

    // The article's main title appears in the extracted markdown.
    // Match case-insensitively so future title-style tweaks (e.g., "Markup
    // language" vs "Markup Language") don't break the test.
    assert.match(
      stdout,
      /markup\s+language/i,
      "extracted markdown must mention the article title",
    );

    // Wikipedia articles always have a multi-section structure.
    // The exact section names change over time, but ≥3 H2 sections is a
    // safe floor for any article that isn't a stub.
    const h2Count = (stdout.match(/^## /gm) ?? []).length;
    assert.ok(
      h2Count >= 3,
      `expected ≥3 H2 sections in Wikipedia article markdown; got ${h2Count}`,
    );

    // Readability+turndown must strip Wikipedia's site chrome. If any of
    // these substrings appear in the body, extraction has regressed.
    assert.ok(
      !stdout.includes("<nav"),
      "nav chrome should be stripped, not passed through as raw HTML",
    );
    assert.ok(
      !stdout.includes("<script"),
      "script blocks must be stripped",
    );
    assert.ok(
      !stdout.includes("<style"),
      "style blocks must be stripped",
    );
    assert.ok(
      !stdout.includes('class="mw-'),
      "MediaWiki chrome classes should not survive into the markdown body",
    );

    // Sanity: a real Wikipedia article is substantial. A trivial extraction
    // (e.g., a single line) would be a regression signal.
    assert.ok(
      stdout.length > 5000,
      `extracted markdown should be substantial for a Wikipedia article; got ${stdout.length} chars`,
    );
  },
);

// ---------------------------------------------------------------------------
// Claude Code commands docs — a modern docs-site SPA with
// server-rendered HTML that Readability is expected to extract from.
// Smaller body than Wikipedia; different framework, different chrome
// shape, exercises the pipeline against a non-Wikipedia surface.
// ---------------------------------------------------------------------------

test(
  "live: code.claude.com/docs/en/commands extracts content as clean markdown",
  { skip: !LIVE_E2E_ENABLED },
  async () => {
    const { stdout, stderr } = await fetchLive(
      "https://code.claude.com/docs/en/commands",
    );

    assert.equal(stderr, "", "stderr must stay empty on a successful fetch");

    // The page is the slash-commands docs; the word "command" must appear
    // somewhere in the extracted body.
    assert.match(
      stdout,
      /command/i,
      "docs page about commands must mention 'command' somewhere",
    );

    // Non-trivial extraction floor. The page has at least a heading plus
    // a paragraph of intro, so 500 chars is a safe minimum.
    assert.ok(
      stdout.length > 500,
      `extracted markdown should be non-trivial; got ${stdout.length} chars`,
    );

    // Raw HTML chrome should not survive.
    assert.ok(
      !stdout.includes("<script"),
      "script blocks must be stripped",
    );
    assert.ok(
      !stdout.includes("<style"),
      "style blocks must be stripped",
    );

    // Should contain at least one markdown heading — docs pages always
    // have section structure.
    assert.match(
      stdout,
      /^#{1,3} /m,
      "extracted markdown should contain at least one heading",
    );
  },
);
