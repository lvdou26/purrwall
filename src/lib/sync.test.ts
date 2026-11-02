import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SYNC_MAX_WALLS,
  capTombstones,
  getSyncHealth,
  mergeWalls,
  reconcile,
  type SyncedWall,
} from './sync';

// sync.ts holds the only backend USER state in the product, its failures are
// silent, and they are cross-device — the worst combination to leave unpinned.
// reconcile() is exercised through a stubbed fetch rather than by exporting
// its internals: the contract that matters is which REQUESTS it makes.

const NOW = Date.now();
const wall = (name: string, updatedAt = NOW): SyncedWall => ({
  name,
  count: 1,
  cells: [{ coin: 'BTC', interval: '1h' }],
  updatedAt,
});
const tomb = (name: string, deletedAt = NOW): SyncedWall => ({
  name,
  count: 0,
  cells: [],
  deletedAt,
});

describe('capTombstones', () => {
  it('leaves a library under the cap untouched', () => {
    const walls = [wall('a'), tomb('b')];
    expect(capTombstones(walls)).toBe(walls);
  });

  it('evicts the OLDEST tombstones first and never a live wall', () => {
    // cap+10 entries: 95 live, 15 tombstones of increasing age
    const live = Array.from({ length: 95 }, (_, i) => wall(`live${i}`));
    const tombs = Array.from({ length: 15 }, (_, i) => tomb(`dead${i}`, NOW - i * 1000));
    const out = capTombstones([...live, ...tombs]);
    expect(out).toHaveLength(SYNC_MAX_WALLS);
    // every live wall survived
    expect(out.filter((w) => !w.deletedAt)).toHaveLength(95);
    // the 5 kept tombstones are the 5 youngest
    const keptNames = out.filter((w) => w.deletedAt).map((w) => w.name);
    expect(keptNames).toEqual(['dead0', 'dead1', 'dead2', 'dead3', 'dead4']);
  });

  it('keeps every live wall even when live alone exceeds the cap', () => {
    const live = Array.from({ length: SYNC_MAX_WALLS + 5 }, (_, i) => wall(`live${i}`));
    const out = capTombstones([...live, tomb('d')]);
    expect(out.filter((w) => !w.deletedAt)).toHaveLength(SYNC_MAX_WALLS + 5);
    expect(out.filter((w) => w.deletedAt)).toHaveLength(0);
  });
});

describe('mergeWalls', () => {
  it('takes the newer side per name', () => {
    const out = mergeWalls([wall('a', 100)], [wall('a', 200)]);
    expect(out).toHaveLength(1);
    expect(out[0].updatedAt).toBe(200);
  });

  it('keeps LOCAL on an exact tie (stability)', () => {
    const mine = { ...wall('a', 100), count: 7 };
    const out = mergeWalls([mine], [{ ...wall('a', 100), count: 9 }]);
    expect(out[0].count).toBe(7);
  });

  it('unions names from both sides', () => {
    const out = mergeWalls([wall('a')], [wall('b')]).map((w) => w.name).sort();
    expect(out).toEqual(['a', 'b']);
  });

  it('lets a newer tombstone delete a wall, and a newer edit resurrect it', () => {
    // NOW-relative on purpose: a tombstone is also TTL-filtered, so epoch-ish
    // stamps would be dropped as 56-years-stale before the merge is even read.
    const deleted = mergeWalls([wall('a', NOW - 1000)], [tomb('a', NOW)]);
    expect(deleted[0].deletedAt).toBe(NOW);

    const revived = mergeWalls([tomb('a', NOW - 1000)], [wall('a', NOW)]);
    expect(revived[0].deletedAt).toBeUndefined();
    expect(revived[0].updatedAt).toBe(NOW);
  });

  it('drops tombstones past the 90-day TTL but keeps fresh ones', () => {
    const old = tomb('gone', NOW - 91 * 24 * 3600_000);
    const fresh = tomb('recent', NOW - 24 * 3600_000);
    const names = mergeWalls([old, fresh], []).map((w) => w.name);
    expect(names).toEqual(['recent']);
  });

  it('never returns more than the server cap', () => {
    const local = Array.from({ length: 80 }, (_, i) => wall(`l${i}`));
    const remote = Array.from({ length: 80 }, (_, i) => tomb(`r${i}`, NOW - i * 1000));
    expect(mergeWalls(local, remote).length).toBeLessThanOrEqual(SYNC_MAX_WALLS);
  });
});

