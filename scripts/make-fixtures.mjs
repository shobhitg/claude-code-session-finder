// scripts/make-fixtures.mjs
// Derives small, redacted fixtures from real ~/.claude/projects transcripts.
// Redaction: replaces all prose text with lorem tokens EXCEPT an allow-list of
// structural fields, and drops every base64 image payload.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const KEEP = new Set(['type','cwd','gitBranch','timestamp','sessionId','uuid',
                      'parentUuid','isSidechain','aiTitle','prNumber','prUrl','message','role','content']);

function scrubText(s, i) {
  // deterministic filler that preserves length class but not content
  const words = ['alpha','bravo','charlie','delta','echo','foxtrot'];
  const n = Math.max(1, Math.min(12, Math.round(s.length / 20)));
  return Array.from({ length: n }, (_, k) => words[(i + k) % words.length]).join(' ');
}

function scrub(node, i = 0) {
  if (Array.isArray(node)) return node.map((v, k) => scrub(v, i + k));
  if (node && typeof node === 'object') {
    if (node.type === 'image') return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'XX' } };
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (!KEEP.has(k) && typeof v === 'object') continue;      // drop bulky non-structural objects
      if (!KEEP.has(k) && typeof v === 'string' && v.length > 100) continue; // drop long non-structural blobs (e.g. thinking signatures)
      out[k] = (k === 'text' || (k === 'content' && typeof v === 'string')) ? scrubText(v, i) : scrub(v, i);
    }
    return out;
  }
  return node;
}

const [, , src, dest, maxLines = '40'] = process.argv;
if (!src || !dest) { console.error('usage: make-fixtures.mjs <src.jsonl> <dest.jsonl> [maxLines]'); process.exit(1); }
mkdirSync(dirname(dest), { recursive: true });
const lines = readFileSync(src, 'utf8').split('\n').filter(Boolean).slice(0, Number(maxLines));
const out = lines.map((l, i) => { try { return JSON.stringify(scrub(JSON.parse(l), i)); } catch { return null; } }).filter(Boolean);
writeFileSync(dest, out.join('\n') + '\n');
console.log(`${dest}: ${out.length} lines`);
