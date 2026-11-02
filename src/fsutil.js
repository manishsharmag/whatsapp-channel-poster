import fs from 'node:fs';
import path from 'node:path';

/**
 * Write a file so a crash or power cut mid-write cannot leave it half-written.
 * The data goes to a temporary file in the same folder, then replaces the real
 * one in a single rename (atomic on NTFS, ext4 and APFS).
 */
export function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}
