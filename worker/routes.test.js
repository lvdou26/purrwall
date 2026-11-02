import { describe, expect, it, vi } from 'vitest';
import worker from './index.js';

// Route-level pins for the write hardening (Origin gate + per-IP throttles):
// these tests call the real fetch handler, so deleting a badOrigin() or
// throttled() call — or loosening a budget — fails a test (helper semantics
// live in hardening.test.js). The throttle map is module-global: every test
// uses its own IP.

const CTX = { waitUntil() {} };
let ipSeq = 0;
const ip = () => `10.0.${Math.floor(ipSeq / 250)}.${ipSeq++ % 250}`;

const makeEnv = () => ({
  SYNC: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
  FEEDBACK: { put: vi.fn(async () => {}) },
});

const VALID_DOC = JSON.stringify({
  walls: [{ name: 'w', count: 1, cells: [{ coin: 'BTC', interval: '1h' }], updatedAt: 1 }],
});

const syncReq = (method, path, clientIp, origin) =>
  new Request(`https://purrwall.xyz${path}`, {
    method,
    body: method === 'GET' ? undefined : VALID_DOC,
    headers: {
      'cf-connecting-ip': clientIp,
      ...(origin ? { origin } : {}),
    },
  });

describe('/api/sync origin gate', () => {
  it('403s creates from a foreign origin without touching KV', async () => {
    const env = makeEnv();
    const res = await worker.fetch(syncReq('POST', '/api/sync', ip(), 'https://evil.example'), env, CTX);
    expect(res.status).toBe(403);
    expect(env.SYNC.put).not.toHaveBeenCalled();
  });

  it('403s PUTs from a foreign origin', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      syncReq('PUT', '/api/sync/AAAAAAAA', ip(), 'https://evil.example'),
      env,
      CTX,
    );
    expect(res.status).toBe(403);
    expect(env.SYNC.put).not.toHaveBeenCalled();
  });

  it('accepts same-origin and origin-less (non-browser) creates', async () => {
    const env = makeEnv();
    const a = await worker.fetch(syncReq('POST', '/api/sync', ip(), 'https://purrwall.xyz'), env, CTX);
    expect(a.status).toBe(200);
    expect((await a.json()).code).toMatch(/^[A-Z2-7]{8}$/);
    const b = await worker.fetch(syncReq('POST', '/api/sync', ip()), env, CTX);
    expect(b.status).toBe(200);
  });
});

describe('/api/sync create budget (6/min, shared with PUT-to-missing-code)', () => {
  it('429s the 7th create from one IP inside a minute', async () => {
    const env = makeEnv();
    const me = ip();
    for (let i = 0; i < 6; i++) {
      expect((await worker.fetch(syncReq('POST', '/api/sync', me), env, CTX)).status).toBe(200);
    }
    expect((await worker.fetch(syncReq('POST', '/api/sync', me), env, CTX)).status).toBe(429);
    expect(env.SYNC.put).toHaveBeenCalledTimes(6);
  });

  it('PUT to a MISSING code spends the create budget, not just the update one', async () => {
    const env = makeEnv(); // SYNC.get -> null = code does not exist
    const me = ip();
    let created = 0;
    for (let i = 0; i < 10; i++) {
      const res = await worker.fetch(syncReq('PUT', '/api/sync/AAAAAAA' + 'ABCDEFGHIJ'[i], me), env, CTX);
      if (res.status === 204) created++;
    }
    expect(created).toBe(6); // the create budget, NOT the 60/min update budget
  });

  it('PUT to an EXISTING code uses the roomier update budget', async () => {
    const env = makeEnv();
    env.SYNC.get = vi.fn(async () => '{"v":1,"walls":[]}');
    const me = ip();
    for (let i = 0; i < 10; i++) {
      const res = await worker.fetch(syncReq('PUT', '/api/sync/BBBBBBBB', me), env, CTX);
      expect(res.status).toBe(204);
    }
  });
});

