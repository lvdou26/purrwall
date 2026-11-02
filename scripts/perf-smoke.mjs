#!/usr/bin/env node
// Cold-start performance smoke — the regression gate for Purrwall's defining
// trait: charts appear NOW. Run before any deploy-worthy push that touches
// the data layer, chart lifecycle, or startup path:
//
//   npm run build && npm run perf
//
// Serves the freshly built dist/ via `vite preview`, opens it in headless
// Chrome with a FRESH profile (cold cache, default 3×3 wall), and measures
// DOM-observable truth: a cell counts as painted once its header shows a
// price (.cell-price non-empty — same signal a human trusts).
//
// Budgets (generous vs a typical ~0.75s first / ~1.4s all, so network jitter
// doesn't cry wolf, but a scheduler regression — multi-second queueing —
// fails loudly):
//   first chart ≤ 2500 ms · all 9 ≤ 6000 ms · zero console errors
//
// NOTE: one run costs ~9 candleSnapshot fetches against the real HL API.
// Back-to-back runs can 429 — wait a minute between attempts.
//
// PERF_HASH (optional): a share hash appended to the URL so a SPECIFIC wall
// runs through the same gates — the formula-cells gate is a 9-cell wall of
// NINE DIFFERENT 2-leg ratios, 18 DISTINCT legs (~18 leg fetches, twice the
// default wall's budget). Distinct matters: info.ts dedupes in-flight
// candleSnapshots by coin|interval|start, so nine copies of one ratio cost
// 2 fetches and the gate would pass without exercising anything. Real codec
// output for such a wall (every leg a live main-dex perp, no leg repeated):
//
//   PERF_HASH='#w=2;3x3;%3DHYPE%2FETH~1h;%3DBTC%2FSOL~1h;%3DDOGE%2FXRP~1h;%3DSUI%2FAVAX~1h;%3DLINK%2FARB~1h;%3DOP%2FBNB~1h;%3DADA%2FLTC~1h;%3DDOT%2FAAVE~1h;%3DNEAR%2FAPT~1h' npm run perf
//
// Must start with '#' and describe a wall with EXACTLY 9 placed cells (the
// budget below counts .cell-price paints up to 9). A fresh profile has no
// persisted wall, so the share is adopted outright. Unset = the default 3×3
// wall.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 4173;
const URL_ = `http://127.0.0.1:${PORT}/`;
// the wall under test (header): only the page navigation carries it — the
// readiness and version probes below hit the bare origin
const HASH = process.env.PERF_HASH ?? '';
if (HASH !== '' && !HASH.startsWith('#')) {
  console.error(`perf-smoke: PERF_HASH must start with '#' (got ${JSON.stringify(HASH)})`);
  process.exit(1);
}
const FIRST_MS = 2500;
const ALL_MS = 6000;
const EXPECT_CELLS = 9;

const CHROME =
  process.env.CHROME_PATH ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find(
    existsSync,
  );
if (!CHROME) {
  console.error('perf-smoke: no Chrome found — set CHROME_PATH');
  process.exit(1);
}

// --host 127.0.0.1 explicitly: plain `vite preview` can bind only ::1 on
// macOS, and this script (and Chrome) dials 127.0.0.1.
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: 'ignore',
});
const profile = mkdtempSync(join(tmpdir(), 'purrwall-perf-'));
let browser;
let serverDied = false;
server.on('exit', () => {
  serverDied = true;
});
const cleanup = () => {
  try {
    server.kill();
  } catch {
    /* already dead */
  }
  rmSync(profile, { recursive: true, force: true });
};
process.on('exit', cleanup);
// 'exit' does not fire on signal death — without these, Ctrl+C / CI SIGTERM
// orphans the vite preview child and 4173 stays occupied for every next run
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

// wait for the preview server
for (let i = 0; ; i++) {
  if (serverDied) {
    console.error('perf-smoke: vite preview exited early — port 4173 already in use?');
    process.exit(1);
  }
  try {
    const res = await fetch(URL_, { signal: AbortSignal.timeout(1000) });
    if (res.ok) break;
  } catch {
    /* not up yet */
  }
  if (i > 60) {
    console.error('perf-smoke: vite preview never came up');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 250));
}

// Identity check: we must be measuring OUR dist, not a zombie preview from
// an old checkout or a foreign server squatting the port.
const localVersion = JSON.parse(readFileSync(join(ROOT, 'dist/version.json'), 'utf8')).sha;
const servedVersion = await fetch(`${URL_}version.json`)
  .then((r) => r.json())
  .then((v) => v.sha)
  .catch(() => null);
if (servedVersion !== localVersion) {
  console.error(
    `perf-smoke: served build ${servedVersion} != local dist ${localVersion} — another server on ${PORT}?`,
  );
  process.exit(1);
}

try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: profile,
    args: ['--no-first-run', '--window-size=1920,1080'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  const errors = [];
  // One benign console-error source: Chrome logs every HTTP-429 resource
  // load as a console error even though info.ts retries transparently (a
  // 429'd chart that never recovers still fails the TIME budget). pageerror
  // stays unconditionally fatal.
  const benign = (t) => t.includes('api.hyperliquid.xyz');
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // resource-load failures carry the URL in location, not the text
    if (benign(msg.text()) || benign(msg.location()?.url ?? '')) return;
    errors.push(`${msg.text()} (${msg.location()?.url ?? 'no url'})`);
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  const t0 = Date.now();
  await page.goto(URL_ + HASH, { waitUntil: 'domcontentloaded', timeout: 15_000 });

  let firstMs = null;
  let allMs = null;
  while (Date.now() - t0 < 20_000) {
    const priced = await page.$$eval('.cell-price', (els) =>
      els.filter((el) => (el.textContent ?? '').trim().length > 0).length,
    );
    const now = Date.now() - t0;
    if (firstMs === null && priced >= 1) firstMs = now;
    if (priced >= EXPECT_CELLS) {
      allMs = now;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const fail = [];
  if (firstMs === null) fail.push('no chart ever painted (20s)');
  else if (firstMs > FIRST_MS) fail.push(`first chart ${firstMs}ms > ${FIRST_MS}ms`);
  if (allMs === null) fail.push(`never reached ${EXPECT_CELLS} charts (20s)`);
  else if (allMs > ALL_MS) fail.push(`all charts ${allMs}ms > ${ALL_MS}ms`);
  // real breakage (CSP violations, undefined, failed module) is what this
  // catches — benign() above already excused the known off-domain noise
  if (errors.length > 0) fail.push(`${errors.length} console error(s): ${errors[0]}`);

  console.log(
    `perf-smoke: first chart ${firstMs ?? '—'}ms · all ${EXPECT_CELLS} at ${allMs ?? '—'}ms · console errors ${errors.length}${HASH ? ` · wall ${HASH}` : ''}`,
  );
  if (fail.length > 0) {
    for (const f of fail) console.error(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    console.log('  ✓ within budget (2500ms first / 6000ms all / 0 errors)');
  }
} finally {
  await browser?.close();
  cleanup();
}
