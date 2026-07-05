// Pure pipeline + error types. Imported by both adapters (mcp.ts and cli.ts).
// Invariants:
//   - This module MUST NOT write to stdout or stderr. The MCP adapter relies on
//     stdout staying empty (any non-JSON-RPC byte corrupts the protocol frame);
//     the CLI adapter owns its own output channel. Errors are thrown, never
//     printed.
//   - This module MUST NOT import from @modelcontextprotocol/sdk or commander.
//     Keeping core transport-agnostic is what lets the dispatcher in index.ts
//     lazy-load only the adapter that's actually needed.

import { fetch, Agent, setGlobalDispatcher } from "undici";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
// @ts-expect-error turndown-plugin-gfm ships no type definitions
import { gfm } from "turndown-plugin-gfm";
import { writeFile } from "node:fs/promises";

// --- Module-level state ---

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Validate env values up front so misconfiguration fails loudly at startup
// instead of silently turning into a confusing per-request error
// (e.g., AbortSignal.timeout(NaN) → RangeError → mislabeled [network_error]).
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(
      `Invalid ${name}=${JSON.stringify(raw)} — expected a positive integer.`,
    );
  }
  return n;
}

const config = {
  timeoutMs: intEnv("MARKFETCH_TIMEOUT_MS", 30_000),
  maxBytes: intEnv("MARKFETCH_MAX_BYTES", 5_000_000),
  userAgent: process.env.MARKFETCH_USER_AGENT || DEFAULT_USER_AGENT,
};

// Derive Sec-CH-UA-* client hints from the User-Agent. A Chrome UA paired
// with mismatched (or absent) client hints is a stronger bot signal than a
// curl UA — the two MUST agree. Deriving from a single source makes that
// invariant mechanical: override the UA, the hints follow.
function deriveClientHints(ua: string): {
  brands: string;
  mobile: string;
  platform: string;
} {
  const versionMatch = /\bChrome\/(\d+)/.exec(ua);
  if (!versionMatch) {
    throw new Error(
      `Invalid MARKFETCH_USER_AGENT=${JSON.stringify(ua)} — expected a Chrome User-Agent containing "Chrome/<version>". Sec-CH-UA-* client hints are derived from this string and would be incoherent otherwise.`,
    );
  }
  const major = versionMatch[1];
  // Chrome's GREASE rotation changes BOTH the decoy brand token AND its
  // version per major: Chrome 130 ships "Not?A_Brand";v="99", Chrome 131
  // ships "Not_A Brand";v="24". We hard-code the Chrome-130 values; if a
  // caller overrides MARKFETCH_USER_AGENT to a different Chrome major, the
  // decoy shape will be stale. That is acceptable because bot detectors
  // don't fingerprint the decoy itself — only the real brand pair.
  const brands = `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="99"`;
  // Chrome's mobile UAs include a literal " Mobile " token; tablets/desktop omit it.
  const mobile = /\bMobile\b/.test(ua) ? "?1" : "?0";
  // Order matters: Android UAs contain "Linux" too, so check Android before the
  // generic Linux/X11 branch. iOS Chrome (CriOS) is intentionally unsupported —
  // Apple's WebKit doesn't implement Sec-CH-UA, so a coherent fingerprint
  // isn't achievable there.
  let platform: string;
  if (/Macintosh|Mac OS X/.test(ua)) platform = '"macOS"';
  else if (/Windows NT/.test(ua)) platform = '"Windows"';
  else if (/Android/.test(ua)) platform = '"Android"';
  else if (/CrOS/.test(ua)) platform = '"Chrome OS"';
  else if (/X11|Linux/.test(ua)) platform = '"Linux"';
  else
    throw new Error(
      `Invalid MARKFETCH_USER_AGENT=${JSON.stringify(ua)} — could not infer platform. Recognized markers: Macintosh, Windows NT, Android, CrOS, Linux/X11.`,
    );
  return { brands, mobile, platform };
}

const clientHints = deriveClientHints(config.userAgent);

// Force HTTP/1.1 (undici's default, pinned here so it isn't silently switched
// to h2). HTTP/2 buys nothing for single-shot GETs — no multiplexing to exploit,
// negligible header compression — and undici's h2 path hands a pre-connected
// socket to node:http2, whose first-flight frame pattern some CDNs (Cloudflare,
// observed on openai.com) score as a bot and answer with 403 even against a
// valid Chrome header set. HTTP/1.1 sidesteps that, and every h2 server also
// speaks it, so nothing is lost.
setGlobalDispatcher(new Agent({ allowH2: false }));

