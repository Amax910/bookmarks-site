// Phone site. Reads the encrypted bookmarks your laptop uploads to your private
// GitHub repo, decrypts them here, and shows them as real links so a
// long-press gives Brave's own menu (private tab, tab group, background tab).
//
// Gestures: swipe right = ✓ checked, swipe left = ★ highlight,
// long-press = Brave's menu (and the bookmark gets ★ highlighted).

import {
  FILES,
  GitHubStore,
  pullBookmarks,
  syncMarks,
  mergeMarks,
  sameMarks,
  isChecked,
  toCsv,
  csvToSnapshot,
  b64ToBytes,
  decryptJson,
  WrongPassphraseError,
} from './sync-core.js';

const $ = (id) => document.getElementById(id);
const listEl = $('list');
const searchEl = $('search');
const noticeEl = $('notice');
const chipEl = $('syncChip');
const nextBtn = $('nextBtn');

const SWIPE_AT = 72; // px of horizontal drag that counts as a swipe
const LONG_PRESS_MS = 2000; // fallback if the browser shows no long-press menu

// ---------- local storage (this phone only; wiped when a private tab closes) ----------

const KEYS = {
  settings: 'bl.settings',
  snapshot: 'bl.snapshot',
  marks: 'bl.marks',
  stars: 'bl.stars',
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

const savedUi = load(KEYS.ui, {});
const state = {
  settings: load(KEYS.settings, null), // { owner, repo, token, passphrase }
  snapshot: load(KEYS.snapshot, null), // { updatedAt, tree, sha, source }
  marks: load(KEYS.marks, {}), // ✓ checked   (id → ±time)
  stars: load(KEYS.stars, {}), // ★ highlight (id → ±time)
  pending: load(KEYS.pending, false),
  lastSync: load(KEYS.lastSync, 0),
  ui: {
    expanded: [],
    filter: savedUi.hideChecked ? 'todo' : 'all',
    sort: 'default',
    query: '',
    treeScroll: 0,
    tapMode: 'ask',
    ...savedUi,
  },
  loginText: null, // encrypted login.enc.json published with the site, if any
  items: [],
  byId: new Map(),
  syncing: false,
  syncError: null,
  flashId: null,
  popId: null,
};
let expanded = new Set(state.ui.expanded);

function saveUi() {
  state.ui.expanded = [...expanded];
  save(KEYS.ui, state.ui);
}

// ---------- helpers ----------

const isOpenable = (url) => /^(https?|ftp):/i.test(url || '');
const checked = (id) => isChecked(state.marks, id);
const starred = (id) => isChecked(state.stars, id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function svg(viewBox, inner, cls) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('aria-hidden', 'true');
  if (cls) s.setAttribute('class', cls);
  s.innerHTML = inner; // constant markup only
  return s;
}
const folderSvg = () => svg('0 0 24 24', '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6l2 2.2h7.4A2.5 2.5 0 0 1 21 8.7v8.8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/>');
const chevSvg = () => svg('0 0 24 24', '<path d="M9 6l6 6-6 6"/>', 'chev');

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// A coloured letter instead of a favicon: fetching real icons would tell a
// third-party icon service which sites you have bookmarked.
function avatar(url, cls = 'avatar') {
  const host = hostOf(url);
  let h = 0;
  for (const ch of host) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = el('span', cls, (host.replace(/^[^a-z0-9]+/i, '')[0] || '•').toUpperCase());
  a.style.background = `linear-gradient(135deg, hsl(${h % 360} 62% 52%), hsl(${(h + 40) % 360} 58% 42%))`;
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
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

const buzz = (ms = 12) => navigator.vibrate?.(ms);

const toastEl = $('toast');
let toastTimer;
let toastUndo = null;
function toast(text, undo) {
  $('toastText').textContent = text;
  $('toastAction').textContent = undo ? 'Undo' : '';
  toastUndo = undo || null;
  toastEl.hidden = false;
  toastEl.style.animation = 'none';
  void toastEl.offsetWidth;
  toastEl.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), undo ? 4500 : 2200);
}
$('toastAction').addEventListener('click', () => {
  toastEl.hidden = true;
  const u = toastUndo;
  toastUndo = null;
  u?.();
});

function showNotice(text) {
  noticeEl.textContent = text;
  noticeEl.hidden = !text;
}

