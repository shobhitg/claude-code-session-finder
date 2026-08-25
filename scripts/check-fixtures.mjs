// scripts/check-fixtures.mjs
// Durable leak checker for redacted fixtures (companion to make-fixtures.mjs).
// Exits non-zero if any fixture leaks real transcript content:
//   - a string value that is neither a STRUCTURAL key's verbatim value, nor
//     a positionally-verified image-stub constant, nor pure filler tokens
//   - any string >=100 chars (e.g. a base64 blob)
//   - a NUMBER that isn't its placeholder. Numbers are content too: a PR
//     number identifies a private repo, and structuredPatch line ranges
//     fingerprint a real diff. NUMERIC_STRUCTURAL keys must be
//     PLACEHOLDER_NUM (still a number, so extraction still parses them);
//     every other number must be PLACEHOLDER_ZERO.
//   - a BOOLEAN that is true under a key outside BOOLEAN_STRUCTURAL
//   - a non-identifier object key (a data-derived key, e.g. a real file path)
//   - any key of a DATA_KEYED_MAPS object that isn't a redactedKeyN
//     placeholder (these keys are ALWAYS data — e.g. trackedFileBackups can
//     be keyed by a bare filename like "Makefile", which passes the plain
//     identifier test but is still real repo structure).
//   - a prUrl key (should always be dropped by make-fixtures.mjs)
//   - a line that cannot be parsed at all: unreviewable content is a leak
//     until proven otherwise, never a silent skip.
// Keep every allow-list here identical to the ones in make-fixtures.mjs, or
// this checker shares the generator's blind spot instead of catching a
// regression in it.
// Usage: node scripts/check-fixtures.mjs <file.jsonl | dir> ...
//        Directories are walked RECURSIVELY — a fixture parked in a
//        subdirectory must not slip past the gate.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PATH_SHAPED = new Set(['cwd', 'gitBranch']);
const STRUCTURAL = new Set(['type','role','userType','version','sessionId','uuid',
                            'parentUuid','leafUuid','timestamp','requestId','model',
                            'cwd','gitBranch','isSidechain']);
const NUMERIC_STRUCTURAL = new Set(['prNumber']);
const BOOLEAN_STRUCTURAL = new Set(['isSidechain']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REDACTED_KEY = /^redactedKey\d+$/;
const DATA_KEYED_MAPS = new Set(['trackedFileBackups']);
const FILLER = new Set(['alpha','bravo','charlie','delta','echo','foxtrot']);
const PLACEHOLDER_ZERO = 0;
const PLACEHOLDER_NUM = 1;
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

/** Every .jsonl under `target`, recursively when it is a directory. */
function expand(target) {
  if (!statSync(target).isDirectory()) return [target];
  const out = [];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const p = join(target, entry.name);
    if (entry.isDirectory()) out.push(...expand(p));
    else if (entry.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Yields findings for every key and every primitive value in the tree.
// - forceKeys: this object's own keys came from a DATA_KEYED_MAPS field, so
//   every key must be a redactedKeyN placeholder, not just an identifier.
// - imageStubSource: this object is the `source` of a `{ type: 'image' }`
//   block whose own `type` is 'base64' — the one place media_type/data are
//   allowed to carry the fixed stub constants.
// Array elements have no key of their own, so they're reported with
// key: null, which never matches any allow-list.
function* walk(node, forceKeys = false, imageStubSource = false) {
  if (Array.isArray(node)) {
    for (const v of node) {
      if (v !== null && typeof v !== 'object') yield { key: null, value: v, safe: false };
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
      if (v !== null && typeof v !== 'object') {
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

const targets = process.argv.slice(2);
if (targets.length === 0) { console.error('usage: node scripts/check-fixtures.mjs <file.jsonl | dir> ...'); process.exit(1); }
const files = targets.flatMap(expand);
if (files.length === 0) { console.error(`no .jsonl files found under ${targets.join(', ')}`); process.exit(1); }

let leakCount = 0;
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  lines.forEach((line, idx) => {
    const where = `${file}:${idx + 1}`;
    let d;
    try { d = JSON.parse(line); } catch (err) {
      // Never `catch { return }`: a line this gate cannot read is a line
      // nobody has reviewed.
      leakCount++;
      console.error(`${where}: unparseable line, cannot be checked (${err.message})`);
      return;
    }
    for (const f of walk(d)) {
      if (f.badKey !== undefined) {
        leakCount++;
        console.error(`${where}: non-identifier or non-redacted data-map key ${JSON.stringify(f.badKey)}`);
      } else if (f.prUrl) {
        leakCount++;
        console.error(`${where}: prUrl key present`);
      } else if (typeof f.value === 'number') {
        const want = f.key && NUMERIC_STRUCTURAL.has(f.key) ? PLACEHOLDER_NUM : PLACEHOLDER_ZERO;
        if (f.value !== want) {
          leakCount++;
          console.error(`${where}: unscrubbed number under key ${f.key ?? '(array element)'}: ${f.value} (expected ${want})`);
        }
      } else if (typeof f.value === 'boolean') {
        if (f.value && !(f.key && BOOLEAN_STRUCTURAL.has(f.key))) {
          leakCount++;
          console.error(`${where}: unscrubbed boolean true under key ${f.key ?? '(array element)'}`);
        }
      } else if (typeof f.value === 'string') {
        const label = f.key ?? '(array element)';
        if (f.value.length >= 100) {
          leakCount++;
          console.error(`${where}: string >=100 chars under key ${label}`);
        } else if (f.key && PATH_SHAPED.has(f.key)) {
          // Keep in sync with make-fixtures.mjs: every segment must be a generated
          // pseudonym (safeword + digits), a dot-dir, or a generic branch name.
          const ok = f.value === 'HEAD' || f.value === 'main' || f.value === 'master' ||
            f.value.split('/').every(seg => seg === '' || /^\.[a-z]+$/i.test(seg) ||
                                            /^[a-z]+[0-9]+$/.test(seg));
          if (!ok) {
            leakCount++;
            console.error(`${where}: un-pseudonymised path value under key ${f.key}: ${JSON.stringify(f.value)}`);
          }
        } else if (f.key && STRUCTURAL.has(f.key)) {
          // verbatim allowed for STRUCTURAL keys
        } else if (f.safe) {
          // positionally-verified image-stub constant, not real content
        } else if (!isFiller(f.value)) {
          leakCount++;
          console.error(`${where}: non-filler string under key ${label}: ${JSON.stringify(f.value.slice(0, 60))}`);
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
