// Purrwall worker: static assets serve the app (handled before this code
// runs); this script only backs the paths assets don't cover.
//   /api/sync          → opt-in wall-library sync via an 8-char pairing code
//                        (no accounts). The doc holds wall names, market
//                        symbols, the active watch address and the address
//                        book (≤20 addresses with optional names); 60-day
//                        idle TTL, refreshed on every write — see
//                        src/lib/sync.ts
//   /api/feedback      → a user's message, stored as { m, at } in its own KV
//                        namespace for 90 days and mailed to the maintainer
//                        (FEEDBACK_TO)
//   /api/sparks        → 24h trend-glyph blob for the list view: PUBLIC
//                        aggregate market data (closes per coin), pre-built
//                        hourly by the public purrwall-data repo's pipeline.
//                        Served edge-cached so every visitor's glyphs render
//                        instantly with zero client-side candle fetches.
//                        This is the one KV key that is NOT user state.
//   /api/sparks-ingest → the pipeline's token-gated write of that blob

// ── Abuse throttles: per-IP fixed windows held in isolate memory only — the
// IP never reaches storage. Per-isolate counting is deliberately imprecise
// (a heavy flood spawning fresh isolates gets fresh counters — accepted; the
// goal is bounding single-source damage, not precise quotas). Limits sit far
// above any real client's ceiling — sync CREATES happen once or twice per
// device EVER, sync PUTs once per debounced edit burst — so a legit user
// (even many behind one NAT) never hits them; and the client already treats
// 429 as transient (never flips the persistent ⚠ 'rejected' sync-health,
// src/lib/sync.ts). Scarce ops carry a second DAILY budget: a per-minute
// window alone still allows tens of thousands of KV writes per day from one
// polite IP, and every daily budget stays well under the account-wide KV
// write quota (1,000 a day on the Workers Free plan).
const RATE_WINDOW_MS = 60_000;
const RATE_DAY_MS = 24 * 3600_000;
const RATE_MAX_KEYS = 10_000; // memory bound for a long-lived isolate
const rateMap = new Map(); // `${bucket}:${ip}` -> { n, resetAt }

/** True = over budget, reject. Exported for tests, which also inject `now`. */
export function hitRateLimit(key, limit, now = Date.now(), windowMs = RATE_WINDOW_MS) {
  let e = rateMap.get(key);
  if (!e || now >= e.resetAt) {
    e = { n: 0, resetAt: now + windowMs };
    rateMap.delete(key); // re-insert young: eviction below stays LRU-ish
    rateMap.set(key, e);
    if (rateMap.size > RATE_MAX_KEYS) {
      const oldest = rateMap.keys().next().value;
      if (oldest !== undefined) rateMap.delete(oldest);
    }
  }
  return ++e.n > limit;
}

function throttled(req, bucket, limit, dayLimit) {
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const over = hitRateLimit(`${bucket}:${ip}`, limit);
  // check both even when the minute window already failed: a rejected
  // request still spends daily budget, so a sustained flood can't ride
  // the minute window's edge without ever touching the daily one
  const overDay =
    dayLimit !== undefined &&
    hitRateLimit(`${bucket}:d:${ip}`, dayLimit, Date.now(), RATE_DAY_MS);
  return over || overDay;
}

/** Browser-sent writes must come from our own pages. An ABSENT Origin passes
 *  (non-browser clients; this is defense-in-depth against hostile web pages
 *  driving visitors' browsers at us, not authentication — scripts can forge
 *  the header anyway). localhost passes so `wrangler dev` testing works.
 *  Exported for tests. */
export function originAllowed(origin) {
  if (!origin) return true;
  return (
    origin === 'https://purrwall.xyz' ||
    origin === 'https://www.purrwall.xyz' ||
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:')
  );
}

function badOrigin(req) {
  return !originAllowed(req.headers.get('origin'));
}

// A watch address's shape (the active one and every address-book entry),
// validated wherever one is stored (sync docs).
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// ── /api/sparks constants: one blob, overwritten hourly by the pipeline.
const SPARKS_KEY = 'sparks:v1';
const SPARKS_MAX_BODY = 512 * 1024;
// a dead pipeline 404s within a week — the list then renders without glyphs
const SPARKS_TTL_S = 7 * 24 * 3600;