// ---------- sorting ----------

const SORTS = [
  ['default', 'Bookmark order'],
  ['name', 'Name (A–Z)'],
  ['nameDesc', 'Name (Z–A)'],
  ['newest', 'Newest added'],
  ['oldest', 'Oldest added'],
  ['site', 'Website'],
  ['todo', 'To check first'],
];

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

// `get` turns a tree node or a list item into { title, url, date, id }.
function comparator(sort, get) {
  const name = (a, b) => collator.compare(get(a).title, get(b).title);
  switch (sort) {
    case 'name':
      return name;
    case 'nameDesc':
      return (a, b) => name(b, a);
    case 'newest':
      return (a, b) => get(b).date - get(a).date || name(a, b);
    case 'oldest':
      return (a, b) => get(a).date - get(b).date || name(a, b);
    case 'site':
      return (a, b) => collator.compare(hostOf(get(a).url), hostOf(get(b).url)) || name(a, b);
    case 'todo':
      return (a, b) => checked(get(a).id) - checked(get(b).id);
    default:
      return null; // keep your own bookmark order
  }
}
const nodeView = (n) => ({ title: n.t || n.u || '', url: n.u || '', date: n.d || 0, id: n.i });
const itemView = (it) => ({ title: it.title, url: it.url, date: it.dateAdded, id: it.id });

// A folder's children in display order: sub-folders first, then links.
function sortedChildren(nodes) {
  const folders = (nodes || []).filter((n) => !n.u);
  const links = (nodes || []).filter((n) => n.u);
  const s = state.ui.sort;
  if (s === 'name' || s === 'nameDesc') folders.sort(comparator(s, nodeView));
  const cmp = comparator(s, nodeView);
  if (cmp) links.sort(cmp);
  return { folders, links };
}

function sortItems(items) {
  const cmp = comparator(state.ui.sort, itemView);
  return cmp ? [...items].sort(cmp) : items;
}

// ---------- data ----------

function indexSnapshot() {
  state.items = [];
  state.byId.clear();
  // Same order as on screen (including the chosen sort), so "Next" follows it.
  const add = (n, path, folders) => {
    const item = { id: n.i, title: n.t || n.u, url: n.u, path: path.join(' › '), dateAdded: n.d || 0, folders };
    state.items.push(item);
    state.byId.set(n.i, item);
  };
  (function walk(nodes, path, folders) {
    const { folders: subs, links } = sortedChildren(nodes);
    for (const n of subs) walk(n.c, n.t ? [...path, n.t] : path, [...folders, n.i]);
    for (const n of links) add(n, path, folders);
  })(state.snapshot?.tree, [], []);
  if (!state.ui.expanded.length && state.snapshot?.tree?.length) {
    expanded.add(state.snapshot.tree[0].i); // open the first top-level folder on first run
  }
}

function setFlag(kind, ids, value) {
  const map = kind === 'star' ? state.stars : state.marks;
  const now = Date.now();
  for (const id of ids) map[id] = value ? now : -now;
  save(kind === 'star' ? KEYS.stars : KEYS.marks, map);
  state.pending = true;
  save(KEYS.pending, true);
  state.popId = ids.length === 1 ? ids[0] : null;
  schedulePush();
  render();
  setTimeout(() => (state.popId = null), 400);
}

function toggleCheck(item, { quiet } = {}) {
  const was = checked(item.id);
  setFlag('check', [item.id], !was);
  buzz();
  if (!quiet) toast(was ? 'Marked as not checked' : '✓ Checked', () => setFlag('check', [item.id], was));
}

function toggleStar(item, { quiet } = {}) {
  const was = starred(item.id);
  setFlag('star', [item.id], !was);
  buzz();
  if (!quiet) toast(was ? 'Highlight removed' : '★ Highlighted', () => setFlag('star', [item.id], was));
}

// ---------- sync ----------

let pushTimer;
function schedulePush(delay = 1200) {
  if (!state.settings) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => sync(), delay);
}

