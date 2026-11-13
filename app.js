// Phone site. Reads the encrypted bookmarks your laptop uploads to your private
// GitHub repo, decrypts them here, and shows them as real links so a
// long-press gives Brave's own menu (private tab, tab group, background tab).

import {
  GitHubStore,
  pullBookmarks,
  syncMarks,
  mergeMarks,
  sameMarks,
  isChecked,
  toCsv,
  csvToSnapshot,
  b64ToBytes,
} from './sync-core.js';

const $ = (id) => document.getElementById(id);
const listEl = $('list');
const searchEl = $('search');
const noticeEl = $('notice');
const chipEl = $('syncChip');
const countsEl = $('counts');
const hideCheckedEl = $('hideChecked');

// ---------- local storage (this phone only) ----------

const KEYS = {
  settings: 'bl.settings',
  snapshot: 'bl.snapshot',
  marks: 'bl.marks',
  pending: 'bl.pending',
  ui: 'bl.ui',
  lastSync: 'bl.lastSync',
};
function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const state = {
  settings: load(KEYS.settings, null), // { owner, repo, token, passphrase, tapMode }
  snapshot: load(KEYS.snapshot, null), // { updatedAt, tree, sha, source }
  marks: load(KEYS.marks, {}),
  pending: load(KEYS.pending, false),
  lastSync: load(KEYS.lastSync, 0),
  ui: { expanded: [], hideChecked: false, query: '', treeScroll: 0, tapMode: 'ask', ...load(KEYS.ui, {}) },
  items: [],
  byId: new Map(),
  syncing: false,
  syncError: null,
  flashId: null,
};
let expanded = new Set(state.ui.expanded);

function saveUi() {
  state.ui.expanded = [...expanded];
  save(KEYS.ui, state.ui);
}

// ---------- helpers ----------