const SYNC_TTL_S = 60 * 24 * 3600; // 60 days idle, refreshed on every write
// codes are base32 [A-Z2-7]{8} (32^8 ≈ 1.1e12 keyspace), matched in the route
const SYNC_MAX_BODY = 65536;
const SYNC_MAX_WALLS = 100;

/** Whitelist-copy a wall-library doc; null = malformed. Server sanitizes so
 *  one buggy/hostile client can't poison the doc every device merges from.
 *  Exported for tests. */
export function sanitizeSyncDoc(body) {
  if (!body || !Array.isArray(body.walls) || body.walls.length > SYNC_MAX_WALLS) return null;
  const walls = [];
  for (const w of body.walls) {
    if (typeof w?.name !== 'string' || w.name.length === 0 || w.name.length > 64) return null;
    const out = { name: w.name };
    // clamp stamps to [0, now]: a future timestamp (hostile 9e15, or a device
    // with a wrong clock) would win every merge forever, and a future-dated
    // tombstone never expires — permanently killing a wall name everywhere.
    const now = Date.now();
    const stamp = (t) => Math.min(Math.max(t, 0), now);
    if (Number.isFinite(w.updatedAt)) out.updatedAt = stamp(w.updatedAt);
    if (Number.isFinite(w.deletedAt)) out.deletedAt = stamp(w.deletedAt);
    if (!out.deletedAt) {
      if (!Number.isInteger(w.count) || w.count < 1 || w.count > 24) return null;
      out.count = w.count;
      if (Number.isInteger(w.cols) && w.cols >= 1 && w.cols <= 6) out.cols = w.cols;
      if (!Array.isArray(w.cells) || w.cells.length > 24) return null;
      // 96 = the client's canonical formula-id cap (src/lib/hl/formula.ts
      // MAX_ID_LEN): a 4-leg formula over 14-char HIP-3 ids measures ~70, and
      // a lower cap would null it on the paired device with no error. Length
      // only — the coin's charset stays the client's business.
      out.cells = w.cells.map((c) => ({
        coin: typeof c?.coin === 'string' && c.coin.length <= 96 ? c.coin : null,
        interval: typeof c?.interval === 'string' && c.interval.length <= 8 ? c.interval : '1h',
      }));
    }
    walls.push(out);
  }
  const doc = { v: 1, walls, updatedAt: Date.now() };
  // Watch state: a doc-level LWW unit — active address + address book, one
  // stamp. Meaningful only with a stamp, so a client that predates the watch
  // fields syncs untouched; malformed pieces are DROPPED (a bad address
  // leaves a clear-tombstone), never a reason to reject the doc. Book names
  // are user text and belong in this doc exactly like wall names.
  if (Number.isFinite(body.watchAddrAt)) {
    doc.watchAddrAt = Math.min(Math.max(body.watchAddrAt, 0), Date.now());
    if (typeof body.watchAddr === 'string' && ADDR_RE.test(body.watchAddr)) {
      doc.watchAddr = body.watchAddr.toLowerCase();
    }
    if (Array.isArray(body.watchBook)) {
      const book = [];
      for (const e of body.watchBook) {
        if (book.length >= 20) break;
        if (typeof e?.a !== 'string' || !ADDR_RE.test(e.a)) continue;
        const a = e.a.toLowerCase();
        if (book.some((x) => x.a === a)) continue;
        const entry = { a };
        if (typeof e.n === 'string' && e.n.length > 0) entry.n = e.n.slice(0, 32);
        book.push(entry);
      }
      // an explicit [] is a real state ("removed them all") and must be
      // stored as such — absence of the FIELD is what marks a client that
      // predates the address book
      doc.watchBook = book;
    }
  }
  return doc;
}

/** Feedback: a deliberate, user-initiated submission. The stored record is
 *  { m, at } — the trimmed text and the server time — and nothing else
 *  (routes.test.js pins the key set).
 *
 *  90 days, not 60-day-idle like sync: a bug report is worth reading for a
 *  release cycle or two, and after that it is only accumulating risk. Free text
 *  is unbounded by construction — people paste whatever they like — so the
 *  store expires on its own rather than growing forever.
 */
const FEEDBACK_TTL_S = 90 * 24 * 3600;
const FEEDBACK_MAX_BODY = 4096;
const FEEDBACK_MAX_TEXT = 2000;

/** Returns the trimmed message, or null if the body is unusable. Exported for
 *  tests — the clamp is the whole contract, so it is pinned like sanitizeSyncDoc. */
