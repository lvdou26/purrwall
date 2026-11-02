import { useEffect, useState } from 'react';

/**
 * Deploy detection for already-open walls. Every build ships /version.json
 * (git sha, vite.config.ts versionPlugin) and bakes the same sha into the
 * bundle — a mismatch means a new version is live. Detection is a cheap poll
 * of a ~60-byte edge-cached static asset (never invokes the worker) while the
 * tab is visible, plus an immediate re-check whenever the user returns to the
 * page — tab return
 * (visibilitychange), WINDOW refocus (focus: switching back from another
 * APP, e.g. an editor — visibilitychange does NOT fire for that), and
 * network recovery.
 *
 * UX contract: the app NEVER reloads itself — no background reload path
 * exists, deliberately. Every deploy surfaces the "↻ new version" pill on
 * every open wall and the user clicks it. (?mini=1 popouts pass
 * enabled=false: they have no topbar to carry the pill.)
 */

const POLL_MS = 60_000; // deploys should be noticed in ~a minute, not five

/** The sha being served right now, or null when unknowable. A host without
 *  /version.json answers this path with the SPA fallback's HTML 200 — the
 *  content-type gate maps it to null silently. */
async function fetchLiveSha(): Promise<string | null> {
  const res = await fetch('/version.json', { cache: 'no-store' });
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
  const v = (await res.json()) as { sha?: string };
  return typeof v.sha === 'string' && v.sha !== 'unknown' ? v.sha : null;
}

/**
 * One-shot probe for pull-to-refresh: is a newer build live RIGHT NOW than
 * the one running? Time-capped so a slow edge can't hang the gesture — on
 * timeout/offline/dev it reports false and the pull degrades to a data heal.
 * Reloading on a true result stays within the never-self-reload rule: the
 * pull is user-initiated, the same gesture class as clicking the ↻ pill.
 */
export async function isNewVersionLive(timeoutMs = 2000): Promise<boolean> {
  if (import.meta.env.DEV || __BUILD_SHA__ === 'unknown') return false;
  try {
    const sha = await Promise.race([
      fetchLiveSha(),
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return sha !== null && sha !== __BUILD_SHA__;
  } catch {
    return false;
  }
}

export function useUpdateCheck(enabled: boolean): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!enabled || import.meta.env.DEV || __BUILD_SHA__ === 'unknown') return;
    let disposed = false;

    const check = async () => {
      try {
        const sha = await fetchLiveSha();
        if (!disposed && sha !== null && sha !== __BUILD_SHA__) setReady(true);
      } catch {
        /* offline / transient — next poll or the 'online' listener retries */
      }
    };

    const onReturn = () => {
      if (!document.hidden) check();
    };
    const timer = window.setInterval(onReturn, POLL_MS); // hidden tabs skip
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    window.addEventListener('online', check);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('online', check);
    };
  }, [enabled]);

  return ready;
}
