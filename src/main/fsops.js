'use strict';
// Pure-Node filesystem helpers (no electron import → unit-testable).
// Safety invariant: nothing in this module ever overwrites or deletes a user
// file. Renames/moves refuse when the target exists; the only unlink is of a
// move source after its content has been verified at the destination.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SUPPORTED_EXTS = Object.freeze([
  '.jpg', '.jpeg', '.png', '.svg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.apng',
]);
const SUPPORTED_SET = new Set(SUPPORTED_EXTS);
// Formats that must be served as the original file (animation / vector).
const PASSTHROUGH_EXTS = new Set(['.gif', '.apng', '.svg', '.ico']);

const IS_WIN = process.platform === 'win32';
const SKIP_DIR_NAMES = new Set(['$recycle.bin', 'system volume information', 'node_modules']);
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

class FsOpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function extOf(p) {
  return path.extname(p).toLowerCase();
}

function isSupported(p) {
  return SUPPORTED_SET.has(extOf(p));
}

function normKey(p, win = IS_WIN) {
  const r = path.resolve(p);
  return win ? r.toLowerCase() : r;
}

function samePath(a, b, win = IS_WIN) {
  return normKey(a, win) === normKey(b, win);
}

/** true when `p` equals `root` or lies below it. */
function isInside(root, p, win = IS_WIN) {
  const r = normKey(root, win);
  const q = normKey(p, win);
  if (r === q) return true;
  const rel = path.relative(r, q);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function isInsideAny(roots, p, win = IS_WIN) {
  return roots.some((r) => isInside(r, p, win));
}

function shouldSkipDir(name) {
  if (!name || name.startsWith('.') || name.startsWith('$')) return true;
  return SKIP_DIR_NAMES.has(name.toLowerCase());
}

async function pathExists(p) {
  try {
    await fsp.lstat(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw e;
  }
}

/**
 * Scan a folder for supported images.
 * @returns {Promise<Array<{path,name,size,mtime,ext}>>}
 */
async function scanFolder(dir, { recursive = true } = {}) {
  const root = path.resolve(dir);
  const out = [];
  const stack = [root];
  let first = true;
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch (e) {
      if (first) throw e; // the requested folder itself must be readable
      continue; // unreadable subfolder: skip silently
    }
    first = false;
    const files = [];
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (recursive && !shouldSkipDir(ent.name)) stack.push(full);
      } else if ((ent.isFile() || ent.isSymbolicLink()) && isSupported(ent.name)) {
        files.push(full);
      }
    }
    // stat in bounded parallel batches
    for (let i = 0; i < files.length; i += 64) {
      const batch = files.slice(i, i + 64);
      const stats = await Promise.all(batch.map((f) => fsp.stat(f).catch(() => null)));
      stats.forEach((st, j) => {
        if (!st || !st.isFile()) return;
        const f = batch[j];
        out.push({ path: f, name: path.basename(f), size: st.size, mtime: st.mtimeMs, ext: extOf(f) });
      });
    }
  }
  return out;
}

/** Cheap probe: does `dir` contain a visible subfolder / a supported image? */
async function probeDir(dir) {
  const out = { hasChildren: false, hasFiles: false };
  let d;
  try {
    d = await fsp.opendir(dir);
  } catch {
    return out;
  }
  try {
    for await (const ent of d) {
      if (ent.isDirectory()) {
        if (!shouldSkipDir(ent.name)) out.hasChildren = true;
      } else if (isSupported(ent.name)) {
        out.hasFiles = true;
      }
      if (out.hasChildren && out.hasFiles) break;
    }
  } catch {
    /* ignore */
  } finally {
    try { await d.close(); } catch { /* already closed by iterator */ }
  }
  return out;
}

