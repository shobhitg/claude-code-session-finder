// scripts/check-fixtures.mjs
// Durable leak checker for redacted fixtures (companion to make-fixtures.mjs).
// Exits non-zero if any fixture leaks real transcript content:
//   - a string value that is neither a STRUCTURAL key's verbatim value nor
//     pure filler tokens
//   - any string >=100 chars (e.g. a base64 blob)
//   - a non-identifier object key (a data-derived key, e.g. a real file path)
//   - a prUrl key (should always be dropped by make-fixtures.mjs)
// Usage: node scripts/check-fixtures.mjs <file.jsonl> ...
import { readFileSync } from 'node:fs';

const STRUCTURAL = new Set(['type','role','userType','version','sessionId','uuid',
                            'parentUuid','leafUuid','timestamp','requestId','model',
                            'cwd','gitBranch','isSidechain']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FILLER = new Set(['alpha','bravo','charlie','delta','echo','foxtrot']);
// The only non-STRUCTURAL string values make-fixtures.mjs ever emits verbatim:
// the fixed image-block stub `{ source: { media_type: 'image/png', data: 'XX' } }`.
const SAFE_CONSTANTS = new Set(['image/png', 'XX']);

function isFiller(s) {
  const words = s.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => FILLER.has(w.toLowerCase()));
}

// Yields findings for every key and every string value in the tree. Array
// elements have no key of their own, so they're reported with key: null,
// which never matches STRUCTURAL and so must be filler.
function* walk(node) {
  if (Array.isArray(node)) {
    for (const v of node) {
      if (typeof v === 'string') yield { key: null, value: v };
      else yield* walk(v);
    }
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (!IDENT.test(k)) yield { badKey: k };
      if (k === 'prUrl') yield { prUrl: true };
      if (typeof v === 'string') yield { key: k, value: v };
      else yield* walk(v);
    }
  }
}

const files = process.argv.slice(2);
if (files.length === 0) { console.error('usage: node scripts/check-fixtures.mjs <file.jsonl> ...'); process.exit(1); }

let leakCount = 0;
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  lines.forEach((line, idx) => {
    let d;
    try { d = JSON.parse(line); } catch { return; }
    for (const f of walk(d)) {
      if (f.badKey !== undefined) {
        leakCount++;
        console.error(`${file}:${idx + 1}: non-identifier key ${JSON.stringify(f.badKey)}`);
      } else if (f.prUrl) {
        leakCount++;
        console.error(`${file}:${idx + 1}: prUrl key present`);
      } else if (f.value !== undefined) {
        const label = f.key ?? '(array element)';
        if (f.value.length >= 100) {
          leakCount++;
          console.error(`${file}:${idx + 1}: string >=100 chars under key ${label}`);
        } else if (f.key && STRUCTURAL.has(f.key)) {
          // verbatim allowed for STRUCTURAL keys
        } else if (SAFE_CONSTANTS.has(f.value)) {
          // known fixed image-stub constant, not real content
        } else if (!isFiller(f.value)) {
          leakCount++;
          console.error(`${file}:${idx + 1}: non-filler string under key ${label}: ${JSON.stringify(f.value.slice(0, 60))}`);
        }
      }
    }
  });
}

if (leakCount > 0) {
  console.error(`${leakCount} leak(s) found`);
  process.exit(1);
}
console.log(`0 leaks across ${files.length} file(s)`);