const TURNDOWN = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

// turndown ships no <table> rule by default; gfm adds tables, strikethrough,
// and task list items.
TURNDOWN.use(gfm);

// turndown's escape() over-fires on two patterns that aren't structurally
// significant in CommonMark:
//
//   - intraword underscores: `list_tools` → `list\_tools`. CommonMark §6.2
//     left-flanking-delimiter rules already prevent `_` flanked by
//     alphanumerics from opening emphasis; the escape is pure noise.
//
//   - hyphens and equals signs at *text-node* start: `<a>foo</a>-based`
//     → `[foo](...)\-based`. Turndown's `^-` and `^=` patterns anchor to
//     the start of each text node, not start-of-line. After inline
//     elements, the next text node often begins with `-suffix` / `=value`,
//     and gets escaped even though it sits mid-line in the rendered
//     markdown. CommonMark setext underlines are `=` or `-` characters on
//     a line by themselves; unordered-list markers require `-`/`+`/`*`
//     followed by whitespace or end-of-line. `\-X` / `\=X` where X is
//     alphanumeric cannot match either rule, so the escape is pure noise.
//
// Drop both. The negative lookbehind `(?<!\\)` on the second replace
// protects literal-backslash content: source HTML containing `\-X`
// passes through turndown's `\\` rule as `\\-X` (doubled backslash for
// the literal); without the lookbehind we'd strip the second backslash
// and silently destroy the literal-backslash signal. Keep every other
// default (brackets, asterisks, true line-leading list/heading markers).
const turndownDefaultEscape = TurndownService.prototype.escape.bind(TURNDOWN);
TURNDOWN.escape = (s: string): string =>
  turndownDefaultEscape(s)
    .replaceAll(String.raw`\_`, "_")
    .replaceAll(/(?<!\\)\\([-=])([A-Za-z0-9])/g, "$1$2");

// Sphinx-style code samples (Python docs <pre><span class="gp">>>></span>…)
// and many tech blogs use bare <pre> without nested <code>. Turndown's
// default fenced-code rule only fires on <pre><code>; bare <pre> falls
// through to general block handling and emits the text as escaped prose
// (`\>\>\>`, `\$`, etc.). Use textContent directly so source code stays raw.
TURNDOWN.addRule("barePre", {
  filter: (node) => node.nodeName === "PRE" && !node.querySelector("code"),
  replacement: (_content, node) => {
    const text = (node.textContent ?? "").replace(/\n+$/, "");
    return "\n\n```\n" + text + "\n```\n\n";
  },
});

// --- Errors ---

export type ErrorCode =
  | "network_error"
  | "http_error"
  | "timeout"
  | "unsupported_content_type"
  | "extraction_failed"
  | "too_large"
  | "save_failed"
  | "save_forbidden";

export class MarkfetchError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MarkfetchError";
  }
}

export function classifyError(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof MarkfetchError) {
    return { code: err.code, message: err.message };
  }
  // AbortSignal.timeout normally produces a DOMException named "TimeoutError";
  // some undici code paths surface AbortError instead, so accept both.
  if (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  ) {
    return {
      code: "timeout",
      message: `exceeded MARKFETCH_TIMEOUT_MS (${config.timeoutMs}ms)`,
    };
  }
  // undici.fetch wraps DNS/TCP/TLS errors as TypeError with .cause carrying
  // the underlying Node error code (ENOTFOUND, ECONNREFUSED, etc.). Narrow
  // to TypeError so a programming bug elsewhere doesn't get misclassified.
  if (err instanceof TypeError) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const causeCode = cause?.code ?? "unknown";
    return {
      code: "network_error",
      message: `${causeCode}: ${cause?.message ?? err.message}`,
    };
  }
  // Anything else is an unexpected error from our own code; bucket as
  // network_error for the [code]-prefix contract but include the type so
  // the operator can spot it in stderr.
  if (err instanceof Error) {
    return {
      code: "network_error",
      message: `unexpected ${err.name}: ${err.message}`,
    };
  }
  return { code: "network_error", message: String(err) };
}

// --- Pipeline ---

