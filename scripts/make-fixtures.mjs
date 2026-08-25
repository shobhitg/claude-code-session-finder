// scripts/make-fixtures.mjs
// Derives small, redacted fixtures from real ~/.claude/projects transcripts.
// Redaction: scrub-by-default, for keys AND for every kind of value.
//   - STRUCTURAL keys' string values survive verbatim (tests assert on
//     cwd/gitBranch/etc); every other string value becomes lorem filler.
//   - NUMBERS are scrubbed to PLACEHOLDER_ZERO. Verbatim numbers are content:
//     a PR number identifies a private repo, and structuredPatch line ranges
//     (oldStart/newStart/…) plus totalLines/startLine/numLines fingerprint a
//     real diff to real private files, correlatable with the verbatim
//     timestamps. NUMERIC_STRUCTURAL names the keys whose value must stay a
//     NUMBER for the tests to work (prNumber has to keep parsing as a
//     pr-link); those get PLACEHOLDER_NUM — a number, but never the real one.
//   - BOOLEANS are scrubbed to false except BOOLEAN_STRUCTURAL, which is the
//     one flag extraction reads (isSidechain, which decides subagent prose).
//   - Any object key that isn't a plain identifier (/^[A-Za-z_][A-Za-z0-9_]*$/)
//     is data-derived (e.g. a real file path used as a map key) and is
//     replaced with a deterministic redactedKeyN placeholder, numbered per
//     object so re-runs are byte-identical.
//   - DATA_KEYED_MAPS: objects whose keys are ALWAYS data, never a schema
//     identifier, even when a key happens to look like one (e.g. a bare
//     filename like "Makefile" or "Dockerfile" passes the identifier
//     regex). Every key of such an object is force-redacted regardless of
//     shape.
//   - Objects/arrays are recursed into (image blocks are stubbed).
//   - prUrl is dropped entirely.
//   - Unparseable lines are skipped, and the count is reported to stderr —
//     never dropped silently.
// Keep STRUCTURAL / NUMERIC_STRUCTURAL / BOOLEAN_STRUCTURAL / DATA_KEYED_MAPS
// and the placeholders identical to the ones in check-fixtures.mjs — that
// checker verifies exactly these rules, so if the two drift the checker stops
// being able to catch a regression here.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// PATH_SHAPED structural keys keep their SHAPE (absolute, nesting depth, and whether
// one path is nested inside another) because tests assert on those properties — but
// their SEGMENTS are pseudonymised, because real cwd/branch values disclose private
// project, worktree and customer names. Mapping is deterministic and order-stable, so
// two files that shared a real path still share the pseudonym and stay distinguishable.
const PATH_SHAPED = new Set(['cwd', 'gitBranch']);
// Deliberately short: a deeply nested real path must still pseudonymise to under the
// 100-character ceiling the gate enforces on every string value.
const SAFE_SEGMENTS = ['dir', 'proj', 'wt', 'sub'];
const segmentMap = new Map();
function pseudonymSegment(seg) {
  if (seg === '' || seg === '.' || seg === '..') return seg;
  if (/^\.[a-z]+$/i.test(seg)) return seg;              // keep dot-dirs like .claude structural
  if (!segmentMap.has(seg)) {
    segmentMap.set(seg, SAFE_SEGMENTS[segmentMap.size % SAFE_SEGMENTS.length] + (segmentMap.size + 1));
  }
  return segmentMap.get(seg);
}
function pseudonymPath(v) {
  if (v === 'HEAD' || v === 'main' || v === 'master') return v;   // generic, disclose nothing
  return v.split('/').map(pseudonymSegment).join('/');
}

const STRUCTURAL = new Set(['type','role','userType','version','sessionId','uuid',
                            'parentUuid','leafUuid','timestamp','requestId','model',
                            'cwd','gitBranch','isSidechain']);
const NUMERIC_STRUCTURAL = new Set(['prNumber']);
const BOOLEAN_STRUCTURAL = new Set(['isSidechain']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DATA_KEYED_MAPS = new Set(['trackedFileBackups']);
const PLACEHOLDER_ZERO = 0;
const PLACEHOLDER_NUM = 1;

function scrubText(s, i) {
  // deterministic filler that preserves length class but not content
  const words = ['alpha','bravo','charlie','delta','echo','foxtrot'];
  const n = Math.max(1, Math.min(12, Math.round(s.length / 20)));
  return Array.from({ length: n }, (_, k) => words[(i + k) % words.length]).join(' ');
}

// `structural` is true only for a string reached through a STRUCTURAL key;
// bare strings reached any other way (array elements have no key of their
// own) are scrubbed by default. `forceKeys` is true when this object's own
// keys came from a DATA_KEYED_MAPS field — every key gets redacted then,
// skipping the identifier test entirely.
function scrub(node, i = 0, structural = false, forceKeys = false) {
  if (Array.isArray(node)) return node.map((v, k) => scrub(v, i + k, false, false));
  if (node && typeof node === 'object') {
    if (node.type === 'image') return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'XX' } };
    const out = {};
    let redactedKeyCount = 0;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'prUrl') continue; // drop entirely: embeds a real repo URL
      const mustRedact = forceKeys || !IDENT.test(k);
      const key = mustRedact ? `redactedKey${redactedKeyCount++}` : k; // data-derived key (e.g. a real file path or filename)
      const childForceKeys = DATA_KEYED_MAPS.has(k);
      if (typeof v === 'string') {
        out[key] = STRUCTURAL.has(k)
          ? (PATH_SHAPED.has(k) ? pseudonymPath(v) : v)
          : scrubText(v, i);
      } else if (typeof v === 'number') {
        out[key] = NUMERIC_STRUCTURAL.has(k) ? PLACEHOLDER_NUM : PLACEHOLDER_ZERO;
      } else if (typeof v === 'boolean') {
        out[key] = BOOLEAN_STRUCTURAL.has(k) ? v : false;
      } else if (v && typeof v === 'object') {
        out[key] = scrub(v, i, false, childForceKeys);
      } else {
        out[key] = v; // null
      }
    }
    return out;
  }
  // Bare primitives (array elements) have no key, so nothing can allow-list them.
  if (typeof node === 'string') return structural ? node : scrubText(node, i);
  if (typeof node === 'number') return PLACEHOLDER_ZERO;
  if (typeof node === 'boolean') return false;
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
