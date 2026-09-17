/**
 * The file I/O half of the liveness engine, kept apart from state.ts so the pure classifier can be
 * bundled into the webviews (a browser bundle cannot import node:fs).
 */
import { open } from 'node:fs/promises';
import { classifyTail, type TailVerdict } from './state.js';

/**
 * L9: the live path never reads a whole transcript (0.7 GB corpus, 21.8 MB max). 64 KB covered
 * every session measured; widened once to 512 KB when the tail is all sidecars.
 */
export const TAIL_WINDOW = 65_536;
export const TAIL_WIDE = 524_288;

/**
 * The last `window` bytes of a file. When the file is longer than the window the first line is
 * (almost always) cut in half, so it is dropped; the caller only needs the records after it.
 */
export async function readTail(path: string, size: number, window: number = TAIL_WINDOW): Promise<string> {
  const len = Math.min(window, size);
  if (len === 0) return '';
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, size - len);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    if (size <= window) return text;
    const nl = text.indexOf('\n');
    return nl < 0 ? '' : text.slice(nl + 1);
  } finally {
    await fh.close();
  }
}

/** Tail → verdict, widening once (spec §7 `unknown` row). `read` is injectable for tests. */
export async function readVerdict(path: string, size: number, read: typeof readTail = readTail): Promise<TailVerdict> {
  let v = classifyTail(await read(path, size, TAIL_WINDOW));
  if (v === 'unknown' && size > TAIL_WINDOW) v = classifyTail(await read(path, size, TAIL_WIDE));
  return v;
}