let syncAgain = false;
async function sync() {
  if (!state.settings) return;
  if (state.syncing) {
    syncAgain = true;
    return;
  }
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
      showNotice('No bookmarks in the repo yet. Turn on Phone sync in the Brave extension on your laptop, then tap the sync button.');
    } else {
      showNotice('');
      if (pulled.snapshot) {
        state.snapshot = { ...pulled.snapshot, sha: pulled.sha, source: 'github' };
        save(KEYS.snapshot, state.snapshot);
        indexSnapshot();
      }
    }

    // ✓ marks go both ways; ★ highlights live in their own file.
    const sentMarks = { ...state.marks };
    const sentStars = { ...state.stars };
    const [mergedMarks, mergedStars] = await Promise.all([
      syncMarks(store, pass, sentMarks, 'phone'),
      syncMarks(store, pass, sentStars, 'phone', { file: FILES.highlights }),
    ]);
    // Keep anything ticked while we were talking to GitHub.
    state.marks = mergeMarks(state.marks, mergedMarks);
    state.stars = mergeMarks(state.stars, mergedStars);
    save(KEYS.marks, state.marks);
    save(KEYS.stars, state.stars);
    state.pending = !sameMarks(state.marks, mergedMarks) || !sameMarks(state.stars, mergedStars);
    save(KEYS.pending, state.pending);

    state.lastSync = Date.now();
    save(KEYS.lastSync, state.lastSync);
  } catch (err) {
    state.syncError = String(err?.message || err);
  } finally {
    state.syncing = false;
    render();
    if (syncAgain || state.pending) {
      syncAgain = false;
      if (!state.syncError) schedulePush(300);
    }
  }
}

function renderChip() {
  const text = chipEl.querySelector('.chip-text');
  chipEl.className = 'sync';
  chipEl.title = '';
  if (!state.settings) {
    text.textContent = state.loginText ? 'Locked' : state.snapshot ? 'CSV only' : 'Not connected';
    return;
  }
  if (state.syncing) {
    chipEl.classList.add('busy');
    text.textContent = 'Syncing…';
  } else if (state.syncError) {
    chipEl.classList.add('err');
    chipEl.title = state.syncError;
    text.textContent = navigator.onLine ? 'Sync failed' : 'Offline';
  } else {
    chipEl.classList.add('ok');
    text.textContent = `Synced ${ago(state.lastSync)}`;
    chipEl.title = state.snapshot?.updatedAt ? `Laptop uploaded ${ago(state.snapshot.updatedAt)}` : '';
  }
}

chipEl.addEventListener('click', () => {
  if (!state.settings) return state.loginText ? $('unlockPass').focus() : openSettings();
  if (state.syncError) showNotice(state.syncError);
  else toast(chipEl.title || 'Syncing…');
  sync();
});

// ---------- passphrase-only unlock ----------

async function fetchLogin() {
  try {
    const r = await fetch('login.enc.json', { cache: 'no-store' });
    if (!r.ok) return null;
    const t = await r.text();
    return t.includes('"bookmark-launcher"') ? t : null;
  } catch {
    return null;
  }
}

$('unlockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pass = $('unlockPass').value;
  const msg = $('unlockMsg');
  const btn = $('unlockBtn');
  btn.disabled = true;
  msg.className = 'msg';
  msg.textContent = 'Unlocking…';
  try {
    const { value } = await decryptJson(state.loginText, pass);
    if (value.kind !== 'login' || !value.token) throw new Error('The login file is not valid. Create it again from the extension.');
    state.settings = { owner: value.owner, repo: value.repo, token: value.token, passphrase: pass };
    save(KEYS.settings, state.settings);
    msg.textContent = '';
    $('unlockPass').value = '';
    render();
    await sync();
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err instanceof WrongPassphraseError ? 'That passphrase didn’t work. Try again.' : String(err.message || err);
    buzz(60);
  } finally {
    btn.disabled = false;
  }
});

// ---------- opening bookmarks ----------

function afterOpen(item) {
  state.flashId = item.id;
  setTimeout(() => (state.flashId = null), 1200);
  // Next tick, so the tapped link finishes opening before the list redraws.
  if (!checked(item.id)) setTimeout(() => setFlag('check', [item.id], true), 0);
}

