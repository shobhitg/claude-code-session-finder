/**
 * The file I/O half of the liveness engine, kept apart from state.ts so the pure classifier can be
 * bundled into the webviews (a browser bundle cannot import node:fs).
 */
import { open } from 'node:fs/promises';
import { readTailInfo, type TailInfo, type TailVerdict } from './state.js';

/**
 * L9: the live path reads as little of a transcript as it can (0.7 GB corpus, 21.8 MB max). 64 KB
 * covers almost every session; the windows widen geometrically while the tail holds nothing
 * conversational. That happens more than the first measurement suggested: one screenshot pasted or
 * read as an image is a 400 KB `tool_result` record, and a window whose first line is that record
 * drops it as partial and sees only sidecars — so the last step is the whole file.
 */
export const TAIL_WINDOW = 65_536;
export const TAIL_WIDE = 524_288;
export const TAIL_WINDOWS = [TAIL_WINDOW, TAIL_WIDE, 4 * TAIL_WIDE, Number.MAX_SAFE_INTEGER] as const;

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

/** Tail → verdict and context size, widening until a conversational record turns up or the whole file has been read (spec §7). */
export async function readTail_info(path: string, size: number, read: typeof readTail = readTail): Promise<TailInfo> {
  let info: TailInfo = { verdict: 'unknown' };
  for (const w of TAIL_WINDOWS) {
    info = readTailInfo(await read(path, size, w));
    if (info.verdict !== 'unknown' || size <= w) break;
  }
  return info;
}
export { readTail_info as readTailInfoFrom };

export async function readVerdict(path: string, size: number, read: typeof readTail = readTail): Promise<TailVerdict> {
  return (await readTail_info(path, size, read)).verdict;
}
