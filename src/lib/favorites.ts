import { useSyncExternalStore } from 'react';

const FAV_KEY = 'purrwall.favorites';

/**
 * Favorites as a module-level store rather than per-component state: the
 * market table mounts in two surfaces (picker modal, list view) that can be
 * alive at once, and if each held its own copy, a toggle in one would be
 * silently reverted by the other's next write. One in-memory Set,
 * read-merge-write on toggle, and a storage listener so paired tabs converge
 * too.
 */

/** null = storage unreadable (blocked/corrupt) — the caller falls back to
 *  the in-memory set, so blocked storage degrades to session-local
 *  favorites instead of every toggle wiping the previous ones. */
function load(): Set<string> | null {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return null;
  }
}

let favs = load() ?? new Set<string>();
const subs = new Set<() => void>();
function emit(): void {
  for (const fn of subs) fn();
}

// storage events fire only in OTHER tabs — this is the cross-tab half.
window.addEventListener('storage', (e) => {
  if (e.key !== FAV_KEY) return;
  favs = load() ?? favs;
  emit();
});

export function toggleFavorite(coin: string): void {
  // Re-read before writing: another surface/tab may have toggled since our
  // snapshot — a blind whole-blob write would revert it.
  const next = load() ?? new Set(favs);
  if (next.has(coin)) next.delete(coin);
  else next.add(coin);
  favs = next;
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify([...next]));
  } catch {
    /* storage blocked — favorites stay session-local */
  }
  emit();
}

export function useFavorites(): Set<string> {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => favs,
  );
}