function openSame(item) {
  if (!searchEl.value.trim()) state.ui.treeScroll = window.scrollY;
  saveUi();
  afterOpen(item);
  setTimeout(() => (location.href = item.url), 30);
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
  $('askAvatar').replaceWith(Object.assign(avatar(item.url, 'avatar big'), { id: 'askAvatar' }));
  $('askTitle').textContent = item.title;
  $('askHost').textContent = item.url;
  $('askRemember').checked = false;
  const c = checked(item.id);
  const s = starred(item.id);
  $('askCheck').textContent = c ? '✓ Checked (undo)' : '✓ Mark checked';
  $('askCheck').classList.toggle('on-ok', c);
  $('askStar').textContent = s ? '★ Highlighted (undo)' : '★ Highlight';
  $('askStar').classList.toggle('on-star', s);
  askDlg.returnValue = '';
  askDlg.showModal();
}
askDlg.addEventListener('close', () => {
  const item = askItem;
  const choice = askDlg.returnValue;
  askItem = null;
  if (!item) return;
  if (choice === 'check') return toggleCheck(item);
  if (choice === 'star') return toggleStar(item);
  if (!['new', 'same', 'copy'].includes(choice)) return;
  if ($('askRemember').checked && choice !== 'copy') {
    state.ui.tapMode = choice;
    saveUi();
    toast(choice === 'new' ? 'Bookmarks will open in a new tab' : 'Bookmarks will open in this tab');
  }
  if (choice === 'new') openNew(item);
  else if (choice === 'same') openSame(item);
  else copyLink(item);
});

// Tap outside a sheet closes it.
for (const dlg of document.querySelectorAll('dialog.sheet')) {
  dlg.addEventListener('click', (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dlg.close('cancel');
  });
}

function onLinkClick(e, item, row) {
  if (row.justSwiped || row.longPressed) {
    e.preventDefault();
    return;
  }
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

// Long-press: Brave shows its own link menu (private tab, tab group,
// background tab). We can't see which option you pick, so we ★ highlight the
// bookmark to remember you went that way. Brave's menu appears after about
// half a second; once it's up, the page can't tell how long you keep holding.
function onLongPress(item, row) {
  row.longPressed = true;
  setTimeout(() => (row.longPressed = false), 800);
  if (starred(item.id)) return;
  setFlag('star', [item.id], true);
  buzz(18);
  toast('★ Highlighted (long-press)', () => setFlag('star', [item.id], false));
}

// ---------- swipe ----------

function attachGestures(row, layer, link, item) {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let tracking = false;
  let swiping = false;
  let armed = false;
  let pressTimer = null;
  const cancelPress = () => clearTimeout(pressTimer);

  row.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.target.closest('.check')) return;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    tracking = true;
    swiping = false;
    armed = false;
    cancelPress();
    if (link.tagName === 'A') pressTimer = setTimeout(() => onLongPress(item, row), LONG_PRESS_MS);
  });

  row.addEventListener('pointermove', (e) => {
    if (!tracking) return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;
    if (!swiping) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      cancelPress();
      if (Math.abs(my) >= Math.abs(mx)) {
        tracking = false; // a scroll, not a swipe
        return;
      }
      swiping = true;
      row.classList.add('swiping');
      try {
        row.setPointerCapture(e.pointerId);
      } catch {}
    }
    dx = mx;
    const a = Math.abs(dx);
    const eased = a < 140 ? a : 140 + (a - 140) * 0.3;
    layer.style.transform = `translateX(${Math.sign(dx) * eased}px)`;
    row.classList.toggle('right', dx > 0);
    row.classList.toggle('left', dx < 0);
    const nowArmed = a >= SWIPE_AT;
    if (nowArmed !== armed) {
      armed = nowArmed;
      row.classList.toggle('armed', armed);
      if (armed) buzz(8);
    }
  });

  const end = () => {
    cancelPress();
    if (!tracking) return;
    tracking = false;
    if (!swiping) return;
    row.justSwiped = true;
    setTimeout(() => (row.justSwiped = false), 400);
    layer.style.transform = '';
    row.classList.remove('swiping', 'left', 'right', 'armed');
    if (dx >= SWIPE_AT) toggleCheck(item);
    else if (dx <= -SWIPE_AT) toggleStar(item);
  };
  row.addEventListener('pointerup', end);
  row.addEventListener('pointercancel', end);
  if (link.tagName === 'A') {
    link.addEventListener('contextmenu', () => {
      cancelPress();
      onLongPress(item, row);
    });
  }
}

// ---------- rendering ----------

function passesFilter(id) {
  switch (state.ui.filter) {
    case 'todo':
      return !checked(id);
    case 'checked':
      return checked(id);
    case 'starred':
      return starred(id);
    default:
      return true;
  }
}

