import { useEffect, useMemo, useState } from 'react';

/**
 * Topbar clock: the current time, to the second, in the SAME timezone the
 * chart axes use (the tz dropdown's choice) — so a funding hour or a macro
 * print can be timed against the wall without a mental offset conversion.
 * Passive display only: not a control.
 *
 * `tz` is the app's persisted value: 'local' | 'utc' | curated IANA id.
 * Intl gives the true wall-clock time even across a mid-session DST switch;
 * the axis shift and the zone suffix (tzOffsetSec in App) re-sample every
 * minute, so all three agree at "now" within a minute of a flip.
 */
export function Clock({ tz, suffix, title }: { tz: string; suffix?: string; title: string }) {
  const fmt = useMemo(() => {
    const opts: Intl.DateTimeFormatOptions = {
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    };
    try {
      return new Intl.DateTimeFormat('en-GB', {
        ...opts,
        timeZone: tz === 'local' ? undefined : tz === 'utc' ? 'UTC' : tz,
      });
    } catch {
      // tampered/unknown persisted zone id — degrade to UTC, matching
      // tzToOffsetSec's 0 fallback so clock and axis stay on one story
      return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' });
    }
  }, [tz]);
  const [text, setText] = useState(() => fmt.format(new Date()));
  useEffect(() => {
    setText(fmt.format(new Date()));
    // 4 checks/sec keeps the display near the second boundary without a
    // drift-correcting timer; unchanged strings bail out of the re-render.
    const id = setInterval(() => setText(fmt.format(new Date())), 250);
    return () => clearInterval(id);
  }, [fmt]);
  return (
    <span className="clock" title={title}>
      {text}
      {suffix && <span className="clock-tz">{suffix}</span>}
    </span>
  );
}
