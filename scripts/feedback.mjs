#!/usr/bin/env node
// `npm run feedback`: lists the FEEDBACK KV namespace (what /api/feedback
// writes) and prints each record — `{ m, at }` — with its key, oldest-first.
//
// Auth rides wrangler's own OAuth login: run `npx wrangler login` once; no API
// token is needed.
//
// Records expire on their own after 90 days. To clear one early:
//   npx wrangler kv key delete "<key>" --namespace-id <id> --remote
//
// NOTE: `--remote` is required. Recent wrangler defaults kv commands to LOCAL
// state and reports a full namespace as empty.

import { execFileSync } from 'node:child_process';

// Same id as the FEEDBACK binding in wrangler.jsonc.
const NAMESPACE_ID = 'ed77293d57ee405987fa9f4f84e5b97a';

const wrangler = (args) =>
  execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

/** wrangler prints a banner around the JSON; take the outermost bracketed run. */
function parseJson(out, open, close) {
  const start = out.indexOf(open);
  const end = out.lastIndexOf(close);
  if (start === -1 || end === -1) throw new Error(`no JSON in wrangler output:\n${out}`);
  return JSON.parse(out.slice(start, end + 1));
}

let keys;
try {
  keys = parseJson(wrangler(['kv', 'key', 'list', '--namespace-id', NAMESPACE_ID, '--remote']), '[', ']');
} catch (err) {
  console.error('Could not list feedback. Is `npx wrangler login` done?\n', err.message);
  process.exit(1);
}

if (keys.length === 0) {
  console.log('No feedback yet.');
  process.exit(0);
}

// Keys are `fb:<epoch ms>:<random>`, so sorting on the timestamp segment gives
// chronological order without fetching anything.
keys.sort((a, b) => Number(a.name.split(':')[1] ?? 0) - Number(b.name.split(':')[1] ?? 0));

console.log(`${keys.length} message${keys.length === 1 ? '' : 's'}\n`);
for (const { name } of keys) {
  let doc;
  try {
    doc = parseJson(wrangler(['kv', 'key', 'get', name, '--namespace-id', NAMESPACE_ID, '--remote']), '{', '}');
  } catch {
    console.log(`── ${name}  (unreadable, skipped)\n`);
    continue;
  }
  const when = new Date(doc.at ?? Number(name.split(':')[1])).toISOString().replace('T', ' ').slice(0, 16);
  console.log(`── ${when} UTC   ${name}`);
  // The text is untrusted: neutralise terminal control characters (keeping
  // newline and tab) so a message cannot rewrite or recolour the output.
  // eslint-disable-next-line no-control-regex
  console.log(`${String(doc.m).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '\ufffd')}\n`);
}
