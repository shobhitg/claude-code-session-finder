// scripts/make-fixtures.mjs
// Derives small, redacted fixtures from real ~/.claude/projects transcripts.
// Redaction: scrub-by-default. Only a fixed set of STRUCTURAL keys keep their
// string values verbatim (tests assert on cwd/gitBranch/etc); every other
// string value is replaced with lorem filler. Objects/arrays are recursed
// into (except image blocks, which are stubbed). Numbers/booleans pass
// through unchanged. prUrl is dropped entirely (embeds a real repo URL).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const STRUCTURAL = new Set(['type','role','userType','version','sessionId','uuid',
                            'parentUuid','leafUuid','timestamp','requestId','model',
                            'cwd','gitBranch','isSidechain']);

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
    for (const [k, v] of Object.entries(node)) {
      if (k === 'prUrl') continue; // drop entirely: embeds a real repo URL
      if (typeof v === 'string') {
        out[k] = STRUCTURAL.has(k) ? v : scrubText(v, i);
      } else if (v && typeof v === 'object') {
        out[k] = scrub(v, i, false);
      } else {
        out[k] = v; // numbers, booleans, null pass through unchanged
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
const out = lines.map((l, i) => { try { return JSON.stringify(scrub(JSON.parse(l), i)); } catch { return null; } }).filter(Boolean);
writeFileSync(dest, out.join('\n') + '\n');
console.log(`${dest}: ${out.length} lines`);
