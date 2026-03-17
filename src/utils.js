import fs from 'node:fs';

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export async function readFileSafe(p) {
  try {
    const content = await fs.promises.readFile(p, 'utf-8');
    if (content.length > MAX_FILE_SIZE) return null;
    return content;
  } catch {
    return null;
  }
}

export async function statSafe(p) {
  try {
    return await fs.promises.stat(p);
  } catch {
    return null;
  }
}

export async function readJsonSafe(p) {
  try {
    const content = await fs.promises.readFile(p, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function lstatSafe(p) {
  try {
    return await fs.promises.lstat(p);
  } catch {
    return null;
  }
}

export async function isSymlink(p) {
  const lstat = await lstatSafe(p);
  return lstat ? lstat.isSymbolicLink() : false;
}

export async function readFileWithError(p) {
  try {
    const content = await fs.promises.readFile(p, 'utf-8');
    return { content, error: null };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { content: null, error: null };
    }
    return { content: null, error: err.code };
  }
}

export async function fileExists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}