async function hasSubdir(dir) {
  return (await probeDir(dir)).hasChildren;
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * One level of a folder for the sidebar tree: visible subfolders (with
 * child probes) and supported image files, both in natural order.
 */
async function listDir(dir) {
  const root = path.resolve(dir);
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const dirEnts = entries.filter((e) => e.isDirectory() && !shouldSkipDir(e.name));
  const fileEnts = entries.filter((e) => (e.isFile() || e.isSymbolicLink()) && isSupported(e.name));
  dirEnts.sort((a, b) => nameCollator.compare(a.name, b.name));
  fileEnts.sort((a, b) => nameCollator.compare(a.name, b.name));
  const dirs = await Promise.all(dirEnts.map(async (e) => {
    const p = path.join(root, e.name);
    return { name: e.name, path: p, ...(await probeDir(p)) };
  }));
  const files = [];
  for (let i = 0; i < fileEnts.length; i += 64) {
    const batch = fileEnts.slice(i, i + 64);
    const stats = await Promise.all(batch.map((e) => fsp.stat(path.join(root, e.name)).catch(() => null)));
    stats.forEach((st, j) => {
      if (!st || !st.isFile()) return;
      const name = batch[j].name;
      files.push({ path: path.join(root, name), name, size: st.size, mtime: st.mtimeMs, ext: extOf(name) });
    });
  }
  return { dirs, files };
}

/** Immediate visible subfolders of `dir`, naturally sorted. */
async function listSubdirs(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && !shouldSkipDir(e.name));
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  dirs.sort((a, b) => coll.compare(a.name, b.name));
  return Promise.all(dirs.map(async (e) => {
    const p = path.join(dir, e.name);
    return { name: e.name, path: p, hasChildren: await hasSubdir(p) };
  }));
}

