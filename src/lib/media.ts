import { useEffect, useState } from 'react';

/** Live media-query hook: re-renders on match changes (rotation, resize). */
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState<boolean>(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

// Static per device: a pointer doesn't change coarseness mid-session, and a
// constant avoids threading a hook through ChartCell's render-hot path.
export const IS_COARSE = window.matchMedia('(pointer: coarse)').matches;
