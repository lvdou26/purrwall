/**
 * 24h trend glyphs for the list view: ONE edge-cached blob fetch renders
 * EVERY row's glyph in the same frame — zero client-side candleSnapshot
 * calls, zero contention with the wall's REST budget (a per-row fetch could
 * only trickle: ~21 weight per coin against the shared 1200/min IP budget is
 * a physical limit no client-side scheduling can beat).
 *
 * The blob is pre-aggregated hourly by the public purrwall-data repo's
 * Actions pipeline into Workers KV, served by worker/index.js /api/sparks
 * (edge-cached, CORS-open — public aggregate market data). Hourly shape is
 * plenty for a glyph; the live price cell beside it carries "now".
 *
 * Graceful degrade by design: no blob (pipeline dead > a week, network
 * error) → null → the table renders without glyphs.
 */

export type SparkMap = Map<string, number[]>;

const TTL_MS = 10 * 60_000;
// The Vite dev server runs no worker, so dev reads prod's public blob
// cross-origin. A production build (served by wrangler dev, vite preview or a
// deploy) stays same-origin: its CSP allows no other origin.
const SPARKS_URL = import.meta.env.DEV ? 'https://purrwall.xyz/api/sparks' : '/api/sparks';

let cached: { at: number; map: SparkMap } | null = null;
let inflight: Promise<SparkMap | null> | null = null;

export function getSparklines(): Promise<SparkMap | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.map);
  if (inflight) return inflight;
  inflight = fetch(SPARKS_URL)
    .then((res) => (res.ok ? res.json() : null))
    .then((body: { v?: number; points?: Record<string, number[]> } | null) => {
      if (!body || body.v !== 1 || !body.points) return cached?.map ?? null;
      const map: SparkMap = new Map(Object.entries(body.points));
      cached = { at: Date.now(), map };
      return map;
    })
    .catch(() => cached?.map ?? null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