const indentFor = (depth) => `${16 + depth * 16}px`;

function itemRow(item, { tokens, showPath, depth = 0 } = {}) {
  const row = el('div', 'item');
  row.dataset.id = item.id;
  row.style.setProperty('--indent', indentFor(depth));
  if (checked(item.id)) row.classList.add('seen');
  if (starred(item.id)) row.classList.add('starred');
  if (state.flashId === item.id) row.classList.add('flash');
  if (state.popId === item.id) row.classList.add('pop');

  const bg = el('div', 'swipe-bg');
  bg.append(el('span', 'l', checked(item.id) ? '↺ Un-check' : '✓ Checked'), el('span', 'r', starred(item.id) ? 'Remove ★' : '★ Highlight'));

  const layer = el('div', 'layer');

  let link;
  if (isOpenable(item.url)) {
    link = el('a', 'link');
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.addEventListener('click', (e) => onLinkClick(e, item, row));
  } else {
    link = el('div', 'link'); // bookmarklets etc. can't open on a phone
    link.title = 'This bookmark can’t be opened here';
  }
  const text = el('span', 'text');
  const title = el('span', 'title');
  title.append(el('span', 'star-badge', '★'), highlight(item.title, tokens));
  const sub = el('span', 'sub');
  sub.append(highlight(showPath ? [item.path, hostOf(item.url)].filter(Boolean).join(' · ') : hostOf(item.url), tokens));
  text.append(title, sub);
  link.append(avatar(item.url), text);

  const check = el('button', 'check');
  check.type = 'button';
  check.append(el('span', null, '✓'));
  check.setAttribute('aria-label', checked(item.id) ? 'Checked. Tap to un-check' : 'Mark as checked');
  check.addEventListener('click', () => toggleCheck(item, { quiet: true }));

  layer.append(link, check);
  row.append(bg, layer);
  attachGestures(row, layer, link, item);
  return row;
}

function folderStats(node) {
  let total = 0;
  let seen = 0;
  let shown = 0;
  (function walk(n) {
    if (n.u) {
      total++;
      if (checked(n.i)) seen++;
      if (passesFilter(n.i)) shown++;
    } else (n.c || []).forEach(walk);
  })(node);
  return { total, seen, shown };
}

let justOpened = null;
function folderBlock(node, depth) {
  const stats = folderStats(node);
  if (state.ui.filter !== 'all' && !stats.shown) return null;

  const block = el('div', depth === 0 ? 'group' : 'sub-folder');
  const open = expanded.has(node.i);
  if (open) block.classList.add('open');

  const row = el('div', 'folder-row');
  row.style.setProperty('--indent', indentFor(depth));
  const icon = el('span', 'folder-icon');
  icon.append(folderSvg());
  // One short status instead of bars and counts: how many are left to check.
  const left = stats.total - stats.seen;
  let status;
  if (state.ui.filter !== 'all') status = el('span', 'left', String(stats.shown));
  else if (!stats.total) status = el('span', 'left', 'empty');
  else if (!left) status = el('span', 'left done', '✓ Done');
  else status = el('span', 'left', `${left} left`);
  status.title = `${stats.seen} of ${stats.total} checked`;
  row.append(icon, el('span', 'fname', node.t || 'Untitled folder'), status, chevSvg());
  row.addEventListener('click', () => {
    if (expanded.has(node.i)) expanded.delete(node.i);
    else {
      expanded.add(node.i);
      justOpened = node.i;
    }
    saveUi();
    render();
    justOpened = null;
  });
  block.append(row);

  if (open) {
    // Only the folder you just opened animates, not every redraw.
    const kids = el('div', justOpened === node.i ? 'children anim' : 'children');
    let shown = 0;
    const { folders, links } = sortedChildren(node.c);
    for (const c of folders) {
      const b = folderBlock(c, depth + 1);
      if (b) {
        kids.append(b);
        shown++;
      }
    }
    for (const c of links) {
      if (passesFilter(c.i)) {
        kids.append(itemRow(state.byId.get(c.i), { depth: depth + 1 }));
        shown++;
      }
    }
    if (!shown) {
      const h = el('div', 'hint-row', node.c?.length ? 'Nothing here for this filter' : 'Empty folder');
      h.style.setProperty('--indent', indentFor(depth + 1));
      kids.append(h);
    }
    block.append(kids);
  }
  return block;
}

