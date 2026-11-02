/**
 * Opt-in wall-library sync without accounts. An unguessable 8-char pairing
 * code names a KV document holding the saved-wall library (wall names +
 * market symbols) plus the optional watch state: the active address and the
 * address book (public HL addresses with optional names; see lib/watch.ts).
 * 60-day idle TTL, refreshed on every write.
 *
 * Model: reconcile() is the ONLY movement — read the server doc, merge
 * per-wall last-write-wins (deletes propagate as tombstones; the watch
 * state is one doc-level LWW unit under its own stamp), write back if
 * anything differs, return the merged doc. Called after local changes
 * (debounced) and on tab return; there is no polling loop. PUT upserts, so
 * a code that idled out self-heals as long as one paired device still has
 * it.
 */

export interface SyncedWall {
  name: string;
  count: number;
  cols?: number;
  cells: Array<{ coin: string | null; interval: string }>;
  /** last content change (ms) — the merge tiebreaker */
  updatedAt?: number;
  /** tombstone: the wall was deleted at this time; content fields absent */
  deletedAt?: number;
}

/** The watch state as it rides the sync doc: the active address (`addr`
 *  null = deactivated), the address BOOK ({addr, name} entries — names are
 *  user text, synced like wall names), and one stamp `at` governing the
 *  whole unit (0 = this device never touched it). */
export interface SyncedWatch {
  addr: string | null;
  at: number;
  book: Array<{ addr: string; name: string }>;
}

const NO_WATCH: SyncedWatch = { addr: null, at: 0, book: [] };

/** Doc-level unit LWW: newer stamp wins WHOLESALE (active + book together),
 *  local wins ties — same stance as walls. Stamps are client clocks, so a
 *  fast-clock device can out-vote a newer real-time change until its skew
 *  elapses — identical to the wall-stamp semantics and accepted at the same
 *  grade (the server only clamps future stamps on write). Concurrent book
 *  edits on two devices: one side's edit loses — accepted; per-entry merge
 *  is not worth its complexity at a ≤20-entry book. */
export const mergeWatch = (local: SyncedWatch, remote: SyncedWatch): SyncedWatch =>
  remote.at > local.at ? remote : local;

const watchOfDoc = (doc: {
  watchAddr?: unknown;
  watchAddrAt?: unknown;
  watchBook?: unknown;
}): SyncedWatch => ({
  addr: typeof doc.watchAddr === 'string' ? doc.watchAddr : null,
  at: typeof doc.watchAddrAt === 'number' && Number.isFinite(doc.watchAddrAt) ? doc.watchAddrAt : 0,
  book: Array.isArray(doc.watchBook)
    ? (doc.watchBook as Array<{ a?: unknown; n?: unknown }>)
        .filter((e) => typeof e?.a === 'string')
        .map((e) => ({ addr: e.a as string, name: typeof e.n === 'string' ? e.n : '' }))
    : [],
});

/** Body fields for the watch state — omitted entirely while untouched, so
 *  docs from pre-watch clients stay byte-stable. Book entries wire as
 *  {a, n} (n omitted when unnamed). watchBook is ALWAYS present when
 *  stamped — an explicit [] means "deliberately empty", which is what lets
 *  the worker tell a remove-them-all apart from a pre-book client whose PUT
 *  simply lacks the field (that one gets the stored book carried forward). */
const watchBody = (w: SyncedWatch) =>
  w.at > 0
    ? {
        ...(w.addr ? { watchAddr: w.addr } : {}),
        watchAddrAt: w.at,
        watchBook: w.book.map((e) => ({ a: e.addr, ...(e.name ? { n: e.name } : {}) })),
      }
    : {};

const sameWatch = (a: SyncedWatch, b: SyncedWatch) =>
  a.at === b.at &&
  a.addr === b.addr &&
  a.book.length === b.book.length &&
  a.book.every((e, i) => e.addr === b.book[i].addr && e.name === b.book[i].name);