export function sanitizeFeedback(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const msg = typeof raw.m === 'string' ? raw.m.trim() : '';
  // An empty submit is a mis-click, not feedback. The upper bound is enforced
  // by slicing rather than rejecting: a user who wrote a long report should
  // not lose it to a 400 they cannot act on.
  if (msg.length === 0) return null;
  return { m: msg.slice(0, FEEDBACK_MAX_TEXT), at: Date.now() };
}

/** Feedback notification: the message reaches the maintainer's inbox
 *  (FEEDBACK_TO) the moment it is sent, instead of waiting for someone to run
 *  `npm run feedback`, which stays as the archive.
 *
 *  The mail carries exactly what KV holds ({ m, at } plus the record's key):
 *  a notification is a delivery route, never a reason for a richer record.
 *
 *  Two properties are load-bearing and neither is obvious:
 *  - The binding is destination-LOCKED (`destination_address` in
 *    wrangler.jsonc), so this worker cannot mail any other address even if
 *    the code below is wrong. An unauthenticated endpoint that composes email
 *    is a spam relay one bug away; this makes that bug unreachable.
 *  - User text never reaches a header as raw bytes. The subject snippet goes
 *    through RFC 2047 base64 encoded-words and the body through base64, so a
 *    CR/LF someone types becomes payload rather than a forged header — and
 *    Chinese feedback survives transport instead of arriving as mojibake.
 */
const MAIL_FROM = 'feedback@purrwall.xyz'; // any address on the routed zone
// Above the real ceiling (a handful of messages a day), below what makes a
// mailbox unusable. Per-ISOLATE like the throttles above, with the same
// accepted imprecision: the goal is bounding one source's damage. Feedback
// past the cap still lands in KV — only the notification is dropped.
const MAIL_DAY_MAX = 50;

/** UTF-8 → base64. btoa is byte-wise, so a Chinese string must be encoded
 *  first or it throws. */