function flatList(items, tokens, headText) {
  const frag = document.createDocumentFragment();
  frag.append(el('div', 'results-head', headText));
  const card = el('div', 'group results');
  for (const it of items) card.append(itemRow(it, { tokens, showPath: true }));
  frag.append(card);
  return frag;
}

function emptyState(icon, text) {
  const e = el('div', 'empty');
  e.append(el('span', 'big', icon), document.createTextNode(text));
  return e;
}

function renderSearch(query) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  for (const it of state.items) {
    if (!passesFilter(it.id)) continue;
    const t = it.title.toLowerCase();
    if (tokens.every((tok) => `${t}\n${it.url.toLowerCase()}\n${it.path.toLowerCase()}`.includes(tok))) {
      hits.push({ it, inTitle: tokens.every((tok) => t.includes(tok)) });
    }
  }
  if (!hits.length) {
    const f = document.createDocumentFragment();
    f.append(emptyState('🔍', `No bookmarks match “${query}”${state.ui.filter !== 'all' ? ' with this filter' : ''}.`));
    return f;
  }
  // Best matches (all words in the title) first, unless you picked a sort.
  const found =
    state.ui.sort === 'default' ? hits.sort((a, b) => b.inTitle - a.inTitle).map((h) => h.it) : sortItems(hits.map((h) => h.it));
  return flatList(found, tokens, `${hits.length} result${hits.length === 1 ? '' : 's'}`);
}

function renderStarred() {
  const starredItems = state.items.filter((it) => starred(it.id));
  const items =
    state.ui.sort === 'default' ? starredItems.sort((a, b) => state.stars[b.id] - state.stars[a.id]) : sortItems(starredItems);
  if (!items.length) {
    const f = document.createDocumentFragment();
    f.append(emptyState('★', 'Nothing highlighted yet. Swipe a bookmark left, or long-press it.'));
    return f;
  }
  return flatList(items, null, `${items.length} highlighted${state.ui.sort === 'default' ? ' · newest first' : ''}`);
}

function renderTree() {
  const frag = document.createDocumentFragment();
  const { folders, links } = sortedChildren((state.snapshot?.tree || []).filter((n) => n.u || n.c?.length));
  for (const n of folders) {
    const b = folderBlock(n, 0);
    if (b) frag.append(b);
  }
  const loose = el('div', 'group');
  for (const n of links) if (passesFilter(n.i)) loose.append(itemRow(state.byId.get(n.i)));
  if (loose.childNodes.length) frag.append(loose);
  if (!frag.childNodes.length) {
    frag.append(
      state.ui.filter === 'todo'
        ? emptyState('🎉', 'Everything is checked!')
        : emptyState('📭', state.ui.filter === 'checked' ? 'Nothing checked yet.' : 'No bookmarks yet.')
    );
  }
  return frag;
}

function renderHeader() {
  const total = state.items.length;
  let seen = 0;
  let stars = 0;
  for (const it of state.items) {
    if (checked(it.id)) seen++;
    if (starred(it.id)) stars++;
  }
  $('progress').hidden = !total;
  $('progressFill').style.width = `${total ? (seen / total) * 100 : 0}%`;
  $('progress').title = `${seen.toLocaleString()} of ${total.toLocaleString()} checked`;
  $('sortDot').hidden = state.ui.sort === 'default';
  const counts = { all: total, todo: total - seen, checked: seen, starred: stars };
  for (const b of document.querySelectorAll('.fchip')) {
    b.classList.toggle('on', b.dataset.filter === state.ui.filter);
    b.querySelector('.n').textContent = counts[b.dataset.filter].toLocaleString();
  }
  $('filters').hidden = !total;
}