function chromeHeaders(): Record<string, string> {
  return {
    "User-Agent": config.userAgent,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    // Always-on. Real browsers omit this header when there's no user
    // activation; we model a "user clicked a link" navigation, consistent
    // with `Sec-Fetch-Site: "none"` above.
    "Sec-Fetch-User": "?1",
    "Sec-CH-UA": clientHints.brands,
    "Sec-CH-UA-Mobile": clientHints.mobile,
    "Sec-CH-UA-Platform": clientHints.platform,
    "Upgrade-Insecure-Requests": "1",
  };
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(config.timeoutMs),
    headers: chromeHeaders(),
  });

  if (!response.ok) {
    throw new MarkfetchError(
      "http_error",
      `HTTP ${response.status} for ${response.url}`,
    );
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (
    !contentType.startsWith("text/html") &&
    !contentType.startsWith("application/xhtml+xml")
  ) {
    throw new MarkfetchError(
      "unsupported_content_type",
      `Content-Type: ${contentType || "(missing)"}`,
    );
  }

  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > 0 && declaredLength > config.maxBytes) {
    throw enforceTooLarge("Content-Length", declaredLength);
  }

  const html = await response.text();
  if (Buffer.byteLength(html, "utf8") > config.maxBytes) {
    throw enforceTooLarge("Body", Buffer.byteLength(html, "utf8"));
  }

  return html;
}

function enforceTooLarge(stage: string, actual: number): MarkfetchError {
  return new MarkfetchError(
    "too_large",
    `${stage} ${actual} bytes > MARKFETCH_MAX_BYTES (${config.maxBytes})`,
  );
}

// Some CMSes (Webflow blogs, observed on merge.dev) entity-encode inline code
// samples in their source HTML — `&lt;code class="..."&gt;text&lt;/code&gt;`
// rather than real `<code>` elements. Decode those specific tag patterns so
// turndown processes them as real elements and converts to backticks.
// Pattern accepts `<code>`, `<code class="...">`, `</code>`, `<pre>` etc., but
// rejects `<codename>`, `<preview>`, `<codeblock>` — the next char after
// `code`/`pre` must be whitespace, `/`, or `&` (the start of `&gt;`), so
// element names with extra characters are not matched.
function decodeEncodedCodeTags(html: string): string {
  return html.replaceAll(
    /&lt;(\/?(?:code|pre)(?:\s[^&]*?)?\/?)&gt;/g,
    (_, tag) => `<${tag}>`,
  );
}

// Readability absolutizes relative hrefs/srcs via document.baseURI. linkedom
// leaves baseURI empty unless the document has a <base href>, so links and
// images come out as `/wiki/...` instead of `https://en.wikipedia.org/...`.
// Inject the post-redirect canonical URL undici returned, replacing any
// existing <base> the page declares (the upstream URL is more authoritative).
function ensureBaseHref(html: string, url: string): string {
  const safeUrl = url.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  const stripped = html.replaceAll(/<base\s[^>]*>/gi, "");
  if (/<head\b[^>]*>/i.test(stripped)) {
    return stripped.replace(
      /<head\b([^>]*)>/i,
      `<head$1><base href="${safeUrl}">`,
    );
  }
  if (/<html\b[^>]*>/i.test(stripped)) {
    return stripped.replace(
      /<html\b([^>]*)>/i,
      `<html$1><head><base href="${safeUrl}"></head>`,
    );
  }
  return `<base href="${safeUrl}">${stripped}`;
}

// Pre-Readability DOM normalization for site-specific patterns whose generic
// heuristics in @mozilla/readability mishandle:
//   - <aside class="footnote*"> — Readability hard-strips all <aside> in
//     _prepArticle, dropping Python docs / W3C-style footnote bodies.
//   - <details> — long-form articles gate appendices/FAQs in collapsibles
//     that score below threshold.
//   - <div class="mw-heading"> — MediaWiki 1.39+ wraps headings; Readability
//     either prunes the wrapper or emits the heading inside a <p>.
// Conservative scope — extend only in response to observed defects.
function rewriteForReadability(document: Document): void {
  const footnoteAsides = document.querySelectorAll(
    "aside.footnote, aside.footnote-list, aside.footnote-brackets, " +
      'aside[role="doc-endnotes"], aside[role="doc-footnote"], aside[role="doc-footnotes"]',
  );
  for (const el of Array.from(footnoteAsides)) {
    const section = document.createElement("section");
    while (el.firstChild) section.appendChild(el.firstChild);
    el.parentNode?.replaceChild(section, el);
  }
  for (const el of Array.from(document.querySelectorAll("details"))) {
    const parent = el.parentNode;
    if (!parent) continue;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    el.remove();
  }
  for (const el of Array.from(document.querySelectorAll("div.mw-heading"))) {
    const heading = el.querySelector("h1, h2, h3, h4, h5, h6");
    if (!heading) continue;
    el.parentNode?.replaceChild(heading, el);
  }
}

