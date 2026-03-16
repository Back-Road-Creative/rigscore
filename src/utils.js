import fs from 'node:fs';

export async function readFileSafe(p) {
  try {
    return await fs.promises.readFile(p, 'utf-8');
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

export async function fileExists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}