let lastView = null;
function render() {
  renderChip();
  const hasData = !!state.snapshot;
  if (hasData) indexSnapshot(); // cheap; keeps order in step with sort and ✓ changes
  const locked = !state.settings && !!state.loginText;
  $('unlock').hidden = !locked || hasData;
  $('welcome').hidden = hasData || !!state.settings || locked || state.loginText === undefined;
  listEl.hidden = !hasData;
  renderHeader();
  if (!hasData) {
    nextBtn.hidden = true;
    return;
  }

  const q = searchEl.value.trim();
  const view = q ? `q:${q}:${state.ui.filter}` : `tree:${state.ui.filter}`;
  const y = window.scrollY;
  listEl.replaceChildren(q ? renderSearch(q) : state.ui.filter === 'starred' ? renderStarred() : renderTree());
  // Same view → stay put. New search → top. Back to folders → where you were.
  if (view === lastView) window.scrollTo(0, y);
  else window.scrollTo(0, q || state.ui.filter !== 'all' ? 0 : state.ui.treeScroll || 0);
  lastView = view;
  nextBtn.hidden = state.ui.filter === 'checked' || !state.items.some((it) => !checked(it.id) && passesFilter(it.id));
}

// ---------- "Next to check" ----------

function headerBottom() {
  return $('top').getBoundingClientRect().bottom;
}

let lastNextId = null;
let lastNextAt = 0;
function revealAndFlash(id) {
  const row = listEl.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
  if (!row) return false;
  lastNextId = id;
  lastNextAt = Date.now();
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  listEl.querySelectorAll('.item.flash').forEach((r) => r.classList.remove('flash'));
  void row.offsetWidth;
  row.classList.add('flash');
  return true;
}

function onScreen(row) {
  const r = row.getBoundingClientRect();
  return r.bottom > headerBottom() && r.top < window.innerHeight;
}

// Walks bookmarks in on-screen order, opening closed folders as needed.
nextBtn.addEventListener('click', () => {
  buzz();
  keepFabUntil = Date.now() + 1500;
  const flat = !!searchEl.value.trim() || state.ui.filter === 'starred';
  const allRows = [...listEl.querySelectorAll('.item')];
  // Flat views (search, ★) only walk what's listed; the folder view walks everything.
  const order = flat ? allRows.map((r) => r.dataset.id) : state.items.map((it) => it.id);
  const pos = new Map(order.map((id, i) => [id, i]));
  const rowFor = (id) => allRows.find((r) => r.dataset.id === id);

  // Where to start: just after the last jump (if it's recent or still on
  // screen, i.e. you haven't scrolled elsewhere), otherwise from the first
  // bookmark below the header.
  let from = 0;
  const last = lastNextId && rowFor(lastNextId);
  if (last && pos.has(lastNextId) && (Date.now() - lastNextAt < 2500 || onScreen(last))) {
    from = pos.get(lastNextId) + 1;
  } else {
    const limit = headerBottom() + 8;
    const firstBelow = allRows.find((r) => r.getBoundingClientRect().top > limit);
    if (firstBelow) from = pos.get(firstBelow.dataset.id) ?? 0;
    else if (allRows.length) from = (pos.get(allRows.at(-1).dataset.id) ?? -1) + 1;
  }

  const wanted = (id) => !checked(id) && passesFilter(id);
  let idx = order.findIndex((id, i) => i >= from && wanted(id));
  if (idx < 0) {
    idx = order.findIndex(wanted);
    if (idx < 0) return toast('Nothing left to check here 🎉');
    toast('Back to the start');
  }
  const id = order[idx];
  if (!rowFor(id)) {
    state.byId.get(id).folders.forEach((f) => expanded.add(f));
    saveUi();
    render();
  }
  setTimeout(() => revealAndFlash(id), 0);
});

// ---------- events ----------

// "Next" button: hide while scrolling down, back when scrolling up or idle.
let lastY = window.scrollY;
let fabTimer;
let keepFabUntil = 0; // our own jumps scroll too; don't hide the button for those
window.addEventListener(
  'scroll',
  () => {
    const y = window.scrollY;
    if (y > lastY + 6 && Date.now() > keepFabUntil) nextBtn.classList.add('away');
    else if (y < lastY - 6) nextBtn.classList.remove('away');
    lastY = y;
    clearTimeout(fabTimer);
    fabTimer = setTimeout(() => nextBtn.classList.remove('away'), 700);
  },
  { passive: true }
);

