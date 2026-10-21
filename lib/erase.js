/*
  Remove a person from the disk log.

  core's erasePeople deletes a person from every table with a person_id
  column, which covers every gauge table. The disk log also holds person_id (a
  hit that carried a Core Session, an /identify record) and, for server calls,
  an email hash. This rewrites those segments without the matching records.

  Rules:
    - A record matches by person_id, or by email_hash_v1 when one is given.
      Anonymous hits from a device that was later linked stay: they hold no
      identity, and without the link they cannot be tied back.
    - Segments in the current hour or later are skipped unless includeOpen is
      set, because a running collector holds them open for append and a rewrite
      would be lost. Stop the collector (or wait an hour) and run again.
    - The loader's checkpoint holds byte offsets into segments. A rewrite moves
      them, so this returns the corrected offsets; the caller writes them back.
      Otherwise the next load would skip or re-read records.
*/
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { rename, writeFile, readFile, stat } from 'node:fs/promises';
import { listSegments, hourPrefix, segmentHour } from './diskLog.js';

function matcher({ personId, emailHash }) {
  const pid = personId === undefined || personId === null ? null : Number(personId);
  if (pid !== null && !(Number.isInteger(pid) && pid > 0)) throw new Error('personId must be a positive integer');
  if (emailHash && !/^[a-f0-9]{64}$/.test(emailHash)) throw new Error('emailHash must be a sha256 hex string');
  if (pid === null && !emailHash) throw new Error('give a personId or an emailHash');
  return (record) => Boolean(record) && ((pid !== null && Number(record.person_id) === pid) || (emailHash && record.email_hash_v1 === emailHash));
}

/**
 * @param {string} directory
 * @param {{ personId?: number, emailHash?: string, offsets?: Record<string, number>, includeOpen?: boolean, now?: Date }} options
 * @returns {Promise<{ segments: number, removed: number, skipped: string[], offsets: Record<string, number> }>}
 */
export async function eraseFromLog(directory, options = {}) {
  const matches = matcher(options);
  const now = options.now || new Date();
  const open = hourPrefix(now);
  const offsets = { ...(options.offsets || {}) };
  const out = { segments: 0, removed: 0, skipped: [], offsets };

  for (const logical of await listSegments(directory)) {
    if (!options.includeOpen && (segmentHour(logical) || '') >= open) {
      out.skipped.push(logical);
      continue;
    }
    const plain = path.join(directory, logical);
    let gz = false;
    let buf;
    try {
      await stat(plain);
      buf = await readFile(plain);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      gz = true;
      buf = zlib.gunzipSync(await readFile(`${plain}.gz`));
    }

    const oldOffset = Number.isFinite(offsets[logical]) ? offsets[logical] : null;
    const kept = [];
    let removed = 0;
    let newOffset = 0;
    let position = 0;
    while (position < buf.length) {
      const nl = buf.indexOf(10, position);
      const end = nl < 0 ? buf.length : nl + 1;
      const line = buf.subarray(position, end);
      let drop = false;
      if (nl >= 0) {
        try {
          drop = matches(JSON.parse(line.toString('utf8')));
        } catch {
          drop = false; // corrupt lines are not ours to remove
        }
      }
      if (drop) removed += 1;
      else {
        kept.push(line);
        if (oldOffset !== null && end <= oldOffset) newOffset += line.length;
      }
      position = end;
    }
    if (removed === 0) continue;

    const data = Buffer.concat(kept);
    const target = gz ? `${plain}.gz` : plain;
    const tmp = `${target}.tmp`;
    await writeFile(tmp, gz ? zlib.gzipSync(data) : data);
    if (!gz) {
      const fd = fs.openSync(tmp, 'r+');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    }
    await rename(tmp, target);
    if (oldOffset !== null) offsets[logical] = newOffset;
    out.segments += 1;
    out.removed += removed;
  }
  return out;
}

export default { eraseFromLog };
