// scripts/make-fixtures.mjs
// Derives small, redacted fixtures from real ~/.claude/projects transcripts.
// Redaction: scrub-by-default, for both values and keys.
//   - STRUCTURAL keys' string values survive verbatim (tests assert on
//     cwd/gitBranch/etc); every other string value becomes lorem filler.
//   - Any object key that isn't a plain identifier (/^[A-Za-z_][A-Za-z0-9_]*$/)
//     is data-derived (e.g. a real file path used as a map key) and is
//     replaced with a deterministic redactedKeyN placeholder, numbered per
//     object so re-runs are byte-identical.
//   - Objects/arrays are recursed into (image blocks are stubbed).
//   - Numbers/booleans pass through unchanged. prUrl is dropped entirely.
//   - Unparseable lines are skipped, and the count is reported to stderr —
//     never dropped silently.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const STRUCTURAL = new Set(['type','role','userType','version','sessionId','uuid',
                            'parentUuid','leafUuid','timestamp','requestId','model',
                            'cwd','gitBranch','isSidechain']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function scrubText(s, i) {
  // deterministic filler that preserves length class but not content
  const words = ['alpha','bravo','charlie','delta','echo','foxtrot'];
  const n = Math.max(1, Math.min(12, Math.round(s.length / 20)));
  return Array.from({ length: n }, (_, k) => words[(i + k) % words.length]).join(' ');
}

// `structural` is true only for a string reached through a STRUCTURAL key;
// bare strings reached any other way (array elements have no key of their
// own) are scrubbed by default.
function scrub(node, i = 0, structural = false) {
  if (Array.isArray(node)) return node.map((v, k) => scrub(v, i + k, false));
  if (node && typeof node === 'object') {
    if (node.type === 'image') return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'XX' } };
    const out = {};
    let redactedKeyCount = 0;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'prUrl') continue; // drop entirely: embeds a real repo URL
      const key = IDENT.test(k) ? k : `redactedKey${redactedKeyCount++}`; // data-derived key (e.g. a real file path)
      if (typeof v === 'string') {
        out[key] = STRUCTURAL.has(k) ? v : scrubText(v, i);
      } else if (v && typeof v === 'object') {
        out[key] = scrub(v, i, false);
      } else {
        out[key] = v; // numbers, booleans, null pass through unchanged
      }
    }
    return out;
  }
  if (typeof node === 'string') return structural ? node : scrubText(node, i);
  return node;
}

const [, , src, dest, maxLines = '40'] = process.argv;
if (!src || !dest) { console.error('usage: make-fixtures.mjs <src.jsonl> <dest.jsonl> [maxLines]'); process.exit(1); }
mkdirSync(dirname(dest), { recursive: true });
const lines = readFileSync(src, 'utf8').split('\n').filter(Boolean).slice(0, Number(maxLines));
let skipped = 0;
const out = lines.map((l, i) => {
  try { return JSON.stringify(scrub(JSON.parse(l), i)); }
  catch { skipped++; return null; }
}).filter(Boolean);
writeFileSync(dest, out.join('\n') + '\n');
console.log(`${dest}: ${out.length} lines`);
console.error(`skipped ${skipped} unparseable line(s)`);