/** Returns a Japanese error message, or null when the name is valid. */
function validateName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.trim().length === 0) {
    return '名前を入力してください。';
  }
  if (name === '.' || name === '..') return 'この名前は使用できません。';
  if (/[\\/:*?"<>|]/.test(name)) return '名前に次の文字は使用できません: \\ / : * ? " < > |';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return '名前に制御文字は使用できません。';
  if (/[. ]$/.test(name)) return '名前の末尾にピリオドや空白は使用できません。';
  if (name.length > 255) return '名前が長すぎます。';
  const base = name.split('.')[0].trim().toUpperCase();
  if (RESERVED_NAMES.has(base)) return `「${base}」は Windows の予約名のため使用できません。`;
  return null;
}

function conflictError(target) {
  return new FsOpError('EEXIST', `同名のファイルまたはフォルダが既に存在します: ${path.basename(target)}`);
}

/**
 * Rename/move `src` to `dst` without ever replacing an existing `dst`.
 * Files: hard-link (atomic, fails with EEXIST) then unlink the old name; if
 * linking is unsupported fall back to check-then-rename.
 */
async function renameNoReplace(src, dst, isDir) {
  if (!isDir) {
    let linked = false;
    try {
      await fsp.link(src, dst);
      linked = true;
    } catch (e) {
      if (e.code === 'EEXIST') throw conflictError(dst);
      if (e.code === 'EXDEV') throw e;
      // EPERM / ENOTSUP / EISDIR etc. → fall through to the rename path
    }
    if (linked) {
      try {
        await fsp.unlink(src);
      } catch (e) {
        // undo: dst is only a second name for the same data we just created
        await fsp.unlink(dst).catch(() => {});
        throw e;
      }
      return;
    }
  }
  if (await pathExists(dst)) throw conflictError(dst);
  await fsp.rename(src, dst);
}

/** Case-only rename (Windows): go through a unique temporary name. */
async function caseOnlyRename(src, dst) {
  const dir = path.dirname(src);
  let tmp;
  do {
    tmp = path.join(dir, `.km-rename-${crypto.randomBytes(6).toString('hex')}`);
  } while (await pathExists(tmp));
  await fsp.rename(src, tmp);
  try {
    await fsp.rename(tmp, dst);
  } catch (e) {
    await fsp.rename(tmp, src).catch(() => {});
    throw e;
  }
}

/**
 * Rename a file or folder in place.
 * @returns {Promise<{from:string,to:string,changed:boolean}>}
 */
async function renamePath(src, newName) {
  const err = validateName(newName);
  if (err) throw new FsOpError('EINVAL', err);
  const from = path.resolve(src);
  const st = await fsp.stat(from);
  const isDir = st.isDirectory();
  if (!isDir && !isSupported(newName)) {
    throw new FsOpError('EEXT', `対応していない拡張子です: ${path.extname(newName) || '(なし)'}`);
  }
  const to = path.join(path.dirname(from), newName);
  if (to === from) return { from, to, changed: false };
  if (samePath(from, to)) {
    await caseOnlyRename(from, to);
  } else {
    await renameNoReplace(from, to, isDir);
  }
  return { from, to, changed: true };
}

/** Copy across volumes: never overwrites, verifies size, then removes the source. */
async function crossDeviceMove(src, dst) {
  try {
    await fsp.copyFile(src, dst, fs.constants.COPYFILE_EXCL);
  } catch (e) {
    if (e.code === 'EEXIST') throw conflictError(dst);
    throw e;
  }
  const [a, b] = await Promise.all([fsp.stat(src), fsp.stat(dst)]);
  if (a.size !== b.size) {
    // remove only the incomplete copy we just created; the source is untouched
    await fsp.unlink(dst).catch(() => {});
    throw new FsOpError('EIO', `コピーの検証に失敗しました: ${path.basename(src)}`);
  }
  await fsp.utimes(dst, a.atime, a.mtime).catch(() => {});
  await fsp.unlink(src);
}

/**
 * Move files into `destDir`. Conflicts are skipped, never overwritten.
 * @returns {Promise<{moved:{from,to}[], skipped:string[], unchanged:string[], errors:{path,message}[]}>}
 */
async function moveFiles(srcs, destDir) {
  const dest = path.resolve(destDir);
  const result = { moved: [], skipped: [], unchanged: [], errors: [] };
  const dstat = await fsp.stat(dest);
  if (!dstat.isDirectory()) throw new FsOpError('ENOTDIR', '移動先がフォルダではありません。');
  for (const s of srcs) {
    const src = path.resolve(s);
    try {
      if (samePath(path.dirname(src), dest)) {
        result.unchanged.push(src);
        continue;
      }
      const st = await fsp.stat(src);
      if (!st.isFile()) throw new FsOpError('EISDIR', 'ファイルではありません。');
      const dst = path.join(dest, path.basename(src));
      if (await pathExists(dst)) {
        result.skipped.push(src);
        continue;
      }
      try {
        await renameNoReplace(src, dst, false);
      } catch (e) {
        if (e.code === 'EXDEV') await crossDeviceMove(src, dst);
        else throw e;
      }
      result.moved.push({ from: src, to: dst });
    } catch (e) {
      if (e.code === 'EEXIST') result.skipped.push(src);
      else result.errors.push({ path: src, message: describeError(e) });
    }
  }
  return result;
}

/**
 * Should a recursive fs.watch event be ignored for refresh purposes?
 * - 'change' on a directory only reports the folder's own timestamps or
 *   attributes; adding/removing/renaming entries is always reported
 *   separately as 'rename' events for those entries.
 * - Windows also reports last-access-time updates as 'change' (reading a
 *   file triggers one). Those leave mtime and ctime untouched, so a file
 *   'change' with both older than `windowMs` is access-only.
 * 'rename' (create/delete/rename) and vanished entries always count.
 */
function isIgnorableChange(eventType, stat, now = Date.now(), windowMs = 5000) {
  if (eventType !== 'change' || !stat) return false;
  if (typeof stat.isDirectory === 'function' && stat.isDirectory()) return true;
  return now - stat.mtimeMs > windowMs && now - stat.ctimeMs > windowMs;
}

function describeError(e) {
  if (!e) return '不明なエラー';
  if (e instanceof FsOpError) return e.message;
  switch (e.code) {
    case 'ENOENT': return 'ファイルまたはフォルダが見つかりません。';
    case 'EACCES':
    case 'EPERM': return 'アクセスが拒否されました（使用中または権限がありません）。';
    case 'EBUSY': return 'ファイルが使用中です。';
    case 'EEXIST': return '同名のファイルまたはフォルダが既に存在します。';
    case 'ENOTDIR': return 'フォルダではありません。';
    case 'ENOSPC': return 'ディスクの空き容量が不足しています。';
    default: return e.message || String(e);
  }
}

module.exports = {
  SUPPORTED_EXTS,
  PASSTHROUGH_EXTS,
  FsOpError,
  extOf,
  isSupported,
  normKey,
  samePath,
  isInside,
  isInsideAny,
  shouldSkipDir,
  pathExists,
  scanFolder,
  listSubdirs,
  listDir,
  validateName,
  renamePath,
  moveFiles,
  describeError,
  isIgnorableChange,
};
