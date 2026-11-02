#!/usr/bin/env node
// Release check. Runs at the end of `npm run build` and fails the build when
// the files that ship — dist/**, README.md and the brand/*.png images —
// contain something that does not belong in a release:
//   1. Generic patterns: absolute home paths, private IPv4 literals, email
//      addresses outside the allowlist below.
//   2. Image metadata: PNG ancillary text/EXIF chunks and JPEG EXIF/XMP —
//      screenshots and exports can carry device details in metadata.
//   3. Optional local terms: `.release-terms.local` (ignored by git through
//      `*.local`; one term per line, # starts a comment). When that file
//      exists, this machine's username, home directory name and hostname
//      are checked too. They are derived at runtime, never written into this
//      file, and skipped when CI is set: builder identities (root, runner…)
//      substring-match innocent bundle content (':root' in CSS).
//
// Exit 0 = clean, exit 1 = findings listed (build fails). No deps.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { userInfo, homedir, hostname } from 'node:os';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEXT_EXT = new Set(['.js', '.css', '.html', '.json', '.svg', '.webmanifest', '.txt', '.xml', '.md', '.map']);
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg']);
const EMAIL_ALLOW = [/@purrwall\.xyz$/i, /@users\.noreply\.github\.com$/i];

const findings = [];

// --- 3: optional local terms ------------------------------------------
const terms = new Set();
const addTerm = (t) => {
  const s = String(t ?? '').trim().toLowerCase();
  if (s.length >= 4) terms.add(s); // <4 chars = false-positive machine
};
const localTermsPath = join(ROOT, '.release-terms.local');
if (existsSync(localTermsPath)) {
  for (const line of readFileSync(localTermsPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#')) addTerm(t);
  }
  if (!process.env.CI) {
    try {
      addTerm(userInfo().username);
    } catch {
      /* sandboxes may lack a user db */
    }
    addTerm(basename(homedir()));
    const host = hostname();
    addTerm(host);
    addTerm(host.replace(/\.local$/i, ''));
  }
}

// --- generic patterns ---------------------------------------------------
const PATTERNS = [
  { name: 'home path', re: /\/(?:Users|home)\/[A-Za-z0-9._-]{3,}/g },
  {
    name: 'private IP',
    re: /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2}\b/g,
  },
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g },
];

function scanText(file, content) {
  const lower = content.toLowerCase();
  for (const term of terms) {
    let idx = lower.indexOf(term);
    while (idx !== -1) {
      findings.push(`${file}: local term "${term}" at offset ${idx}`);
      idx = lower.indexOf(term, idx + term.length);
      if (findings.length > 50) return; // enough to fail; don't flood
    }
  }
  for (const { name, re } of PATTERNS) {
    for (const m of content.matchAll(re)) {
      if (name === 'email' && EMAIL_ALLOW.some((a) => a.test(m[0]))) continue;
      findings.push(`${file}: ${name} "${m[0]}"`);
      if (findings.length > 50) return;
    }
  }
}

// --- 2: image metadata ----------------------------------------------------
// Dispatch by MAGIC BYTES, never extension — a JPEG renamed .png must not
// slip its EXIF through. Unknown container = finding (fail closed).
// PNG: only critical chunks + safe ancillary pixels-only chunks may ship
// ('iDOT' is Apple's parallel-decode hint — lowercase i, pixels only).
const PNG_OK = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'pHYs', 'iDOT']);
function scanPng(file, buf) {
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (off + 12 + len > buf.length) {
      findings.push(`${file}: malformed PNG chunk (declared ${len}B past EOF) — re-encode it`);
      return;
    }
    const type = buf.toString('latin1', off + 4, off + 8);
    if (!PNG_OK.has(type)) findings.push(`${file}: PNG metadata chunk "${type}" (${len}B) — strip it`);
    off += 12 + len;
    if (type === 'IEND') {
      if (off < buf.length) findings.push(`${file}: ${buf.length - off}B trailing data after IEND — strip it`);
      return;
    }
  }
}
function scanJpeg(file, buf) {
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) break;
    const marker = buf[off + 1];
    if (marker === 0xda) break; // start of scan — pixel data
    const len = buf.readUInt16BE(off + 2);
    // APP1 = EXIF/XMP, APP13 = Photoshop IRB, COM = freetext comments
    if (marker === 0xe1 || marker === 0xed || marker === 0xfe) {
      const head = buf.toString('latin1', off + 4, off + 4 + Math.min(24, len));
      const name = marker === 0xfe ? 'COM' : `APP${marker & 0xf}`;
      findings.push(`${file}: JPEG ${name} metadata ("${head.split('\0')[0]}") — strip it`);
    }
    off += 2 + len;
  }
}
function scanImage(file, buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) scanPng(file, buf);
  else if (buf.length >= 2 && buf.readUInt16BE(0) === 0xffd8) scanJpeg(file, buf);
  else findings.push(`${file}: unrecognized image container (magic mismatch) — inspect manually`);
}

// --- walk -----------------------------------------------------------------
function scanFile(path, rel) {
  const ext = extname(path).toLowerCase();
  if (TEXT_EXT.has(ext)) scanText(rel, readFileSync(path, 'utf8'));
  else if (IMG_EXT.has(ext)) scanImage(rel, readFileSync(path));
}
function walk(dir, rel) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const r = `${rel}/${name}`;
    if (statSync(p).isDirectory()) walk(p, r);
    else scanFile(p, r);
  }
}

const dist = join(ROOT, 'dist');
if (!existsSync(dist)) {
  console.error('release-check: dist/ missing — run after vite build');
  process.exit(1);
}
walk(dist, 'dist');
scanFile(join(ROOT, 'README.md'), 'README.md');
const brand = join(ROOT, 'brand');
if (existsSync(brand)) {
  for (const name of readdirSync(brand)) {
    if (IMG_EXT.has(extname(name).toLowerCase())) scanFile(join(brand, name), `brand/${name}`);
  }
}

if (findings.length > 0) {
  console.error(`release-check: ${findings.length} finding(s) — build BLOCKED\n`);
  for (const f of findings) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`release-check: clean${terms.size ? ` (${terms.size} local terms)` : ''}`);