function b64(s) {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** RFC 2047 encoded-words for a header value. Base64 per chunk is what makes
 *  this injection-proof. Chunks split on CODE POINTS so a multi-byte character
 *  never straddles two words (which decodes to mojibake); 30 bytes → 40 base64
 *  chars keeps each word inside RFC 2047's 75-char limit. */
function encodeHeader(s) {
  const enc = new TextEncoder();
  const words = [];
  let chunk = '';
  for (const ch of s) {
    if (enc.encode(chunk + ch).length > 30) {
      words.push(`=?utf-8?B?${b64(chunk)}?=`);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(`=?utf-8?B?${b64(chunk)}?=`);
  return words.join('\r\n '); // folded: adjacent encoded-words drop the gap
}

const SUBJECT_CHARS = 80; // enough to triage from a phone notification

/** Build the notification as raw RFC 5322. Exported because this — not the
 *  send call — is where the injection safety lives, so it is what the tests
 *  pin. `key` is the KV key, carried so a mail can be traced back to (or
 *  deleted from) the store. */
export function feedbackMime(doc, key, to) {
  const flat = doc.m.replace(/\s+/g, ' ').trim();
  const subject = `Purrwall: ${flat.length > SUBJECT_CHARS ? `${flat.slice(0, SUBJECT_CHARS)}…` : flat}`;
  const when = new Date(doc.at).toISOString().replace('T', ' ').slice(0, 16);
  const body = b64(`${doc.m}\n\n--\n${when} UTC · ${key}\n`).replace(/(.{76})/g, '$1\r\n');
  return [
    `From: Purrwall <${MAIL_FROM}>`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: <${key.replace(/[^a-z0-9]/gi, '-')}@purrwall.xyz>`,
    `Date: ${new Date(doc.at).toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

async function mailFeedback(env, doc, key) {
  // Dynamic import: worker/*.test.js loads this module under plain Node, where
  // the cloudflare: built-ins do not resolve. The binding guard at the call
  // site means this line only runs on a real deploy.
  const { EmailMessage } = await import('cloudflare:email');
  await env.MAIL.send(
    new EmailMessage(MAIL_FROM, env.FEEDBACK_TO, feedbackMime(doc, key, env.FEEDBACK_TO)),
  );
}

async function readSyncBody(req) {
  const text = await req.text();
  if (text.length > SYNC_MAX_BODY) return null;
  try {
    return sanitizeSyncDoc(JSON.parse(text));
  } catch {
    return null;
  }
}

function syncCode() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => alphabet[b % 32]).join('');
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // Trend-glyph blob: KV read behind the edge cache — hourly data with a
    // 5-min cache is fresh enough, and viewers never become KV load.
    // CORS * : public aggregate data; dev servers fetch it cross-origin.
    if (url.pathname === '/api/sparks' && req.method === 'GET') {
      const cache = caches.default;
      const hit = await cache.match(req);
      if (hit) return hit;
      const blob = await env.SPARKS?.get(SPARKS_KEY);
      if (!blob) return new Response('not found', { status: 404 });
      const res = new Response(blob, {
        headers: {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=300',
        },
      });
      ctx.waitUntil(cache.put(req, res.clone()));
      return res;
    }
    if (url.pathname === '/api/sparks-ingest' && req.method === 'POST') {
      // wrong/missing token reads as 404 — the endpoint stays invisible
      const auth = req.headers.get('authorization') ?? '';
      if (!env.SPARKS_TOKEN || auth !== `Bearer ${env.SPARKS_TOKEN}`) {
        return new Response('not found', { status: 404 });
      }
      const text = await req.text();
      if (text.length > SPARKS_MAX_BODY) return new Response('too large', { status: 413 });
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return new Response('bad request', { status: 400 });
      }
      // whole-shape validation: coin → short numeric array, nothing else —
      // this blob is served verbatim to every visitor, so nothing
      // free-form may pass (same stance as sanitizeSyncDoc)
      if (body?.v !== 1 || typeof body.points !== 'object' || body.points === null) {
        return new Response('bad request', { status: 400 });
      }
      const entries = Object.entries(body.points);
      if (entries.length === 0 || entries.length > 2000) {
        return new Response('bad request', { status: 400 });
      }
      for (const [coin, closes] of entries) {
        if (
          coin.length === 0 ||
          coin.length > 64 ||
          !Array.isArray(closes) ||
          closes.length < 2 ||
          closes.length > 26 ||
          !closes.every(Number.isFinite)
        ) {
          return new Response('bad request', { status: 400 });
        }
      }
      await env.SPARKS.put(
        SPARKS_KEY,
        JSON.stringify({ v: 1, t: Date.now(), points: body.points }),
        { expirationTtl: SPARKS_TTL_S },
      );
      return new Response(null, { status: 204 });
    }

    // Wall sync: POST creates a code for the uploaded library; GET reads a
    // library; PUT upserts (upsert lets a surviving device revive an
    // idle-expired code — the doc self-heals as long as anyone still pairs).
    // Hardening: origin-checked writes + per-IP throttles. CREATES are the
    // scarce op — each mints a 60-day KV doc, and a real device creates once
    // or twice EVER, so the budget is 6/min + 30/day and PUT-to-a-missing-code
    // shares it (the upsert path is otherwise an ungated creation channel at
    // the update budget). 429 is safe for the client, which treats it as
    // transient and never flips the persistent ⚠ health.
    if (url.pathname === '/api/sync' && req.method === 'POST') {
      if (badOrigin(req)) return new Response('forbidden', { status: 403 });
      if (throttled(req, 'sync-create', 6, 30)) return new Response('slow down', { status: 429 });
      const doc = await readSyncBody(req);
      if (!doc) return new Response('bad request', { status: 400 });
      const code = syncCode();
      await env.SYNC.put(`sync:${code}`, JSON.stringify(doc), { expirationTtl: SYNC_TTL_S });
      return Response.json({ code });
    }
    const syncMatch = url.pathname.match(/^\/api\/sync\/([A-Z2-7]{8})$/);
    if (syncMatch && req.method === 'GET') {
      if (throttled(req, 'sync-get', 240)) return new Response('slow down', { status: 429 });
      const doc = await env.SYNC.get(`sync:${syncMatch[1]}`);
      return doc
        ? new Response(doc, { headers: { 'content-type': 'application/json' } })
        : new Response('not found', { status: 404 });
    }
    if (syncMatch && req.method === 'PUT') {
      if (badOrigin(req)) return new Response('forbidden', { status: 403 });
      if (throttled(req, 'sync-put', 60, 200)) return new Response('slow down', { status: 429 });
      // The existence probe costs one KV read per PUT (cheap; reads are not
      // the scarce resource) and routes revive-a-dead-code through the
      // create budget where it belongs.
      const existing = await env.SYNC.get(`sync:${syncMatch[1]}`);
      if (existing === null && throttled(req, 'sync-create', 6, 30)) {
        return new Response('slow down', { status: 429 });
      }
      const doc = await readSyncBody(req);
      if (!doc) return new Response('bad request', { status: 400 });
      // Carry the watch fields forward when the PUT body has no stamp at all —
      // a client that predates the watch fields (an open tab can run an old
      // build for weeks: the app never reloads itself) PUTs {v, walls} on
      // every wall edit, and since sanitizeSyncDoc rebuilds the doc from the
      // body alone, that would silently erase the watch state every paired
      // device merges from. A body WITH a stamp always wins — including a
      // bare clear (stamp, no address).
      if (existing !== null) {
        try {
          const prev = JSON.parse(existing);
          if (doc.watchAddrAt === undefined && Number.isFinite(prev?.watchAddrAt)) {
            // pre-WATCH client (no stamp at all): carry the whole unit
            doc.watchAddrAt = prev.watchAddrAt;
            if (typeof prev.watchAddr === 'string' && ADDR_RE.test(prev.watchAddr)) {
              doc.watchAddr = prev.watchAddr;
            }
            if (Array.isArray(prev.watchBook)) doc.watchBook = prev.watchBook;
          } else if (
            doc.watchAddrAt !== undefined &&
            doc.watchBook === undefined &&
            Array.isArray(prev?.watchBook)
          ) {
            // pre-BOOK client (stamps the unit but sends no book field):
            // keep the stored book — current clients always send watchBook
            // when stamped, an explicit [] included, so a MISSING field can
            // only mean the client predates the address book.
            doc.watchBook = prev.watchBook;
          }
        } catch {
          /* stored doc unreadable — nothing to carry */
        }
      }
      await env.SYNC.put(`sync:${syncMatch[1]}`, JSON.stringify(doc), {
        expirationTtl: SYNC_TTL_S,
      });
      return new Response(null, { status: 204 });
    }

    // Feedback: same unauthenticated-write shape as /api/sync POST — Origin
    // check, then throttle, then read+sanitize, then write. The budget is the
    // SCARCE tier (create-shaped, not update-shaped): a real person sends
    // feedback a handful of times ever, so 3/min and 20/day per IP sit far
    // above genuine use and far below anything worth flooding a KV store with.
    // 429 is honest here — the client surfaces "try again in a moment" rather
    // than pretending the message was sent.
    if (url.pathname === '/api/feedback' && req.method === 'POST') {
      if (badOrigin(req)) return new Response('forbidden', { status: 403 });
      if (throttled(req, 'feedback', 3, 20)) return new Response('slow down', { status: 429 });
      const text = await req.text();
      if (text.length > FEEDBACK_MAX_BODY) return new Response('too large', { status: 413 });
      let doc = null;
      try {
        doc = sanitizeFeedback(JSON.parse(text));
      } catch {
        /* malformed JSON falls through to the 400 below */
      }
      if (!doc) return new Response('bad request', { status: 400 });
      // Key is time-ordered plus randomness: readable in order, collision-free
      // under concurrent submits, and derived from nothing in the request.
      const rand = [...crypto.getRandomValues(new Uint8Array(6))]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const key = `fb:${doc.at}:${rand}`;
      await env.FEEDBACK.put(key, JSON.stringify(doc), {
        expirationTtl: FEEDBACK_TTL_S,
      });
      // Notify AFTER the write and outside the response: KV is the source of
      // truth, so the user's 204 never waits on SMTP and a mail failure never
      // costs a message. If mail breaks silently, `npm run feedback` still has
      // everything — the degradation is quiet by design, not by accident.
      // The address is validated as a single-line address because it lands in
      // a To: header; a mis-set var must not be able to forge one.
      if (
        env.MAIL &&
        /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(env.FEEDBACK_TO ?? '') &&
        !hitRateLimit('mail:day', MAIL_DAY_MAX, Date.now(), RATE_DAY_MS)
      ) {
        ctx.waitUntil(
          mailFeedback(env, doc, key).catch((err) =>
            console.error('feedback mail failed:', err?.message ?? err),
          ),
        );
      }
      return new Response(null, { status: 204 });
    }

    return new Response('not found', { status: 404 });
  },
};