function extractArticle(
  html: string,
  url: string,
): { title: string; content: string } | null {
  const decoded = decodeEncodedCodeTags(html);
  const withBase = ensureBaseHref(decoded, url);
  const { document } = parseHTML(withBase);
  rewriteForReadability(document);
  // keepClasses: true preserves `class="language-X"` on <code> elements so
  // turndown's default fenced-code rule can emit the language hint after the
  // opening fence. Default Readability strips all classes except "page".
  // Other class attributes that survive (`headerlink`, etc.) are already
  // handled by our pre-Readability rewrites or are inert in turndown's
  // output, so this flag is safe in the observed corpus.
  const article = new Readability(document, {
    keepClasses: true,
  }).parse();
  if (!article?.content?.trim()) return null;
  return { title: (article.title ?? "").trim(), content: article.content };
}

function convertToMarkdown(article: {
  title: string;
  content: string;
}): string {
  const body = TURNDOWN.turndown(article.content);
  // If Readability kept the page's own <h1> at the top of the content, don't
  // prepend the title separately — that would emit two H1s for the same page.
  const contentLeadsWithH1 = /^\s*<h1[\s>]/i.test(article.content);
  let result = article.title && !contentLeadsWithH1
    ? `# ${article.title}\n\n${body}`
    : body;
  // Prune empty headings: a heading immediately followed by another heading
  // (only whitespace between) has no body. Common when Readability strips
  // an interactive widget (MDN browser-compat tables, MCP spec diagrams,
  // etc.) but leaves the orphan heading. Iterate until stable so a parent
  // section that becomes empty after its last child heading is pruned also
  // gets removed.
  let prev: string;
  do {
    prev = result;
    result = result.replaceAll(/^(#{1,6}) [^\n]+\s*(?=#{1,6} )/gm, "");
  } while (result !== prev);
  // The lookahead-based iteration above can't catch a trailing empty
  // heading at EOF (no following heading to anchor on). One-shot pass.
  result = result.replace(/(?:^|\n)#{1,6} [^\n]+\s*$/, "");
  return result;
}

// --- Unified entry point ---

// Adapters call this with already-validated inputs (URL syntax checked by the
// adapter's schema; savePath, if present, is an absolute path — adapters
// resolve any relative-vs-absolute concerns before calling).
//
// Errors are thrown uniformly as MarkfetchError. Adapters catch and translate:
//   - mcp.ts catches → errorResult(code, message) → MCP {isError, content}
//   - cli.ts catches → console.error("[code] message") → sets process.exitCode = 1
//
// The full set of error codes this can throw:
//   network_error, http_error, timeout, unsupported_content_type,
//   extraction_failed, too_large, save_failed
// (The first three may also come from underlying APIs and be translated by
// classifyError — adapters MUST run classifyError(err) in their catch blocks.)
// Note: the MCP adapter additionally emits save_forbidden (the 8th code in
// the contract) before fetchMarkdown is invoked — this function never throws
// it. See src/sandbox.ts and src/mcp.ts.
export async function fetchMarkdown(input: {
  url: string;
  savePath?: string;
}): Promise<{ markdown: string; bytes: number; savedTo?: string }> {
  const { url, savePath } = input;
  const html = await fetchHtml(url);
  const article = extractArticle(html, url);
  if (!article) {
    throw new MarkfetchError(
      "extraction_failed",
      "Readability returned no article content.",
    );
  }
  const markdown = convertToMarkdown(article);
  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes > config.maxBytes) {
    throw new MarkfetchError(
      "too_large",
      `Markdown ${bytes} bytes > MARKFETCH_MAX_BYTES (${config.maxBytes})`,
    );
  }
  // The file at savePath is only ever the markdown of the URL. Fetch /
  // extraction / size-cap failures all throw above and never reach this
  // branch, so the file is never written for them. save_failed is its own
  // phase, handled here.
  if (savePath !== undefined) {
    try {
      await writeFile(savePath, markdown, "utf8");
    } catch (err) {
      // Node's fs errors prefix the message with the errno already
      // (e.g. "ENOENT: no such file or directory, open '/path'"), so
      // pass it through. Distinct shape from undici's TypeError.cause,
      // which is why classifyError's `${code}: ${message}` doesn't fit.
      const e = err as NodeJS.ErrnoException;
      throw new MarkfetchError(
        "save_failed",
        e.message || (e.code ?? "unknown error"),
      );
    }
    return { markdown, bytes, savedTo: savePath };
  }
  return { markdown, bytes };
}
