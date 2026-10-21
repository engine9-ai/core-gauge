/*
  The gauge disk log (Node).

  Layout:  <directory>/YYYY/MM/DD/HH-<host>-<pid>.jsonl
  One writer per file, so no two processes ever interleave a line. A file is
  hourly (UTC). A segment's logical name is its path without ".gz": when the
  loader is done with a closed segment it gzips it, and a reader treats
  `x.jsonl` and `x.jsonl.gz` as the same segment with the same byte offsets
  (offsets are into the uncompressed text).

  fsync:
    always    every append waits for fsync. Slowest, nothing acknowledged is lost.
    interval  fsync about once a second. A power loss can lose about a second of
              hits that were already acknowledged; a process crash loses nothing.
    none      leave it to the operating system.

  The collector answers 204 only after append() resolves. If it rejects, the
  collector answers 503 and the client retries with the same hit ids.
*/
import fs from 'node:fs';
import { open, mkdir, readdir, stat, unlink, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** `YYYY/MM/DD/HH` for a date (UTC). Sorts by time. */
export function hourPrefix(date) {
  return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}/${pad(date.getUTCHours())}`;
}

/** `YYYY/MM/DD/HH-<host>-<pid>.jsonl` for a date. */
export function segmentName(date, { hostId, pid }) {
  const dir = hourPrefix(date).split('/').slice(0, 3).join('/');
  return `${dir}/${pad(date.getUTCHours())}-${hostId}-${pid}.jsonl`;
}

function sanitize(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'host';
}

/** The hour prefix (`YYYY/MM/DD/HH`) a logical segment name belongs to. */
export function segmentHour(logical) {
  const parts = logical.split('/');
  if (parts.length < 4) return null;
  return `${parts[0]}/${parts[1]}/${parts[2]}/${parts[3].slice(0, 2)}`;
}

export function createDiskLog({
  directory,
  fsync = 'interval',
  fsyncIntervalMs = 1000,
  hostId = os.hostname(),
  pid = process.pid,
  clock = () => new Date()
} = {}) {
  if (!directory) throw new Error('createDiskLog requires a directory');
  const id = { hostId: sanitize(hostId), pid };
  let handle = null;
  let handleName = null;
  let dirty = false;
  let chain = Promise.resolve();
  let timer = null;
  let closed = false;

  async function closeHandle() {
    if (!handle) return;
    const h = handle;
    handle = null;
    handleName = null;
    try {
      if (dirty && fsync !== 'none') await h.sync();
    } finally {
      dirty = false;
      await h.close();
    }
  }

  async function ensureHandle() {
    const name = segmentName(clock(), id);
    if (handle && handleName === name) return;
    await closeHandle();
    const full = path.join(directory, name);
    await mkdir(path.dirname(full), { recursive: true });
    handle = await open(full, 'a');
    handleName = name;
  }

  function startTimer() {
    if (timer || fsync !== 'interval') return;
    timer = setInterval(() => {
      chain = chain
        .then(async () => {
          if (handle && dirty) {
            dirty = false;
            await handle.sync();
          }
        })
        .catch(() => {});
    }, fsyncIntervalMs);
    timer.unref?.();
  }

  return {
    directory,
    /** Append records (objects). Resolves once they are written (and synced, for `always`). */
    append(records) {
      if (closed) return Promise.reject(new Error('disk log is closed'));
      const list = Array.isArray(records) ? records : [records];
      if (list.length === 0) return Promise.resolve();
      const data = `${list.map((r) => JSON.stringify(r)).join('\n')}\n`;
      startTimer();
      const p = chain.then(async () => {
        try {
          await ensureHandle();
          await handle.write(data);
          dirty = true;
          if (fsync === 'always') {
            await handle.sync();
            dirty = false;
          }
        } catch (e) {
          // Drop a bad handle so the next append reopens the file.
          const h = handle;
          handle = null;
          handleName = null;
          if (h) await h.close().catch(() => {});
          throw e;
        }
      });
      chain = p.catch(() => {});
      return p;
    },
    /** Sync now. */
    async flush() {
      await chain;
      if (handle && dirty && fsync !== 'none') {
        dirty = false;
        await handle.sync();
      }
    },
    currentSegment: () => handleName,
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      await chain;
      await closeHandle();
    }
  };
}

// --- Reading ----------------------------------------------------------------

/** Logical segment names (no .gz) under a directory, oldest first. */
export async function listSegments(directory) {
  const out = new Set();
  async function walk(rel) {
    let entries;
    try {
      entries = await readdir(path.join(directory, rel), { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(childRel);
      else if (ent.name.endsWith('.jsonl')) out.add(childRel);
      else if (ent.name.endsWith('.jsonl.gz')) out.add(childRel.slice(0, -3));
    }
  }
  await walk('');
  return [...out].sort();
}

/**
 * Yield { record, end } for each complete line from byte `offset`. `end` is the
 * offset just after the line: save it and a later call resumes there. An
 * incomplete last line (a writer mid-append) is not yielded. A line that is
 * not JSON is yielded as { corrupt: true, end }.
 */
export async function* readSegment(directory, logical, { offset = 0 } = {}) {
  const plain = path.join(directory, logical);
  const gz = `${plain}.gz`;
  let source;
  let skip = 0;
  let position = 0;
  try {
    await stat(plain);
    source = fs.createReadStream(plain, { start: offset });
    position = offset;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    await stat(gz); // throws ENOENT when the segment is gone
    source = fs.createReadStream(gz).pipe(zlib.createGunzip());
    skip = offset;
  }
  let pending = Buffer.alloc(0);
  for await (const chunk of source) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    let nl;
    while ((nl = pending.indexOf(10, start)) >= 0) {
      const line = pending.subarray(start, nl);
      const end = position + nl + 1;
      start = nl + 1;
      if (skip > 0 && end <= skip) continue; // gz: already consumed
      const text = line.toString('utf8').trim();
      if (!text) {
        yield { blank: true, end };
        continue;
      }
      try {
        yield { record: JSON.parse(text), end };
      } catch {
        yield { corrupt: true, end };
      }
    }
    position += start;
    pending = pending.subarray(start);
  }
}

// --- Housekeeping -----------------------------------------------------------

/** gzip a closed segment in place (x.jsonl -> x.jsonl.gz). Returns true when it did. */
export async function gzipSegment(directory, logical) {
  const plain = path.join(directory, logical);
  const gz = `${plain}.gz`;
  try {
    await stat(plain);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  const tmp = `${gz}.tmp`;
  await pipeline(fs.createReadStream(plain), zlib.createGzip(), fs.createWriteStream(tmp));
  await rename(tmp, gz);
  await unlink(plain);
  return true;
}

/** Delete a segment (plain or gz). */
export async function removeSegment(directory, logical) {
  for (const f of [path.join(directory, logical), `${path.join(directory, logical)}.gz`]) {
    try {
      await unlink(f);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}

export default { createDiskLog, listSegments, readSegment, gzipSegment, removeSegment, hourPrefix, segmentHour };