const isOpenable = (url) => /^(https?|ftp):/i.test(url || '');
const checked = (id) => isChecked(state.marks, id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// A coloured letter instead of a favicon: fetching real icons would tell a
// third-party icon service which sites you have bookmarked.
function avatar(url) {
  const host = hostOf(url);
  let h = 0;
  for (const ch of host) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = el('span', 'avatar', (host.replace(/^[^a-z0-9]+/i, '')[0] || '•').toUpperCase());
  a.style.background = `hsl(${h % 360} 55% 45%)`;
  a.setAttribute('aria-hidden', 'true');
  return a;
}

function highlight(text, tokens) {
  const frag = document.createDocumentFragment();
  text = text || '';
  const lower = text.toLowerCase();
  if (!tokens?.length || lower.length !== text.length) {
    frag.append(text);
    return frag;
  }
  const ranges = [];
  for (const tok of tokens) {
    for (let i = lower.indexOf(tok); i !== -1; i = lower.indexOf(tok, i + tok.length)) ranges.push([i, i + tok.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let pos = 0;
  for (const [s, e] of ranges) {
    if (e <= pos) continue;
    const start = Math.max(s, pos);
    if (start > pos) frag.append(text.slice(pos, start));
    frag.append(el('mark', null, text.slice(start, e)));
    pos = e;
  }
  frag.append(text.slice(pos));
  return frag;
}

function ago(t) {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

let toastTimer;
function toast(text) {
  document.querySelector('.toast')?.remove();
  const t = el('div', 'toast', text);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2200);
}

function showNotice(text) {
  noticeEl.textContent = text;
  noticeEl.hidden = !text;
}

// ---------- data ----------

function indexSnapshot() {
  state.items = [];
  state.byId.clear();
  (function walk(nodes, path) {
    for (const n of nodes || []) {
      if (n.u) {
        const item = { id: n.i, title: n.t || n.u, url: n.u, path: path.join(' › '), dateAdded: n.d || 0 };
        state.items.push(item);
        state.byId.set(n.i, item);
      } else {
        walk(n.c, n.t ? [...path, n.t] : path);
      }
    }
  })(state.snapshot?.tree, []);
  if (!state.ui.expanded.length && state.snapshot?.tree?.length) {
    expanded.add(state.snapshot.tree[0].i); // open the first top-level folder on first run
  }
}

function setMarks(ids, value) {
  const now = Date.now();
  for (const id of ids) state.marks[id] = value ? now : -now;
  save(KEYS.marks, state.marks);
  state.pending = true;
  save(KEYS.pending, true);
  schedulePush();
  render();
}

// ---------- sync ----------

let pushTimer;
function schedulePush() {
  if (!state.settings) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => sync(), 3000);
}

async function sync() {
  if (!state.settings || state.syncing) return;
  if (!navigator.onLine) {
    state.syncError = 'Offline. Showing your last copy.';
    renderChip();
    return;
  }
  state.syncing = true;
  state.syncError = null;
  renderChip();
  try {
    const store = new GitHubStore(state.settings);
    const pass = state.settings.passphrase;
    const knownSha = state.snapshot?.source === 'github' ? state.snapshot.sha : null;
    const pulled = await pullBookmarks(store, pass, knownSha);
    if (!pulled) {
      showNotice('No bookmarks in the repo yet. Turn on Phone sync in the Brave extension on your laptop (its Settings page), then tap Sync.');
    } else {
      showNotice('');
      if (pulled.snapshot) {
        state.snapshot = { ...pulled.snapshot, sha: pulled.sha, source: 'github' };
        save(KEYS.snapshot, state.snapshot);
        indexSnapshot();
      }
    }

    const sent = { ...state.marks };
    const merged = await syncMarks(store, pass, sent, 'phone');
    // Keep any tick made while we were talking to GitHub.
    state.marks = mergeMarks(state.marks, merged);
    save(KEYS.marks, state.marks);
    state.pending = !sameMarks(state.marks, merged);
    save(KEYS.pending, state.pending);
    if (state.pending) schedulePush();

    state.lastSync = Date.now();
    save(KEYS.lastSync, state.lastSync);
  } catch (err) {
    state.syncError = String(err?.message || err);
  } finally {
    state.syncing = false;
    render();
  }
}

function renderChip() {
  chipEl.className = 'chip';
  if (!state.settings) {
    chipEl.textContent = state.snapshot ? 'CSV · not syncing' : 'Not connected';
    return;
  }
  if (state.syncing) {
    chipEl.textContent = 'Syncing…';
  } else if (state.syncError) {
    chipEl.textContent = navigator.onLine ? 'Sync failed' : 'Offline';
    chipEl.classList.add('err');
    chipEl.title = state.syncError;
  } else {
    const from = state.snapshot?.updatedAt ? ` · laptop ${ago(state.snapshot.updatedAt)}` : '';
    chipEl.textContent = `Synced ${ago(state.lastSync)}${from}`;
    chipEl.classList.add('ok');
    chipEl.title = '';
  }
}

chipEl.addEventListener('click', () => {
  if (!state.settings) return openSettings();
  if (state.syncError) showNotice(state.syncError);
  sync();
});

// ---------- opening bookmarks ----------

function afterOpen(item) {
  state.flashId = item.id;
  setTimeout(() => (state.flashId = null), 1000);
  // Next tick, so the tapped link finishes opening before the list redraws.
  setTimeout(() => setMarks([item.id], true), 0);
}

function openSame(item) {
  state.ui.treeScroll = searchEl.value.trim() ? state.ui.treeScroll : window.scrollY;
  saveUi();
  afterOpen(item);
  location.href = item.url;
}

function openNew(item) {
  window.open(item.url, '_blank', 'noopener,noreferrer');
  afterOpen(item);
}

async function copyLink(item) {
  try {
    await navigator.clipboard.writeText(item.url);
    toast('Link copied');
  } catch {
    prompt('Copy this link:', item.url);
  }
}

const askDlg = $('askDlg');
let askItem = null;
function ask(item) {
  askItem = item;
  $('askTitle').textContent = item.title;
  $('askHost').textContent = item.url;
  $('askRemember').checked = false;
  askDlg.returnValue = '';
  askDlg.showModal();
}
askDlg.addEventListener('close', () => {
  const item = askItem;
  const choice = askDlg.returnValue;
  askItem = null;
  if (!item || !['new', 'same', 'copy'].includes(choice)) return;
  if ($('askRemember').checked && choice !== 'copy') {
    state.ui.tapMode = choice;
    saveUi();
    toast(choice === 'new' ? 'Bookmarks will open in a new tab' : 'Bookmarks will open in this tab');
  }
  if (choice === 'new') openNew(item);
  else if (choice === 'same') openSame(item);
  else copyLink(item);
});
// Tap outside the sheet closes it.
for (const dlg of document.querySelectorAll('dialog.sheet')) {
  dlg.addEventListener('click', (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dlg.close('cancel');
  });
}

function onLinkClick(e, item) {
  // Ctrl/⌘/middle clicks keep the browser's normal behaviour.
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  const mode = state.ui.tapMode;
  if (mode === 'new') {
    afterOpen(item); // the link's own target="_blank" does the opening
    return;
  }
  e.preventDefault();
  if (mode === 'same') openSame(item);
  else ask(item);
}

// ---------- rendering ----------

function itemRow(item, depth, { tokens, showPath } = {}) {
  const row = el('div', 'item');
  if (checked(item.id)) row.classList.add('seen');
  if (state.flashId === item.id) row.classList.add('flash');
  row.style.paddingLeft = `${16 + depth * 16}px`;

  let a;
  if (isOpenable(item.url)) {
    a = el('a', 'link');
    a.href = item.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.addEventListener('click', (e) => onLinkClick(e, item));
  } else {
    a = el('div', 'link'); // bookmarklets etc. can't open on a phone
    a.title = 'This bookmark can’t be opened here';
  }
  const text = el('span', 'text');
  const title = el('span', 'title');
  title.append(highlight(item.title, tokens));
  const sub = el('span', 'sub');
  sub.append(highlight(showPath ? [item.path, hostOf(item.url)].filter(Boolean).join(' · ') : hostOf(item.url), tokens));
  text.append(title, sub);
  a.append(avatar(item.url), text);

  const check = el('button', 'check');
  check.type = 'button';
  check.setAttribute('aria-label', checked(item.id) ? 'Checked. Tap to un-check' : 'Mark as checked');
  check.addEventListener('click', () => setMarks([item.id], !checked(item.id)));

  row.append(a, check);
  return row;
}

function folderStats(node) {
  let total = 0;
  let seen = 0;
  (function walk(n) {
    if (n.u) {
      total++;
      if (checked(n.i)) seen++;
    } else (n.c || []).forEach(walk);
  })(node);
  return { total, seen };
}

function folderBlock(node, depth) {
  const block = el('div', 'folder');
  const open = expanded.has(node.i);
  if (open) block.classList.add('open');
  const row = el('div', 'folder-row');
  row.style.paddingLeft = `${16 + depth * 16}px`;
  const { total, seen } = folderStats(node);
  row.append(
    el('span', 'twisty', '▶'),
    el('span', 'fname', node.t || 'Untitled folder'),
    el('span', 'count', seen ? `✓ ${seen}/${total}` : String(total))
  );
  row.addEventListener('click', () => {
    if (expanded.has(node.i)) expanded.delete(node.i);
    else expanded.add(node.i);
    saveUi();
    render();
  });
  block.append(row);
  if (open) {
    let shown = 0;
    for (const c of node.c || []) {
      if (!c.u) {
        block.append(folderBlock(c, depth + 1));
        shown++;
      }
    }
    for (const c of node.c || []) {
      if (c.u && !(state.ui.hideChecked && checked(c.i))) {
        block.append(itemRow(state.byId.get(c.i), depth + 1));
        shown++;
      }
    }
    if (!shown) {
      const e = el('div', 'hint-row', node.c?.length ? '(all checked)' : '(empty)');
      e.style.paddingLeft = `${16 + (depth + 1) * 16}px`;
      block.append(e);
    }
  }
  return block;
}

function renderSearch(query) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  for (const it of state.items) {
    if (state.ui.hideChecked && checked(it.id)) continue;
    const t = it.title.toLowerCase();
    if (tokens.every((tok) => `${t}\n${it.url.toLowerCase()}\n${it.path.toLowerCase()}`.includes(tok))) {
      hits.push({ it, inTitle: tokens.every((tok) => t.includes(tok)) });
    }
  }
  hits.sort((a, b) => b.inTitle - a.inTitle);
  const frag = document.createDocumentFragment();
  if (!hits.length) {
    frag.append(el('div', 'empty', `No bookmarks match “${query}”${state.ui.hideChecked ? ' (checked ones are hidden)' : ''}.`));
    return frag;
  }
  frag.append(el('div', 'results-head', `${hits.length} result${hits.length === 1 ? '' : 's'}`));
  for (const { it } of hits) frag.append(itemRow(it, 0, { tokens, showPath: true }));
  return frag;
}

function renderTree() {
  const frag = document.createDocumentFragment();
  const tops = (state.snapshot?.tree || []).filter((n) => n.u || n.c?.length);
  for (const n of tops) frag.append(n.u ? itemRow(state.byId.get(n.i), 0) : folderBlock(n, 0));
  if (!tops.length) frag.append(el('div', 'empty', 'No bookmarks yet.'));
  return frag;
}

let lastView = null;
function render() {
  renderChip();
  const hasData = !!state.snapshot;
  $('welcome').hidden = hasData || !!state.settings;
  listEl.hidden = !hasData;
  const seenCount = state.items.reduce((n, it) => n + (checked(it.id) ? 1 : 0), 0);
  countsEl.textContent = hasData ? `${seenCount.toLocaleString()} of ${state.items.length.toLocaleString()} checked` : '';
  if (!hasData) return;

  const q = searchEl.value.trim();
  const view = q ? `q:${q}` : 'tree';
  const y = window.scrollY;
  listEl.replaceChildren(q ? renderSearch(q) : renderTree());
  // Same view → stay put. New search → top. Back to folders → where you were.
  if (view === lastView) window.scrollTo(0, y);
  else window.scrollTo(0, q ? 0 : state.ui.treeScroll || 0);
  lastView = view;
}

// ---------- events ----------

let scrollTimer;
window.addEventListener(
  'scroll',
  () => {
    if (searchEl.value.trim()) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      state.ui.treeScroll = window.scrollY;
      saveUi();
    }, 200);
  },
  { passive: true }
);

