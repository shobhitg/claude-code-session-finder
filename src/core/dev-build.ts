// A dev build is the working tree packaged by `npm run try` (scripts/try-local.mjs) and installed over
// the Marketplace copy. Its version carries the build time; the Marketplace refuses pre-release
// versions, so a published build never looks like one. No imports: the script loads this file with
// plain Node, not through the bundler.

/** "0.7.1" (released) → "0.7.2-dev.202609241712": above everything published, below the next release. */
export function devVersion(version: string, released: boolean, now: Date): string {
  const [major, minor, patch] = version.split('.');
  const base = released ? `${major}.${minor}.${Number(patch) + 1}` : version;
  const stamp = now.toISOString().slice(0, 16).replace(/\D/g, '');     // YYYYMMDDHHMM, UTC
  return `${base}-dev.${stamp}`;
}

/** The status bar's marker: "dev 17:12" on a dev build, nothing on a Marketplace one. */
export function devBuildLabel(version: string): string | undefined {
  const m = /-dev\.\d{8}(\d{2})(\d{2})$/.exec(version);
  return m ? `dev ${m[1]}:${m[2]}` : undefined;
}