const SYNC_KEY = 'purrwall.sync.v1';
/** tombstones older than this stop mattering and are dropped */
const TOMBSTONE_TTL_MS = 90 * 24 * 3600_000;

/** The server caps a library at 100 walls (incl. tombstones) / 64KB; the
 *  client must not create past it or every upload 400s. Mirrors
 *  SYNC_MAX_WALLS in worker/index.js — change both together. */
export const SYNC_MAX_WALLS = 100;

/**
 * Sync health, as a module store (favorites.ts pattern). 'rejected' means
 * the SERVER refused our upload (oversized/malformed doc) — a PERSISTENT
 * condition: local edits stop propagating until the library shrinks, so the
 * UI must say so instead of pretending sync works. Network failures NEVER
 * change health — they self-heal and reconcile() already returns null for
 * "try again later".
 */
export type SyncHealth = 'ok' | 'rejected';
let health: SyncHealth = 'ok';
const healthListeners = new Set<() => void>();
export const getSyncHealth = (): SyncHealth => health;
export function subscribeSyncHealth(fn: () => void): () => void {
  healthListeners.add(fn);
  return () => {
    healthListeners.delete(fn);
  };
}
function setHealth(h: SyncHealth) {
  if (h === health) return;
  health = h;
  for (const fn of healthListeners) fn();
}

export function getSyncCode(): string | null {
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    if (!raw) return null;
    const code = (JSON.parse(raw) as { code?: string }).code;
    return typeof code === 'string' && /^[A-Z2-7]{8}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

export function storeSyncCode(code: string | null) {
  try {
    if (code) localStorage.setItem(SYNC_KEY, JSON.stringify({ code }));
    else localStorage.removeItem(SYNC_KEY);
  } catch {
    /* non-fatal */
  }
}

const stamp = (w: SyncedWall) => Math.max(w.updatedAt ?? 0, w.deletedAt ?? 0);

/**
 * Tombstone compaction — the server cap counts tombstones, so without this
 * a churned library jams at SYNC_MAX_WALLS while the user sees few views
 * and "delete some" frees nothing (delete IS a tombstone). Live walls
 * always keep their slots; the OLDEST tombstones are evicted first. Cost:
 * a device that hasn't reconciled since before an evicted tombstone was
 * born may resurrect that wall name — acceptable at this scale, sync
 * jamming forever is not.
 */
export function capTombstones(walls: SyncedWall[]): SyncedWall[] {
  if (walls.length <= SYNC_MAX_WALLS) return walls;
  const live = walls.filter((w) => !w.deletedAt);
  const tombs = walls
    .filter((w) => w.deletedAt)
    .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  return [...live, ...tombs.slice(0, Math.max(0, SYNC_MAX_WALLS - live.length))];
}

/** Per-name last-write-wins union; local wins ties (stability). */
export function mergeWalls(local: SyncedWall[], remote: SyncedWall[]): SyncedWall[] {
  const byName = new Map<string, SyncedWall>();
  for (const w of local) byName.set(w.name, w);
  for (const w of remote) {
    const mine = byName.get(w.name);
    if (!mine || stamp(w) > stamp(mine)) byName.set(w.name, w);
  }
  const now = Date.now();
  return capTombstones(
    [...byName.values()].filter((w) => !w.deletedAt || now - w.deletedAt < TOMBSTONE_TTL_MS),
  );
}

// Canonical per-wall serialization (fixed field order): the merged array
// holds client-shaped objects while the server re-emits a different key
// order, so a raw JSON.stringify compare is NEVER equal in steady state —
// every reconcile would do a KV PUT (free-tier quota + race widening).
const canon = (w: SyncedWall) =>
  JSON.stringify([w.name, w.updatedAt ?? 0, w.deletedAt ?? 0, w.count ?? 0, w.cols ?? 0, w.cells ?? []]);
const sameLibrary = (a: SyncedWall[], b: SyncedWall[]) =>
  JSON.stringify([...a].sort((x, y) => x.name.localeCompare(y.name)).map(canon)) ===
  JSON.stringify([...b].sort((x, y) => x.name.localeCompare(y.name)).map(canon));

/** Create a new sync doc from this device's library; returns the code. */
export async function createSync(walls: SyncedWall[], watch: SyncedWatch = NO_WATCH): Promise<string> {
  const res = await fetch('/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, walls: capTombstones(walls), ...watchBody(watch) }),
  });
  // 400 = the server refused the doc itself (64KB / shape) — retrying the
  // same library can never succeed, and the dialog must not say "network"
  if (res.status === 400) throw new Error('too-large');
  if (!res.ok) throw new Error(`sync create failed (${res.status})`);
  const { code } = (await res.json()) as { code: string };
  storeSyncCode(code);
  setHealth('ok');
  return code;
}

