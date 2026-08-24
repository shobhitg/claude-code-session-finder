// scripts/check-fixtures.mjs
// Durable leak checker for redacted fixtures (companion to make-fixtures.mjs).
// Exits non-zero if any fixture leaks real transcript content:
//   - a string value that is neither a STRUCTURAL key's verbatim value, nor
//     a positionally-verified image-stub constant, nor pure filler tokens
//   - any string >=100 chars (e.g. a base64 blob)
//   - a non-identifier object key (a data-derived key, e.g. a real file path)
//   - any key of a DATA_KEYED_MAPS object that isn't a redactedKeyN
//     placeholder (these keys are ALWAYS data — e.g. trackedFileBackups can
//     be keyed by a bare filename like "Makefile", which passes the plain
//     identifier test but is still real repo structure). Keep this set
//     identical to the one in make-fixtures.mjs, or this checker shares the
//     generator's blind spot instead of catching a regression in it.
//   - a prUrl key (should always be dropped by make-fixtures.mjs)
// Usage: node scripts/check-fixtures.mjs <file.jsonl> ...
import { readFileSync } from 'node:fs';

const STRUCTURAL = new Set(['type','role','userType','version','sessionId','uuid',
                            'parentUuid','leafUuid','timestamp','requestId','model',
                            'cwd','gitBranch','isSidechain']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REDACTED_KEY = /^redactedKey\d+$/;
const DATA_KEYED_MAPS = new Set(['trackedFileBackups']);
const FILLER = new Set(['alpha','bravo','charlie','delta','echo','foxtrot']);
// The only non-STRUCTURAL string values make-fixtures.mjs ever emits verbatim:
// the fixed image-block stub `{ type: 'image', source: { type: 'base64',
// media_type: 'image/png', data: 'XX' } }`. Scoped by position (only inside a
// `source` object whose sibling `type` is 'base64' and whose parent's `type`
// is 'image'), not by value alone — otherwise an unrelated field that merely
// happens to equal "XX" or "image/png" anywhere in the tree would pass.
const SAFE_IMAGE_FIELD = { media_type: 'image/png', data: 'XX' };

function isFiller(s) {
  const words = s.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => FILLER.has(w.toLowerCase()));
}

// Yields findings for every key and every string value in the tree.
// - forceKeys: this object's own keys came from a DATA_KEYED_MAPS field, so
//   every key must be a redactedKeyN placeholder, not just an identifier.
// - imageStubSource: this object is the `source` of a `{ type: 'image' }`
//   block whose own `type` is 'base64' — the one place media_type/data are
//   allowed to carry the fixed stub constants.
// Array elements have no key of their own, so they're reported with
// key: null, which never matches STRUCTURAL and so must be filler.
function* walk(node, forceKeys = false, imageStubSource = false) {
  if (Array.isArray(node)) {
    for (const v of node) {
      if (typeof v === 'string') yield { key: null, value: v, safe: false };
      else yield* walk(v, false, false);
    }
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (forceKeys) {
        if (!REDACTED_KEY.test(k)) yield { badKey: k };
      } else if (!IDENT.test(k)) {
        yield { badKey: k };
      }
      if (k === 'prUrl') yield { prUrl: true };
      if (typeof v === 'string') {
        const safe = imageStubSource && SAFE_IMAGE_FIELD[k] === v;
        yield { key: k, value: v, safe };
      } else {
        const childForceKeys = DATA_KEYED_MAPS.has(k);
        const childIsImageSource = k === 'source' && node.type === 'image'
          && v && typeof v === 'object' && v.type === 'base64';
        yield* walk(v, childForceKeys, childIsImageSource);
      }
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
        console.error(`${file}:${idx + 1}: non-identifier or non-redacted data-map key ${JSON.stringify(f.badKey)}`);
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
        } else if (f.safe) {
          // positionally-verified image-stub constant, not real content
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
