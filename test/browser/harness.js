import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { chromium } from "playwright";

// The page declares an import map for the bare specifiers a bundler would
// resolve, so the browser can. Its hash is what lets it run under a policy
// that otherwise forbids inline script, and it is read out of the page rather
// than restated here so the two cannot disagree.
const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
const importMap = html.match(/<script type="importmap">([^<]+)<\/script>/)?.[1];
assert.ok(importMap, "index.html declares no import map for the harness to hash");
const hash = createHash("sha256").update(importMap).digest("base64");

const CSP = [
  "default-src 'none'",
  `script-src 'self' 'sha256-${hash}'`,
  "connect-src 'none'",
  "img-src 'none'",
  "style-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

// Every module this server hands to the page, and where each one's bytes come
// from. A dependency is resolved through its exports map rather than a
// hardcoded path, so this keeps working whichever directory it publishes its
// entry from; the served URL stays fixed, so the import map — and the CSP hash
// over it — are unaffected.
const sources = new Map([
  ["/lib/index.js", new URL("../../lib/index.js", import.meta.url)],
  ["/modules/waarmerk.js", new URL(import.meta.resolve("waarmerk"))],
]);

const files = new Map([
  ["/", ["text/html; charset=utf-8", html]],
  [
    "/browser.js",
    ["text/javascript; charset=utf-8", await readFile(new URL("./browser.js", import.meta.url))],
  ],
  ...(await Promise.all(
    [...sources].map(async ([path, source]) => [
      path,
      ["text/javascript; charset=utf-8", await readFile(source)],
    ]),
  )),
]);

const server = http.createServer((request, response) => {
  const file = files.get(new URL(request.url, "http://localhost").pathname);
  if (!file) {
    response.writeHead(404).end("Not found");
    return;
  }
  response
    .writeHead(200, {
      "Content-Type": file[0],
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
    })
    .end(file[1]);
});

let browser;
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  browser = await chromium.launch();
  const page = await browser.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  // The bytes a browser gets are the bytes that ship. This suite exists to
  // prove the published files run under a strict CSP, and a rewritten copy
  // would prove it of something nobody installs — so nothing may transform a
  // served module on the way out, dependencies included, and this fails if
  // anything starts to.
  for (const [path, source] of sources) {
    const served = await fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.text());
    assert.equal(served, await readFile(source, "utf8"), `${path} is served rewritten`);
  }

  await page.goto(`http://127.0.0.1:${port}`);
  const done = page.locator('#result[data-status="passed"], #result[data-status="failed"]');
  await done.waitFor({ timeout: 10_000 });
  const status = await done.getAttribute("data-status");
  const message = await done.textContent();

  assert.equal(status, "passed", message);
  assert.deepEqual(browserErrors, []);
  console.log("Browser CSP test passed");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
