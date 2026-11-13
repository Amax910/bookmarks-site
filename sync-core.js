// Shared by the Brave extension (laptop) and the phone site.
// - Encrypts everything with your passphrase before it leaves the device
//   (PBKDF2-SHA256 → AES-256-GCM, gzip first). GitHub only ever stores ciphertext.
// - Talks to one private GitHub repo through the REST "contents" API.
// - Merges ✓ checked marks from both devices.
//
// Checked marks are { [bookmarkId]: signedTime }: a positive time means
// "checked at that moment", a negative one means "un-checked at that moment".
// When two devices disagree, the most recent action wins.

export const FILES = {
  bookmarks: 'bookmarks.enc.json', // written by the laptop only
  checked: 'checked.enc.json', // written by both
  highlights: 'highlights.enc.json', // long-press highlights, written by the phone
};

const ITERATIONS = 600000;
const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

// ---------- bytes & base64 ----------

export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function pipe(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const gzip = (bytes) => pipe(bytes, new CompressionStream('gzip'));
const gunzip = (bytes) => pipe(bytes, new DecompressionStream('gzip'));

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', utf8.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- encryption ----------

const keyCache = new Map();
async function deriveKey(passphrase, saltB64, iterations) {
  const cacheKey = `${iterations}|${saltB64}|${passphrase}`;
  if (!keyCache.has(cacheKey)) {
    const promise = (async () => {
      const base = await crypto.subtle.importKey('raw', utf8.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBytes(saltB64), iterations },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    })();
    keyCache.set(cacheKey, promise);
    promise.catch(() => keyCache.delete(cacheKey));
  }
  return keyCache.get(cacheKey);
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase: the data in the repo could not be decrypted with it.');
    this.name = 'WrongPassphraseError';
  }
}

// Reusing the salt from the existing file keeps the slow key derivation
// cached; every write still gets a fresh random IV.
export async function encryptJson(value, passphrase, saltB64) {
  const salt = saltB64 || bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = await gzip(utf8.encode(JSON.stringify(value)));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return JSON.stringify({
    format: 'bookmark-launcher',
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iter: ITERATIONS,
    salt,
    iv: bytesToB64(iv),
    z: 'gzip',
    data: bytesToB64(cipher),
  });
}

export function envelopeSalt(text) {
  try {
    return JSON.parse(text).salt || null;
  } catch {
    return null;
  }
}

export async function decryptJson(text, passphrase) {
  let env;
  try {
    env = JSON.parse(text);
  } catch {
    throw new Error('The file in the repo is not Bookmark Launcher data.');
  }
  if (env.format !== 'bookmark-launcher') throw new Error('The file in the repo is not Bookmark Launcher data.');
  const key = await deriveKey(passphrase, env.salt, env.iter);
  let plain;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(env.iv) }, key, b64ToBytes(env.data))
    );
  } catch {
    throw new WrongPassphraseError();
  }
  const bytes = env.z === 'gzip' ? await gunzip(plain) : plain;
  return { value: JSON.parse(utf8d.decode(bytes)), salt: env.salt };
}

// ---------- GitHub ----------

export class ConflictError extends Error {
  constructor() {
    super('Another device updated the file at the same moment.');
    this.name = 'ConflictError';
  }
}

async function apiError(res, what) {
  let detail = '';
  try {
    detail = (await res.json()).message || '';
  } catch {}
  if (res.status === 401) return new Error('GitHub rejected the token (expired or mistyped).');
  if (res.status === 403 && /rate limit/i.test(detail)) return new Error('GitHub rate limit hit; try again in a while.');
  if (res.status === 403) return new Error('The token is not allowed to do that. Give it “Contents: Read and write” on this repo.');
  if (res.status === 404) return new Error('Repo not found, or the token has no access to it.');
  return new Error(`GitHub ${what} failed (${res.status}) ${detail}`.trim());
}

export class GitHubStore {
  constructor({ owner, repo, token }) {
    this.owner = owner.trim();
    this.repo = repo.trim();
    this.token = token.trim();
  }