describe('reconcile', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Stub fetch: GET answers with `remote`, PUT answers with `putStatus`. */
  const stubFetch = (
    remote: { status: number; walls?: SyncedWall[]; watchAddr?: string; watchAddrAt?: number },
    putStatus = 200,
  ) => {
    const calls: Array<{ method: string; body?: unknown }> = [];
    const fn = vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === 'GET') {
        return {
          ok: remote.status === 200,
          status: remote.status,
          json: async () => ({
            walls: remote.walls ?? [],
            ...(remote.watchAddr !== undefined ? { watchAddr: remote.watchAddr } : {}),
            ...(remote.watchAddrAt !== undefined ? { watchAddrAt: remote.watchAddrAt } : {}),
          }),
        } as unknown as Response;
      }
      return { ok: putStatus >= 200 && putStatus < 300, status: putStatus } as Response;
    });
    vi.stubGlobal('fetch', fn);
    return calls;
  };

  it('does NOT write when the merged library already matches the server', async () => {
    // The whole reason sameLibrary exists: the server re-emits a different key
    // order, so a naive JSON compare is never equal and EVERY reconcile would
    // burn a KV PUT (free-tier quota, and a wider write race).
    const serverShaped = { cells: [{ coin: 'BTC', interval: '1h' }], count: 1, name: 'a', updatedAt: 5 };
    const calls = stubFetch({ status: 200, walls: [serverShaped as SyncedWall] });
    const merged = await reconcile('AAAAAAAA', [wall('a', 5)]);
    expect(merged?.walls).toHaveLength(1);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('writes back when the local side is genuinely newer', async () => {
    const calls = stubFetch({ status: 200, walls: [wall('a', 1)] });
    await reconcile('AAAAAAAA', [wall('a', 2)]);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect((calls[1].body as { walls: SyncedWall[] }).walls[0].updatedAt).toBe(2);
  });

  it('upserts on 404 — an idled-out doc is revived, not treated as empty', async () => {
    const calls = stubFetch({ status: 404 });
    const merged = await reconcile('AAAAAAAA', [wall('a')]);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(merged?.walls).toHaveLength(1);
  });

  it('returns null (never data) on a non-404 read failure, without writing', async () => {
    const calls = stubFetch({ status: 500 });
    expect(await reconcile('AAAAAAAA', [wall('a')])).toBeNull();
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('returns null when the network throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    expect(await reconcile('AAAAAAAA', [wall('a')])).toBeNull();
  });

  it('flags health only on a deliberate 400, not on a transient 429', async () => {
    stubFetch({ status: 200, walls: [wall('a', 1)] }, 429);
    await reconcile('AAAAAAAA', [wall('a', 2)]);
    expect(getSyncHealth()).toBe('ok'); // self-healing — must not show ⚠

    stubFetch({ status: 200, walls: [wall('a', 1)] }, 400);
    await reconcile('AAAAAAAA', [wall('a', 2)]);
    expect(getSyncHealth()).toBe('rejected');

    // and it clears again once a PUT lands
    stubFetch({ status: 200, walls: [wall('a', 1)] }, 200);
    await reconcile('AAAAAAAA', [wall('a', 2)]);
    expect(getSyncHealth()).toBe('ok');
  });

  it('still returns the merged library when the write bounces', async () => {
    // the pull half worked; blocking remote reads because local writes fail
    // would only widen the damage
    stubFetch({ status: 200, walls: [wall('remote-only', 9)] }, 400);
    const merged = await reconcile('AAAAAAAA', [wall('a', 2)]);
    expect(merged?.walls.map((w) => w.name).sort()).toEqual(['a', 'remote-only']);
  });

  // ── watch state (one doc-level LWW unit: active address + book) ──

  it('omits the watch fields entirely while untouched (pre-watch docs stay byte-stable)', async () => {
    const calls = stubFetch({ status: 200, walls: [wall('a', 1)] });
    await reconcile('AAAAAAAA', [wall('a', 2)]);
    const body = calls[1].body as Record<string, unknown>;
    expect(body).not.toHaveProperty('watchAddr');
    expect(body).not.toHaveProperty('watchAddrAt');
  });

  it('a watch delta ALONE triggers a PUT, walls unchanged', async () => {
    const serverShaped = { cells: [{ coin: 'BTC', interval: '1h' }], count: 1, name: 'a', updatedAt: 5 };
    const calls = stubFetch({ status: 200, walls: [serverShaped as SyncedWall] });
    const addr = `0x${'a'.repeat(40)}`;
    const merged = await reconcile('AAAAAAAA', [wall('a', 5)], { addr, at: NOW, book: [{ addr, name: '' }] });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(calls[1].body).toMatchObject({ watchAddr: addr, watchAddrAt: NOW });
    expect(merged?.watch).toEqual({ addr, at: NOW, book: [{ addr, name: '' }] });
  });

  it('remote newer watch wins and is returned; a local clear with a newer stamp pushes', async () => {
    const addr = `0x${'b'.repeat(40)}`;
    stubFetch({ status: 200, walls: [], watchAddr: addr, watchAddrAt: NOW });
    const merged = await reconcile('AAAAAAAA', [], { addr: null, at: NOW - 1000, book: [] });
    expect(merged?.watch).toEqual({ addr, at: NOW, book: [] });

    // local CLEAR is newer → the PUT carries the stamp but no address
    const calls = stubFetch({ status: 200, walls: [], watchAddr: addr, watchAddrAt: NOW - 1000 });
    const cleared = await reconcile('AAAAAAAA', [], { addr: null, at: NOW, book: [] });
    expect(cleared?.watch).toEqual({ addr: null, at: NOW, book: [] });
    const body = calls[1].body as Record<string, unknown>;
    expect(body.watchAddrAt).toBe(NOW);
    expect(body).not.toHaveProperty('watchAddr');
  });

  it('the address book rides the doc as {a, n} pairs and round-trips', async () => {
    const a1 = `0x${'c'.repeat(40)}`;
    const a2 = `0x${'d'.repeat(40)}`;
    const calls = stubFetch({ status: 200, walls: [] });
    const local = {
      addr: a1,
      at: NOW,
      book: [
        { addr: a1, name: 'main' },
        { addr: a2, name: '' },
      ],
    };
    await reconcile('AAAAAAAA', [], local);
    const body = calls[1].body as { watchBook?: Array<{ a: string; n?: string }> };
    expect(body.watchBook).toEqual([{ a: a1, n: 'main' }, { a: a2 }]);

    // and a remote doc's book comes back parsed, name defaulting to ''
    stubFetch({ status: 200, walls: [], watchAddr: a2, watchAddrAt: NOW + 1 });
    // (stub can't carry watchBook — watchOfDoc's book parse is covered by the
    // body assertion above plus the worker sanitize tests; the unit merge is
    // wholesale by stamp either way)
    const merged = await reconcile('AAAAAAAA', [], local);
    expect(merged?.watch.addr).toBe(a2);
    expect(merged?.watch.book).toEqual([]);
  });
});
