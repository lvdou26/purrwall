import { describe, expect, it } from 'vitest';
import { feedbackMime, sanitizeSyncDoc } from './index.js';

const wall = (over = {}) => ({
  name: 'my wall',
  count: 4,
  cols: 2,
  cells: [{ coin: 'BTC', interval: '1h' }],
  updatedAt: 1_000,
  ...over,
});

describe('document shape', () => {
  it('accepts a minimal valid doc and stamps v/updatedAt', () => {
    const before = Date.now();
    const doc = sanitizeSyncDoc({ walls: [wall()] });
    expect(doc).not.toBeNull();
    expect(doc.v).toBe(1);
    expect(doc.updatedAt).toBeGreaterThanOrEqual(before);
    expect(doc.walls).toHaveLength(1);
    expect(doc.walls[0]).toMatchObject({ name: 'my wall', count: 4, cols: 2 });
  });

  it.each([
    ['null body', null],
    ['no walls', {}],
    ['walls not an array', { walls: 'x' }],
    ['over the 100-wall cap', { walls: Array.from({ length: 101 }, () => wall()) }],
  ])('rejects %s', (_label, body) => {
    expect(sanitizeSyncDoc(body)).toBeNull();
  });

  it('accepts exactly 100 walls (the cap is inclusive)', () => {
    expect(sanitizeSyncDoc({ walls: Array.from({ length: 100 }, () => wall()) })).not.toBeNull();
  });

  it('accepts an empty library (every wall tombstoned then capped is a real client state)', () => {
    const doc = sanitizeSyncDoc({ walls: [] });
    expect(doc).not.toBeNull();
    expect(doc.walls).toEqual([]);
  });

  it('drops unknown fields instead of copying them through', () => {
    const doc = sanitizeSyncDoc({ walls: [wall({ evil: '<script>' })], extra: true });
    expect(doc.walls[0]).not.toHaveProperty('evil');
    expect(doc).not.toHaveProperty('extra');
  });
});

describe('watch address (doc-level LWW pair)', () => {
  const ADDR = `0x${'AbC1'.repeat(10)}`;

  it('round-trips a valid address lowercased, with its stamp', () => {
    const doc = sanitizeSyncDoc({ walls: [], watchAddr: ADDR, watchAddrAt: 1_000 });
    expect(doc.watchAddr).toBe(ADDR.toLowerCase());
    expect(doc.watchAddrAt).toBe(1_000);
  });

  it('clamps a future stamp to now (a hostile stamp must not win LWW forever)', () => {
    const doc = sanitizeSyncDoc({ walls: [], watchAddr: ADDR, watchAddrAt: 9e15 });
    expect(doc.watchAddrAt).toBeLessThanOrEqual(Date.now());
  });

  it.each([
    ['too short', '0xabc'],
    ['bad chars', `0x${'g'.repeat(40)}`],
    ['no 0x', 'a'.repeat(42)],
    ['not a string', 42],
  ])('drops a malformed address (%s) but keeps the stamp — a clear, not a rejection', (_l, bad) => {
    const doc = sanitizeSyncDoc({ walls: [], watchAddr: bad, watchAddrAt: 1_000 });
    expect(doc).not.toBeNull();
    expect(doc).not.toHaveProperty('watchAddr');
    expect(doc.watchAddrAt).toBe(1_000);
  });

  it('ignores an address without a stamp (unmergeable) and carries a bare clear', () => {
    const noStamp = sanitizeSyncDoc({ walls: [], watchAddr: ADDR });
    expect(noStamp).not.toHaveProperty('watchAddr');
    expect(noStamp).not.toHaveProperty('watchAddrAt');

    const clear = sanitizeSyncDoc({ walls: [], watchAddrAt: 2_000 });
    expect(clear.watchAddrAt).toBe(2_000);
    expect(clear).not.toHaveProperty('watchAddr');
  });

  it('sanitizes the address book: lowercases, dedupes, clamps names, caps at 20', () => {
    const mk = (i) => `0x${String(i).padStart(2, '0').repeat(20)}`;
    const doc = sanitizeSyncDoc({
      walls: [],
      watchAddrAt: 1_000,
      watchBook: [
        { a: ADDR, n: 'x'.repeat(50) }, // long name → clamped to 32
        { a: ADDR.toLowerCase() }, // duplicate after lowercasing → dropped
        { a: 'nope', n: 'bad' }, // malformed address → dropped
        { n: 'no address' }, // no address → dropped
        ...Array.from({ length: 25 }, (_, i) => ({ a: mk(i + 10) })), // cap fills
      ],
    });
    expect(doc.watchBook[0]).toEqual({ a: ADDR.toLowerCase(), n: 'x'.repeat(32) });
    expect(doc.watchBook).toHaveLength(20);
    expect(doc.watchBook.every((e) => /^0x[0-9a-f]{40}$/.test(e.a))).toBe(true);
  });

  it('a book without a stamp is ignored; a present-but-empty book stays [] (deliberate empty)', () => {
    const noStamp = sanitizeSyncDoc({ walls: [], watchBook: [{ a: ADDR }] });
    expect(noStamp).not.toHaveProperty('watchBook');

    // [] must survive as [] — "removed them all" is a real state, and only a
    // MISSING field may mean "pre-book client" (the PUT carry-forward keys
    // on exactly that distinction)
    const emptied = sanitizeSyncDoc({ walls: [], watchAddrAt: 1_000, watchBook: [] });
    expect(emptied.watchBook).toEqual([]);
    const garbage = sanitizeSyncDoc({ walls: [], watchAddrAt: 1_000, watchBook: [{ a: 'bad' }] });
    expect(garbage.watchBook).toEqual([]);
  });
});