  headers(accept) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  get base() {
    return `https://api.github.com/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  // → { private, canWrite, fullName }
  async checkRepo() {
    const res = await fetch(this.base, { headers: this.headers('application/vnd.github+json'), cache: 'no-store' });
    if (!res.ok) throw await apiError(res, 'repo check');
    const j = await res.json();
    return { private: !!j.private, canWrite: j.permissions ? !!j.permissions.push : true, fullName: j.full_name };
  }

  // → { text, sha } or null if the file doesn't exist yet
  async read(path) {
    const url = `${this.base}/contents/${path}`;
    const res = await fetch(url, { headers: this.headers('application/vnd.github.object+json'), cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw await apiError(res, 'read');
    const j = await res.json();
    let text;
    if (j.encoding === 'base64' && j.content) {
      text = utf8d.decode(b64ToBytes(j.content.replace(/\s/g, '')));
    } else {
      // Files over 1 MB come without inline content.
      const raw = await fetch(url, { headers: this.headers('application/vnd.github.raw+json'), cache: 'no-store' });
      if (!raw.ok) throw await apiError(raw, 'read');
      text = await raw.text();
    }
    return { text, sha: j.sha };
  }

  // → new sha
  async write(path, text, sha, message) {
    const body = { message, content: bytesToB64(utf8.encode(text)) };
    if (sha) body.sha = sha;
    const res = await fetch(`${this.base}/contents/${path}`, {
      method: 'PUT',
      headers: { ...this.headers('application/vnd.github+json'), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 409 || (res.status === 422 && !sha)) throw new ConflictError();
    if (!res.ok) throw await apiError(res, 'write');
    return (await res.json()).content.sha;
  }
}

// ---------- checked marks ----------

export const isChecked = (marks, id) => (marks[id] || 0) > 0;

export function mergeMarks(a = {}, b = {}) {
  const out = { ...a };
  for (const [id, t] of Object.entries(b)) {
    if (typeof t !== 'number') continue;
    if (!(id in out) || Math.abs(t) > Math.abs(out[id])) out[id] = t;
  }
  return out;
}

export function sameMarks(a = {}, b = {}) {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

// Pull the other device's marks, merge with ours, push the result if it
// changed. Returns the merged marks. With `replaceUnreadable`, a remote file
// that can't be decrypted (old passphrase) is overwritten instead of failing.
// `file` lets the same logic sync other per-bookmark flags (e.g. highlights).
export async function syncMarks(
  store,
  passphrase,
  localMarks,
  who,
  { replaceUnreadable = false, file = FILES.checked } = {}
) {
  let local = localMarks;
  for (let attempt = 0; attempt < 4; attempt++) {
    const remote = await store.read(file);
    let remoteMarks = {};
    let salt = null;
    if (remote) {
      try {
        const d = await decryptJson(remote.text, passphrase);
        remoteMarks = d.value.marks || {};
        salt = d.salt;
      } catch (err) {
        if (!(replaceUnreadable && err instanceof WrongPassphraseError)) throw err;
      }
    }
    const merged = mergeMarks(local, remoteMarks);
    const unchanged = remote ? salt && sameMarks(merged, remoteMarks) : Object.keys(merged).length === 0;
    if (unchanged) return merged;
    const text = await encryptJson({ v: 1, updatedAt: Date.now(), by: who, marks: merged }, passphrase, salt);
    try {
      await store.write(file, text, remote?.sha, `Update ${file.replace('.enc.json', '')} (${who})`);
      return merged;
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      local = merged; // someone else wrote first: re-read and merge again
    }
  }
  throw new Error('Another device kept updating at the same time; will retry shortly.');
}

// ---------- bookmarks snapshot ----------

// Laptop side: upload the bookmark tree if it changed since the last upload.
// `last` is { hash, sha } from the previous successful upload.
// → { hash, sha, uploaded }
export async function pushBookmarks(store, passphrase, tree, last = {}, { replaceUnreadable = false } = {}) {
  const hash = await sha256Hex(JSON.stringify(tree));
  for (let attempt = 0; attempt < 3; attempt++) {
    const remote = await store.read(FILES.bookmarks);
    if (remote && remote.sha === last.sha && hash === last.hash) return { hash, sha: remote.sha, uploaded: false };
    let salt = remote ? envelopeSalt(remote.text) : null;
    if (remote && salt) {
      // Never silently replace data encrypted with a different passphrase.
      try {
        await decryptJson(remote.text, passphrase);
      } catch (err) {
        if (!(replaceUnreadable && err instanceof WrongPassphraseError)) throw err;
        salt = null;
      }
    }
    const text = await encryptJson({ v: 1, updatedAt: Date.now(), tree }, passphrase, salt);
    try {
      const sha = await store.write(FILES.bookmarks, text, remote?.sha, 'Update bookmarks (laptop)');
      return { hash, sha, uploaded: true };
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
    }
  }
  throw new Error('Could not upload bookmarks; will retry shortly.');
}

// Phone side. → { snapshot: { updatedAt, tree }, sha } or null
export async function pullBookmarks(store, passphrase, knownSha) {
  const remote = await store.read(FILES.bookmarks);
  if (!remote) return null;
  if (knownSha && remote.sha === knownSha) return { snapshot: null, sha: remote.sha };
  const { value } = await decryptJson(remote.text, passphrase);
  return { snapshot: { updatedAt: value.updatedAt, tree: value.tree }, sha: remote.sha };
}

// ---------- CSV ----------

function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheets treating it as a formula
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const day = (ms) => (ms > 0 ? new Date(ms).toLocaleDateString('en-CA') : '');

// items: [{ id, title, url, path, dateAdded }]. `highlights` is optional.
export function toCsv(items, marks, highlights) {
  const head = ['Title', 'URL', 'Folder', 'Date added', 'Checked', 'Checked on', 'ID'];
  if (highlights) head.push('Highlighted');
  const rows = [head];
  for (const b of items) {
    const t = marks[b.id] || 0;
    const row = [b.title, b.url, b.path, day(b.dateAdded), t > 0 ? 'yes' : '', day(t), b.id];
    if (highlights) row.push((highlights[b.id] || 0) > 0 ? 'yes' : '');
    rows.push(row);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const unguard = (s) => (/^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s);
  return rows.filter((r) => r.some((c) => c !== '')).map((r) => r.map(unguard));
}

// CSV rows (our export format) → { tree, marks }
export function csvToSnapshot(text) {
  const [head, ...rows] = parseCsv(text);
  if (!head) throw new Error('The CSV file is empty.');
  const col = (name) => head.findIndex((h) => h.trim().toLowerCase() === name);
  const iTitle = col('title');
  const iUrl = col('url');
  const iFolder = col('folder');
  const iAdded = col('date added');
  const iChecked = col('checked');
  const iCheckedOn = col('checked on');
  const iId = col('id');
  const iHl = col('highlighted');
  if (iUrl < 0) throw new Error('The CSV needs at least a “URL” column.');
  const highlights = {};

  const root = { i: 'csv-root', t: '', c: [] };
  const folders = new Map([['', root]]);
  const folderFor = (path) => {
    if (folders.has(path)) return folders.get(path);
    const parts = path.split(' › ');
    const parent = folderFor(parts.slice(0, -1).join(' › '));
    const f = { i: `csv-f-${folders.size}`, t: parts.at(-1), c: [] };
    parent.c.push(f);
    folders.set(path, f);
    return f;
  };
  const marks = {};
  rows.forEach((r, n) => {
    const url = (r[iUrl] || '').trim();
    if (!url) return;
    const id = (iId >= 0 && r[iId]) || `csv-${n}`;
    const added = iAdded >= 0 && r[iAdded] ? Date.parse(r[iAdded]) : 0;
    folderFor(iFolder >= 0 ? (r[iFolder] || '').trim() : '').c.push({
      i: id,
      t: (iTitle >= 0 && r[iTitle]) || url,
      u: url,
      d: added || 0,
    });
    if (iChecked >= 0 && /^(yes|true|1|✓)$/i.test((r[iChecked] || '').trim())) {
      marks[id] = (iCheckedOn >= 0 && Date.parse(r[iCheckedOn])) || Date.now();
    }
    if (iHl >= 0 && /^(yes|true|1|★)$/i.test((r[iHl] || '').trim())) highlights[id] = Date.now();
  });
  return { tree: root.c, marks, highlights };
}