let searchTimer;
searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.ui.query = searchEl.value;
    saveUi();
    render();
  }, 150);
});
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchEl.blur(); // hide the keyboard to show results
});

hideCheckedEl.addEventListener('change', () => {
  state.ui.hideChecked = hideCheckedEl.checked;
  saveUi();
  render();
});

// ⋯ menu
const menuDlg = $('menuDlg');
$('menuBtn').addEventListener('click', () => {
  $('tapMode').value = state.ui.tapMode;
  menuDlg.returnValue = '';
  menuDlg.showModal();
});
$('tapMode').addEventListener('change', (e) => {
  state.ui.tapMode = e.target.value;
  saveUi();
});
menuDlg.addEventListener('close', () => {
  const v = menuDlg.returnValue;
  if (v === 'sync') state.settings ? sync() : openSettings();
  else if (v === 'export') exportCsv();
  else if (v === 'import') $('csvFile').click();
  else if (v === 'settings') openSettings();
});

// CSV
function exportCsv() {
  if (!state.items.length) return toast('Nothing to export yet');
  const blob = new Blob([toCsv(state.items, state.marks)], { type: 'text/csv;charset=utf-8' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bookmarks-${new Date().toLocaleDateString('en-CA')}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
$('welcomeImport').addEventListener('click', () => $('csvFile').click());
$('csvFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { tree, marks } = csvToSnapshot(await file.text());
    state.snapshot = { updatedAt: file.lastModified || Date.now(), tree, sha: null, source: 'csv' };
    save(KEYS.snapshot, state.snapshot);
    state.marks = mergeMarks(state.marks, marks);
    save(KEYS.marks, state.marks);
    expanded = new Set();
    state.ui.expanded = [];
    indexSnapshot();
    saveUi();
    lastView = null;
    render();
    toast(`Imported ${state.items.length} bookmarks`);
    if (state.settings) showNotice('Imported. The next sync will replace this list with the one from your laptop.');
  } catch (err) {
    showNotice(`Couldn’t import that file: ${err.message}`);
  }
});

// Settings
const settingsDlg = $('settingsDlg');
const settingsForm = $('settingsForm');
const settingsMsg = $('settingsMsg');
function openSettings(prefill) {
  const s = { ...(state.settings || {}), ...(prefill || {}) };
  for (const k of ['owner', 'repo', 'token', 'passphrase']) settingsForm.elements[k].value = s[k] || '';
  settingsMsg.textContent = '';
  settingsMsg.className = 'msg';
  $('forget').hidden = !state.settings && !state.snapshot;
  settingsDlg.showModal();
  if (prefill) {
    settingsMsg.className = 'msg ok';
    settingsMsg.textContent = 'Filled in from your setup link. Type your passphrase to finish.';
    settingsForm.elements.passphrase.focus();
  }
}
document.querySelectorAll('[data-open="settingsDlg"]').forEach((b) => b.addEventListener('click', () => openSettings()));

// Setup link from the extension: https://…/#setup=<base64url {owner, repo, token}>
function takeSetupLink() {
  const m = location.hash.match(/^#setup=([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search); // wipe the token from the address bar
  try {
    let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    const v = JSON.parse(new TextDecoder().decode(b64ToBytes(b64)));
    return v.owner && v.repo && v.token ? { owner: v.owner, repo: v.repo, token: v.token } : null;
  } catch {
    return null;
  }
}
$('settingsClose').addEventListener('click', () => settingsDlg.close());
$('showSecrets').addEventListener('change', (e) => {
  for (const k of ['token', 'passphrase']) settingsForm.elements[k].type = e.target.checked ? 'text' : 'password';
});
settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = {
    owner: settingsForm.elements.owner.value.trim(),
    repo: settingsForm.elements.repo.value.trim(),
    token: settingsForm.elements.token.value.trim(),
    passphrase: settingsForm.elements.passphrase.value,
  };
  const btn = $('settingsSave');
  btn.disabled = true;
  settingsMsg.className = 'msg';
  settingsMsg.textContent = 'Connecting…';
  try {
    const store = new GitHubStore(s);
    await store.checkRepo();
    const pulled = await pullBookmarks(store, s.passphrase, null); // also proves the passphrase
    const changedRepo =
      !state.settings || state.settings.owner !== s.owner || state.settings.repo !== s.repo;
    state.settings = s;
    save(KEYS.settings, s);
    if (changedRepo && state.snapshot?.source === 'github') state.snapshot.sha = null; // force a fresh pull
    settingsMsg.className = 'msg ok';
    settingsMsg.textContent = pulled ? 'Connected.' : 'Connected, but the laptop hasn’t uploaded any bookmarks yet.';
    setTimeout(() => settingsDlg.close(), 700);
    await sync();
  } catch (err) {
    settingsMsg.className = 'msg err';
    settingsMsg.textContent = String(err?.message || err);
  } finally {
    btn.disabled = false;
  }
});
$('forget').addEventListener('click', () => {
  if (!confirm('Remove the token, passphrase and cached bookmarks from this phone? Nothing in GitHub or on your laptop is touched.')) return;
  Object.values(KEYS).forEach((k) => save(k, undefined));
  location.reload();
});

// Keep fresh: sync when you come back to the tab, and every 5 min while open.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - state.lastSync > 60000) sync();
});
window.addEventListener('online', () => sync());
setInterval(() => {
  if (document.visibilityState === 'visible') sync();
  else renderChip();
}, 5 * 60000);

// ---------- start ----------

searchEl.value = state.ui.query || '';
hideCheckedEl.checked = !!state.ui.hideChecked;
indexSnapshot();
render();
const setup = takeSetupLink();
if (setup) openSettings(setup);
else if (state.settings) sync();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