describe('wall validation', () => {
  it.each([
    ['missing name', wall({ name: undefined })],
    ['empty name', wall({ name: '' })],
    ['name over 64 chars', wall({ name: 'x'.repeat(65) })],
    ['non-string name', wall({ name: 42 })],
    ['count 0', wall({ count: 0 })],
    ['count 25', wall({ count: 25 })],
    ['fractional count', wall({ count: 2.5 })],
    ['missing cells', wall({ cells: undefined })],
    ['over 24 cells', wall({ cells: Array.from({ length: 25 }, () => ({})) })],
  ])('rejects the whole doc on %s', (_label, w) => {
    expect(sanitizeSyncDoc({ walls: [w] })).toBeNull();
  });

  it('drops out-of-range cols instead of rejecting', () => {
    expect(sanitizeSyncDoc({ walls: [wall({ cols: 7 })] }).walls[0]).not.toHaveProperty('cols');
    expect(sanitizeSyncDoc({ walls: [wall({ cols: 0 })] }).walls[0]).not.toHaveProperty('cols');
    expect(sanitizeSyncDoc({ walls: [wall({ cols: 6 })] }).walls[0].cols).toBe(6);
  });
});

describe('timestamp clamping (a future stamp must never win merges forever)', () => {
  it('clamps future updatedAt/deletedAt to now', () => {
    const doc = sanitizeSyncDoc({ walls: [wall({ updatedAt: 9e15 })] });
    expect(doc.walls[0].updatedAt).toBeLessThanOrEqual(Date.now());
    const tomb = sanitizeSyncDoc({ walls: [{ name: 'w', deletedAt: 9e15 }] });
    expect(tomb.walls[0].deletedAt).toBeLessThanOrEqual(Date.now());
  });

  it('clamps negative stamps to 0 and drops non-finite ones', () => {
    expect(sanitizeSyncDoc({ walls: [wall({ updatedAt: -5 })] }).walls[0].updatedAt).toBe(0);
    expect(sanitizeSyncDoc({ walls: [wall({ updatedAt: 'x' })] }).walls[0]).not.toHaveProperty(
      'updatedAt',
    );
  });
});

describe('tombstones', () => {
  it('a deleted wall needs no count/cells and carries none through', () => {
    const doc = sanitizeSyncDoc({
      walls: [{ name: 'gone', deletedAt: 1_000, count: 999, cells: 'garbage' }],
    });
    expect(doc).not.toBeNull();
    expect(doc.walls[0]).toEqual({ name: 'gone', deletedAt: 1_000 });
  });
});

