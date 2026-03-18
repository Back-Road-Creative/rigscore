import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Create a temp directory, run callback with its path, then clean up.
 * @param {(tmpDir: string) => Promise<void>} callback
 */
export async function withTmpDir(callback) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-test-'));
  try {
    await callback(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
}