describe('/api/sync update budget (60/min, 200/day)', () => {
  it('caps one IP at 200 updates a day, well under the account-wide KV write quota', async () => {
    const env = makeEnv();
    env.SYNC.get = vi.fn(async () => '{"v":1,"walls":[]}');
    const me = ip();
    vi.useFakeTimers();
    try {
      const t0 = Date.UTC(2026, 0, 1);
      let ok = 0;
      let last = 0;
      for (let i = 0; i < 201; i++) {
        vi.setSystemTime(t0 + i * 2000); // 30/min stays under the minute window
        last = (await worker.fetch(syncReq('PUT', '/api/sync/CCCCCCCC', me), env, CTX)).status;
        if (last === 204) ok++;
      }
      expect(ok).toBe(200);
      expect(last).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('/api/sync watch carry-forward', () => {
  const ADDR = `0x${'a'.repeat(40)}`;
  const putReq = (body, clientIp) =>
    new Request('https://purrwall.xyz/api/sync/AAAAAAAA', {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'cf-connecting-ip': clientIp, origin: 'https://purrwall.xyz' },
    });

  it('a PUT with NO watch fields keeps the stored ones (pre-watch clients must not erase them)', async () => {
    const env = makeEnv();
    let stored = JSON.stringify({
      v: 1,
      walls: [],
      watchAddr: ADDR,
      watchAddrAt: 1_000,
      watchBook: [{ a: ADDR, n: 'main' }],
    });
    env.SYNC.get = vi.fn(async () => stored);
    env.SYNC.put = vi.fn(async (_k, v) => {
      stored = v;
    });
    await worker.fetch(putReq({ v: 1, walls: [] }, ip()), env, CTX);
    expect(JSON.parse(stored)).toMatchObject({
      watchAddr: ADDR,
      watchAddrAt: 1_000,
      watchBook: [{ a: ADDR, n: 'main' }],
    });
  });

  it('a stamped clear (watchAddrAt, no address) still clears the address', async () => {
    const env = makeEnv();
    let stored = JSON.stringify({ v: 1, walls: [], watchAddr: ADDR, watchAddrAt: 1_000 });
    env.SYNC.get = vi.fn(async () => stored);
    env.SYNC.put = vi.fn(async (_k, v) => {
      stored = v;
    });
    await worker.fetch(putReq({ v: 1, walls: [], watchAddrAt: 2_000, watchBook: [] }, ip()), env, CTX);
    const doc = JSON.parse(stored);
    expect(doc.watchAddrAt).toBe(2_000);
    expect(doc).not.toHaveProperty('watchAddr');
    expect(doc.watchBook).toEqual([]); // deliberate empty sticks
  });

  it('a stamped PUT WITHOUT a book field (pre-book client) keeps the stored book; an explicit [] erases it', async () => {
    const env = makeEnv();
    const seed = JSON.stringify({
      v: 1,
      walls: [],
      watchAddr: ADDR,
      watchAddrAt: 1_000,
      watchBook: [{ a: ADDR, n: 'main' }],
    });
    let stored = seed;
    env.SYNC.get = vi.fn(async () => stored);
    env.SYNC.put = vi.fn(async (_k, v) => {
      stored = v;
    });
    // pre-book client: stamps the unit, knows no watchBook field
    await worker.fetch(putReq({ v: 1, walls: [], watchAddr: ADDR, watchAddrAt: 2_000 }, ip()), env, CTX);
    expect(JSON.parse(stored).watchBook).toEqual([{ a: ADDR, n: 'main' }]);
    // new client deliberately emptying the book
    stored = seed;
    await worker.fetch(
      putReq({ v: 1, walls: [], watchAddrAt: 3_000, watchBook: [] }, ip()),
      env,
      CTX,
    );
    expect(JSON.parse(stored).watchBook).toEqual([]);
  });
});

// --- /api/feedback -----------------------------------------------------
// Feedback is an unauthenticated write carrying USER TEXT, so it gets the
// same gate order as /api/sync POST and the scarce create-shaped budget.
// These pins exist because every one of them is a way the route could quietly
// become a hole: an unthrottled text sink, a foreign-origin write, or a record
// that grows a join key back to a person.

const fbReq = (clientIp, origin, body = JSON.stringify({ m: 'the wall is great' })) =>
  new Request('https://purrwall.xyz/api/feedback', {
    method: 'POST',
    body,
    headers: { 'cf-connecting-ip': clientIp, ...(origin ? { origin } : {}) },
  });

describe('/api/feedback', () => {
  it('accepts a submission from our own origin and stores text + time only', async () => {
    const env = makeEnv();
    const res = await worker.fetch(fbReq(ip(), 'https://purrwall.xyz'), env, CTX);
    expect(res.status).toBe(204);
    expect(env.FEEDBACK.put).toHaveBeenCalledTimes(1);
    const [key, value, opts] = env.FEEDBACK.put.mock.calls[0];
    expect(key).toMatch(/^fb:\d+:[0-9a-f]{12}$/);
    // The record must be text + timestamp and NOTHING else — no id of any
    // kind, no IP.
    expect(Object.keys(JSON.parse(value)).sort()).toEqual(['at', 'm']);
    expect(JSON.parse(value).m).toBe('the wall is great');
    expect(opts.expirationTtl).toBe(90 * 24 * 3600);
  });

  it('403s a foreign origin without touching KV', async () => {
    const env = makeEnv();
    const res = await worker.fetch(fbReq(ip(), 'https://evil.example'), env, CTX);
    expect(res.status).toBe(403);
    expect(env.FEEDBACK.put).not.toHaveBeenCalled();
  });

  // The mail notification is an ADD-ON to the KV write, never a precondition.
  // Local dev has no send_email binding, so an ungated notify() would throw on
  // every submission there and lose the message.
  it('stores the message and 204s with no mail binding configured', async () => {
    const env = makeEnv(); // no MAIL, no FEEDBACK_TO — local dev
    const ctx = { waitUntil: vi.fn() };
    const res = await worker.fetch(fbReq(ip(), 'https://purrwall.xyz'), env, ctx);
    expect(res.status).toBe(204);
    expect(env.FEEDBACK.put).toHaveBeenCalledTimes(1);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it('does not mail when FEEDBACK_TO is missing or not a single-line address', async () => {
    for (const to of [undefined, '', 'not-an-address', 'a@b.c\r\nBcc: evil@example.com']) {
      const env = { ...makeEnv(), MAIL: { send: vi.fn() }, FEEDBACK_TO: to };
      const ctx = { waitUntil: vi.fn() };
      const res = await worker.fetch(fbReq(ip(), 'https://purrwall.xyz'), env, ctx);
      expect(res.status).toBe(204);
      expect(env.FEEDBACK.put).toHaveBeenCalledTimes(1);
      expect(ctx.waitUntil).not.toHaveBeenCalled();
    }
  });

  it('rejects an empty or whitespace-only message as 400', async () => {
    const env = makeEnv();
    for (const body of [JSON.stringify({ m: '   ' }), JSON.stringify({}), 'not json']) {
      const res = await worker.fetch(fbReq(ip(), 'https://purrwall.xyz', body), env, CTX);
      expect(res.status).toBe(400);
    }
    expect(env.FEEDBACK.put).not.toHaveBeenCalled();
  });

  it('413s an oversized body before parsing it', async () => {
    const env = makeEnv();
    const body = JSON.stringify({ m: 'x'.repeat(8000) });
    const res = await worker.fetch(fbReq(ip(), 'https://purrwall.xyz', body), env, CTX);
    expect(res.status).toBe(413);
    expect(env.FEEDBACK.put).not.toHaveBeenCalled();
  });

  it('clamps a long message rather than losing it', async () => {
    const env = makeEnv();
    const body = JSON.stringify({ m: 'y'.repeat(3000) });
    const res = await worker.fetch(fbReq(ip(), 'https://purrwall.xyz', body), env, CTX);
    expect(res.status).toBe(204);
    expect(JSON.parse(env.FEEDBACK.put.mock.calls[0][1]).m).toHaveLength(2000);
  });

  it('throttles at 3/min per IP — a text sink must not be floodable', async () => {
    const env = makeEnv();
    const mine = ip();
    for (let i = 0; i < 3; i++) {
      expect((await worker.fetch(fbReq(mine, 'https://purrwall.xyz'), env, CTX)).status).toBe(204);
    }
    const res = await worker.fetch(fbReq(mine, 'https://purrwall.xyz'), env, CTX);
    expect(res.status).toBe(429);
    expect(env.FEEDBACK.put).toHaveBeenCalledTimes(3);
  });
});

// ── /api/sparks-ingest ───────────────────────────────────────────────────
// The one KV key that is NOT user state, and the only route whose payload is
// later served VERBATIM to every visitor — so the shape gate is the whole
// safety argument, exactly like sanitizeSyncDoc's. The GET side deliberately
// isn't exercised here: it goes through `caches`, and vi.stubGlobal is not
// undone by restoreAllMocks, so stubbing it leaks into every later file.

const sparksEnv = () => ({ SPARKS: { put: vi.fn(async () => {}) }, SPARKS_TOKEN: 'tok' });

const ingest = (body, token = 'tok') =>
  new Request('https://purrwall.xyz/api/sparks-ingest', {
    method: 'POST',
    headers: {
      'cf-connecting-ip': ip(),
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const GOOD = { v: 1, points: { BTC: [1, 2, 3], 'xyz:TSLA': [9.5, 9.6] } };

describe('/api/sparks-ingest token gate', () => {
  it('404s a missing token — the endpoint stays invisible, never 401', async () => {
    const env = sparksEnv();
    const res = await worker.fetch(ingest(GOOD, null), env, CTX);
    expect(res.status).toBe(404);
    expect(env.SPARKS.put).not.toHaveBeenCalled();
  });

  it('404s a wrong token', async () => {
    const env = sparksEnv();
    const res = await worker.fetch(ingest(GOOD, 'nope'), env, CTX);
    expect(res.status).toBe(404);
    expect(env.SPARKS.put).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the secret is unset', async () => {
    const env = { SPARKS: { put: vi.fn(async () => {}) } };
    const res = await worker.fetch(ingest(GOOD), env, CTX);
    expect(res.status).toBe(404);
    expect(env.SPARKS.put).not.toHaveBeenCalled();
  });
});

describe('/api/sparks-ingest shape gate', () => {
  const rejects = async (body) => {
    const env = sparksEnv();
    const res = await worker.fetch(ingest(body), env, CTX);
    expect(env.SPARKS.put).not.toHaveBeenCalled();
    return res.status;
  };

  it('accepts a well-formed blob and stores it under the versioned key', async () => {
    const env = sparksEnv();
    const res = await worker.fetch(ingest(GOOD), env, CTX);
    expect(res.status).toBe(204);
    expect(env.SPARKS.put).toHaveBeenCalledTimes(1);
    const [key, value, opts] = env.SPARKS.put.mock.calls[0];
    expect(key).toBe('sparks:v1');
    expect(JSON.parse(value).points).toEqual(GOOD.points);
    expect(JSON.parse(value).v).toBe(1);
    expect(opts.expirationTtl).toBe(7 * 24 * 3600);
  });

  it('rejects unparseable and wrong-version bodies', async () => {
    expect(await rejects('{not json')).toBe(400);
    expect(await rejects({ v: 2, points: { BTC: [1, 2] } })).toBe(400);
    expect(await rejects({ points: { BTC: [1, 2] } })).toBe(400);
  });

  it('rejects a missing, null or non-object points map', async () => {
    expect(await rejects({ v: 1 })).toBe(400);
    expect(await rejects({ v: 1, points: null })).toBe(400);
    expect(await rejects({ v: 1, points: 'BTC' })).toBe(400);
  });

  it('rejects an empty map and one past the 2000-coin cap', async () => {
    expect(await rejects({ v: 1, points: {} })).toBe(400);
    const huge = {};
    for (let i = 0; i < 2001; i++) huge[`c${i}`] = [1, 2];
    expect(await rejects({ v: 1, points: huge })).toBe(400);
  });

  it('rejects series that are not short arrays of finite numbers', async () => {
    expect(await rejects({ v: 1, points: { BTC: [1] } })).toBe(400); // too short
    expect(await rejects({ v: 1, points: { BTC: Array(27).fill(1) } })).toBe(400); // too long
    expect(await rejects({ v: 1, points: { BTC: [1, '2'] } })).toBe(400); // not numeric
    expect(await rejects({ v: 1, points: { BTC: [1, NaN] } })).toBe(400);
    expect(await rejects({ v: 1, points: { BTC: [1, null] } })).toBe(400);
    expect(await rejects({ v: 1, points: { BTC: { 0: 1, 1: 2 } } })).toBe(400); // not an array
  });

  it('rejects coin keys that are empty or absurdly long', async () => {
    expect(await rejects({ v: 1, points: { '': [1, 2] } })).toBe(400);
    expect(await rejects({ v: 1, points: { ['x'.repeat(65)]: [1, 2] } })).toBe(400);
  });

  it('413s a body past the size cap before any parsing', async () => {
    const env = sparksEnv();
    const res = await worker.fetch(ingest('x'.repeat(512 * 1024 + 1)), env, CTX);
    expect(res.status).toBe(413);
    expect(env.SPARKS.put).not.toHaveBeenCalled();
  });
});