describe('cell scrubbing', () => {
  it('nulls oversized/malformed coins and defaults bad intervals to 1h', () => {
    // The coin cap is 96 = the client's canonical formula-id cap (a 4-leg
    // formula over 14-char HIP-3 ids is ~70 chars; a lower cap would
    // silently null it on the paired device). Length only, no charset — so a
    // 90-char formula coin survives regardless of what it looks like.
    const formula90 = `=${'x'.repeat(89)}`;
    expect(formula90).toHaveLength(90);
    const doc = sanitizeSyncDoc({
      walls: [
        wall({
          cells: [
            { coin: 'BTC', interval: '1h' },
            { coin: formula90, interval: '1h' },
            { coin: 'x'.repeat(96), interval: '1h' },
            { coin: 'x'.repeat(97), interval: '1m' },
            { coin: 123, interval: 'waytoolong' },
            null,
          ],
        }),
      ],
    });
    expect(doc.walls[0].cells).toEqual([
      { coin: 'BTC', interval: '1h' },
      { coin: formula90, interval: '1h' },
      { coin: 'x'.repeat(96), interval: '1h' },
      { coin: null, interval: '1m' },
      { coin: null, interval: '1h' },
      { coin: null, interval: '1h' },
    ]);
  });
});

// ── feedback notification MIME (worker/index.js feedbackMime)
//
// The message is user-typed text going into an email the worker composes, so
// the whole safety argument is "no user byte ever reaches a header raw". These
// tests are that argument: break the base64/encoded-word handling and one of
// them fails rather than a stranger's Bcc: line reaching the maintainer's
// mailbox.

const TO = 'owner@example.com';
const KEY = 'fb:1769000000000:a1b2c3d4e5f6';
const mimeOf = (m, at = 1_769_000_000_000) => feedbackMime({ m, at }, KEY, TO);
const split = (mime) => mime.indexOf('\r\n\r\n');
const headersOf = (mime) => mime.slice(0, split(mime));
const b64bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bodyOf = (mime) =>
  new TextDecoder().decode(b64bytes(mime.slice(split(mime) + 4).replace(/\r\n/g, '')));
const subjectWords = (mime) => [
  ...headersOf(mime).matchAll(/=\?utf-8\?B\?([A-Za-z0-9+/=]*)\?=/g),
].map((w) => w[1]);
const subjectOf = (mime) =>
  new TextDecoder().decode(
    Uint8Array.from(subjectWords(mime).flatMap((w) => [...b64bytes(w)])),
  );

describe('feedback notification MIME', () => {
  it('carries the message verbatim in the body and the KV key in the footer', () => {
    const body = bodyOf(mimeOf('the 1m interval is missing on mobile'));
    expect(body).toContain('the 1m interval is missing on mobile');
    expect(body).toContain(KEY);
    expect(body).toContain('2026-01-21 12:53 UTC');
  });

  it('round-trips non-ASCII through the body instead of mangling it', () => {
    expect(bodyOf(mimeOf('希望能加上价格提醒 🐾'))).toContain('希望能加上价格提醒 🐾');
  });

  it('puts a readable snippet in the subject', () => {
    expect(subjectOf(mimeOf('please add alerts'))).toBe('Purrwall: please add alerts');
    expect(subjectOf(mimeOf('希望能加上价格提醒'))).toBe('Purrwall: 希望能加上价格提醒');
  });

  it('flattens newlines out of the subject and truncates long ones', () => {
    const s = subjectOf(mimeOf(`first line\n\nsecond line ${'x'.repeat(200)}`));
    expect(s).not.toContain('\n');
    expect(s.startsWith('Purrwall: first line second line')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s.length).toBeLessThanOrEqual('Purrwall: '.length + 81);
  });

  it('never splits a multi-byte character across two encoded-words', () => {
    // Each word must decode standalone: a straddled character shows up as
    // U+FFFD, which is exactly the mojibake the code-point chunking prevents.
    const words = subjectWords(mimeOf(`Purrwall ${'中'.repeat(40)}`));
    expect(words.length).toBeGreaterThan(1); // otherwise the test proves nothing
    for (const w of words) {
      expect(new TextDecoder().decode(b64bytes(w))).not.toContain('�');
    }
  });

  it('cannot be made to inject a header', () => {
    const evil = 'hi\r\nBcc: attacker@evil.example\r\nX-Evil: 1\r\n\r\nfake body';
    const mime = mimeOf(evil);
    const headers = headersOf(mime);
    expect(headers).not.toMatch(/bcc|x-evil|attacker@evil/i);
    // exactly the headers we wrote, no extras smuggled in
    expect(headers.split('\r\n').filter((l) => /^[A-Za-z-]+:/.test(l))).toHaveLength(8);
    expect(bodyOf(mime)).toContain(evil); // …and nothing was lost doing it
  });

  it('keeps base64 body lines inside the 76-column limit', () => {
    const mime = mimeOf('x'.repeat(4000));
    for (const line of mime.slice(split(mime) + 4).split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });
});