let scrollTimer;
window.addEventListener(
  'scroll',
  () => {
    if (searchEl.value.trim() || state.ui.filter !== 'all') return;
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

$('filters').addEventListener('click', (e) => {
  const b = e.target.closest('.fchip');
  if (!b || b.dataset.filter === state.ui.filter) return;
  state.ui.filter = b.dataset.filter;
  saveUi();
  buzz(6);
  render();
});

// Sort
const sortDlg = $('sortDlg');
$('sortBtn').addEventListener('click', () => {
  const box = $('sortOptions');
  box.replaceChildren(
    ...SORTS.map(([value, label]) => {
      const b = el('button', state.ui.sort === value ? 'opt on' : 'opt');
      b.value = value;
      b.append(el('span', null, label), el('span', 'tick', '✓'));
      return b;
    })
  );
  sortDlg.returnValue = '';
  sortDlg.showModal();
});
sortDlg.addEventListener('close', () => {
  const v = sortDlg.returnValue;
  if (!v || v === state.ui.sort || !SORTS.some(([k]) => k === v)) return;
  state.ui.sort = v;
  saveUi();
  lastView = null;
  render();
  window.scrollTo(0, 0);
  toast(`Sorted: ${SORTS.find(([k]) => k === v)[1]}`);
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
  const blob = new Blob([toCsv(state.items, state.marks, state.stars)], { type: 'text/csv;charset=utf-8' });
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
    const { tree, marks, highlights } = csvToSnapshot(await file.text());
    state.snapshot = { updatedAt: file.lastModified || Date.now(), tree, sha: null, source: 'csv' };
    save(KEYS.snapshot, state.snapshot);
    state.marks = mergeMarks(state.marks, marks);
    state.stars = mergeMarks(state.stars, highlights);
    save(KEYS.marks, state.marks);
    save(KEYS.stars, state.stars);
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
    const changedRepo = !state.settings || state.settings.owner !== s.owner || state.settings.repo !== s.repo;
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

// Setup link from the extension: https://…/#setup=<base64url {owner, repo, token}>
// Returns the settings, null if there's no setup part, or false if it's damaged.
function parseSetup(text) {
  let s = String(text || '');
  try {
    s = decodeURIComponent(s);
  } catch {}
  const m = s.match(/setup=([A-Za-z0-9_\-+/=\s]+)/);
  if (!m) return null;
  try {
    let b64 = m[1].replace(/\s/g, '').replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    const v = JSON.parse(new TextDecoder().decode(b64ToBytes(b64)));
    return v.owner && v.repo && v.token ? { owner: v.owner, repo: v.repo, token: v.token } : false;
  } catch {
    return false;
  }
}

function takeSetupLink() {
  if (!/setup/.test(location.hash)) return;
  const setup = parseSetup(location.hash);
  history.replaceState(null, '', location.pathname + location.search); // wipe the token from the address bar
  if (setup) {
    if (settingsDlg.open) settingsDlg.close();
    openSettings(setup);
  } else if (setup === false) {
    showNotice('That setup link looks damaged (the app you sent it with may have cut it off). Copy it again on the laptop, or paste it in ⋯ → Sync settings.');
  }
}
// Opening the link while the site is already open only changes the #part,
// which doesn't reload the page, so listen for that too.
window.addEventListener('hashchange', takeSetupLink);

$('setupPaste').addEventListener('input', (e) => {
  const v = e.target.value.trim();
  if (!v) return;
  const setup = parseSetup(v);
  e.target.value = '';
  if (setup) {
    for (const k of ['owner', 'repo', 'token']) settingsForm.elements[k].value = setup[k];
    settingsMsg.className = 'msg ok';
    settingsMsg.textContent = 'Filled in from your setup link. Type your passphrase to finish.';
    settingsForm.elements.passphrase.focus();
  } else {
    settingsMsg.className = 'msg err';
    settingsMsg.textContent = 'That doesn’t look like a complete setup link. Copy it again on the laptop.';
  }
});

// Keep fresh: sync when you come back, push right away when you leave (a
// private tab may be closed any second), and every 5 min while open.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (state.pending) sync();
  } else if (Date.now() - state.lastSync > 60000) sync();
});
window.addEventListener('online', () => sync());
setInterval(() => {
  if (document.visibilityState === 'visible') sync();
  else renderChip();
}, 5 * 60000);

// ---------- start ----------

searchEl.value = state.ui.query || '';
state.loginText = undefined; // "still checking" (keeps the welcome card from flashing)
indexSnapshot();
render();

(async () => {
  state.loginText = state.settings ? null : await fetchLogin();
  render();
  if (/setup/.test(location.hash)) takeSetupLink();
  else if (state.settings) sync();
  else if (state.loginText) $('unlockPass').focus();
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