/** Join an existing code: merge remote into local, push the union back.
 *  Throws 'not-found' for a wrong/expired code. */
export async function joinSync(
  code: string,
  walls: SyncedWall[],
  watch: SyncedWatch = NO_WATCH,
): Promise<{ walls: SyncedWall[]; watch: SyncedWatch }> {
  const res = await fetch(`/api/sync/${code}`);
  if (res.status === 404) throw new Error('not-found');
  if (!res.ok) throw new Error(`sync join failed (${res.status})`);
  const remote = (await res.json()) as {
    walls?: SyncedWall[];
    watchAddr?: string;
    watchAddrAt?: number;
    watchBook?: unknown;
  };
  const merged = mergeWalls(walls, remote.walls ?? []);
  const mergedWatch = mergeWatch(watch, watchOfDoc(remote));
  // The join itself succeeded (remote is merged in) even if the push-back
  // fails — reconcile retries the upload; health carries the warning.
  const put = await fetch(`/api/sync/${code}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, walls: merged, ...watchBody(mergedWatch) }),
  });
  // Only a deliberate 400 means "this doc can never land" — transient
  // 429/5xx must not flip the persistent warning (they self-heal).
  if (put.ok) setHealth('ok');
  else if (put.status === 400) setHealth('rejected');
  storeSyncCode(code);
  return { walls: merged, watch: mergedWatch };
}

/**
 * Read-merge-write reconciliation. Returns the merged library (=== input
 * semantically when nothing changed), or null on network failure — callers
 * treat null as "try again later", never as data.
 */
export async function reconcile(
  code: string,
  walls: SyncedWall[],
  watch: SyncedWatch = NO_WATCH,
): Promise<{ walls: SyncedWall[]; watch: SyncedWatch } | null> {
  try {
    const res = await fetch(`/api/sync/${code}`);
    let remote: SyncedWall[] = [];
    let remoteWatch: SyncedWatch = NO_WATCH;
    if (res.ok) {
      const doc = (await res.json()) as {
        walls?: SyncedWall[];
        watchAddr?: string;
        watchAddrAt?: number;
        watchBook?: unknown;
      };
      remote = doc.walls ?? [];
      remoteWatch = watchOfDoc(doc);
    } else if (res.status !== 404) return null; // 404 = expired doc: upsert below revives it
    const merged = mergeWalls(walls, remote);
    const mergedWatch = mergeWatch(watch, remoteWatch);
    const watchDirty = !sameWatch(mergedWatch, remoteWatch);
    if (res.status === 404 || !sameLibrary(merged, remote) || watchDirty) {
      const put = await fetch(`/api/sync/${code}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ v: 1, walls: merged, ...watchBody(mergedWatch) }),
      });
      // A deliberate 400 = the server refused the doc (64KB cap / shape):
      // our EDITS are not landing — flag it. Transient 429/5xx leave health
      // untouched (self-healing, same as the network catch below). Either
      // way still return merged: the pull half worked, and blocking remote
      // reads because local writes bounce would only widen the damage.
      // Health resets the moment a PUT lands again.
      if (put.ok) setHealth('ok');
      else if (put.status === 400) setHealth('rejected');
      return { walls: merged, watch: mergedWatch };
    }
    setHealth('ok');
    return { walls: merged, watch: mergedWatch };
  } catch {
    return null;
  }
}
