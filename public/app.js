/* NEXUS front-end. No inline handlers (CSP): everything goes through data-act / data-form delegation. */
import { i18n } from './i18n.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const modalRoot = $('#modal-root');

const S = {
  session: null, route: 'home', managing: false,
  browse: { genre: '', sort: 'recent', offset: 0, items: [], hasMore: false, genres: [] },
  detail: null, poll: null,
};

/* ---------- API ---------- */
async function api(path, { method = 'GET', body, keepalive } = {}) {
  const res = await fetch(path, {
    method, keepalive,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && S.session?.user && !/PIN|password/i.test(data.error || '')) { S.session = null; boot(); }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function toast(msg, bad = false) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), bad ? 6000 : 3200);
}
const fail = (e) => toast(e.message || String(e), true);

/* ---------- Helpers ---------- */
const fmtDur = (min) => (min ? (min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`) : '');
const fmtClock = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};
const avatarHtml = (p) => `<div class="avatar" style="background:${esc(p.bg)}">${esc(p.emoji)}</div>`;
const isAdmin = () => !!S.session?.user?.isAdmin && !S.session?.profile?.kids;

function closeModal() { clearInterval(S.poll); modalRoot.innerHTML = ''; document.body.classList.remove('locked'); }
function openModal(html, cls = '') {
  modalRoot.innerHTML = `<div class="overlay" data-act="overlay"><div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div></div>`;
  document.body.classList.add('locked');
  const f = $('input,select,button.btn-primary', modalRoot);
  if (f && cls !== 'detail') f.focus();
}

/* ---------- Boot ---------- */
async function boot() {
  clearInterval(S.poll);
  try { S.session = await api('/api/session'); } catch (e) {
    $('#boot').innerHTML = `<div class="card"><h1>Can't reach NEXUS</h1><p class="sub">${esc(e.message)}</p><button class="btn btn-primary" data-act="reload">Retry</button></div>`;
    return;
  }
  $('#boot').hidden = true;
  app.hidden = false;
  closeModal();
  const s = S.session;
  if (!s.user) return renderAuth(s.setupNeeded ? 'register' : 'login');
  if (!s.profile) return renderProfiles();
  renderShell();
}

/* ---------- Auth ---------- */
function renderAuth(mode) {
  const s = S.session;
  const reg = mode === 'register';
  app.innerHTML = `<div class="view center">
    <div class="logo" style="font-size:2.4rem;margin-bottom:6px">NEXUS<small>YOUR LIBRARY · REIMAGINED</small></div>
    <div class="card" style="margin-top:26px">
      ${s.setupNeeded ? '' : `<div class="tabs"><button data-act="authtab" data-m="login" class="${reg ? '' : 'on'}">Sign in</button>${s.signupOpen ? `<button data-act="authtab" data-m="register" class="${reg ? 'on' : ''}">Create account</button>` : ''}</div>`}
      <h1>${s.setupNeeded ? 'Welcome — set up NEXUS' : reg ? 'Create your account' : 'Welcome back'}</h1>
      <p class="sub">${s.setupNeeded ? 'Create the owner account. You will connect your media servers next.' : reg ? 'Then pick a profile and start watching.' : 'Sign in to continue watching.'}</p>
      <form data-form="${reg ? 'register' : 'login'}" autocomplete="on">
        ${reg ? '<label class="field"><span>Your name</span><input name="name" required maxlength="60" autocomplete="name"></label>' : ''}
        <label class="field"><span>Email</span><input name="email" type="email" required autocomplete="email"></label>
        <label class="field"><span>Password${reg ? ' (8+ characters)' : ''}</span><input name="password" type="password" required minlength="${reg ? 8 : 1}" autocomplete="${reg ? 'new-password' : 'current-password'}"></label>
        <div class="err" id="autherr" role="alert"></div>
        <button class="btn btn-primary" style="width:100%" type="submit">${reg ? 'Create account' : 'Sign in'}</button>
      </form>
    </div>
    <button class="btn btn-ghost btn-sm" data-act="lang" style="margin-top:18px">English / Français</button></div>`;
}

async function submitAuth(form, kind) {
  const btn = $('button[type=submit]', form);
  const data = Object.fromEntries(new FormData(form));
  btn.disabled = true;
  try {
    await api(`/api/auth/${kind}`, { method: 'POST', body: data });
    await boot();
  } catch (e) {
    $('#autherr').textContent = e.message;
    btn.disabled = false;
  }
}

/* ---------- Profiles ---------- */
async function renderProfiles() {
  let profiles;
  try { ({ profiles } = await api('/api/profiles')); } catch (e) { return fail(e); }
  const max = S.session.maxProfiles;
  app.innerHTML = `<div class="view center profiles ${S.managing ? 'managing' : ''}">
    <div class="logo">NEXUS</div>
    <h1>${S.managing ? 'Manage profiles' : "Who's watching?"}</h1>
    <div class="pgrid">
      ${profiles.map((p) => `<button class="pcard" data-act="${S.managing ? 'editprofile' : 'pick'}" data-id="${p.id}" data-locked="${p.locked ? 1 : 0}">
          ${avatarHtml(p)}${p.locked ? '<span class="lock" title="PIN protected">🔒</span>' : ''}
          <span class="nm">${esc(p.name)}</span>${p.kids ? '<span class="badge">Kids</span>' : ''}</button>`).join('')}
      ${profiles.length < max ? `<button class="pcard add-p" data-act="newprofile"><div class="avatar">+</div><span class="nm">Add profile</span></button>` : ''}
    </div>
    <div style="display:flex;gap:12px;margin-top:44px">
      <button class="btn btn-ghost" data-act="togglemanage">${S.managing ? 'Done' : 'Manage profiles'}</button>
      <button class="btn btn-ghost" data-act="logout">Sign out</button>
    </div></div>`;
  S.profiles = profiles;
}

async function pickProfile(id, pin) {
  try {
    await api(`/api/profiles/${id}/select`, { method: 'POST', body: pin ? { pin } : {} });
    S.managing = false;
    location.hash = '#/home';
    await boot();
  } catch (e) {
    if (pin !== undefined) { const el = $('#pinerr'); if (el) el.textContent = e.message; } else fail(e);
  }
}

function pinPrompt(id) {
  openModal(`<h2>Enter PIN</h2><form data-form="pin" data-id="${id}"><label class="field"><span>4-digit PIN</span><input name="pin" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="off" required></label><p class="hint">Forgot it? Go back, choose “Manage profiles”, open this profile and set a new PIN (your account password is required).</p><div class="err" id="pinerr" role="alert"></div><div class="row"><button type="button" class="btn btn-ghost" data-act="closemodal">Cancel</button><button class="btn btn-primary" type="submit">Unlock</button></div></form>`);
}

function profileEditor(p) {
  const av = S.session.avatars;
  const cur = p ? p.avatar : 0;
  openModal(`<h2>${p ? 'Edit profile' : 'New profile'}</h2>
    <form data-form="profile" data-id="${p ? p.id : ''}">
      <label class="field"><span>Name</span><input name="name" maxlength="24" required value="${esc(p?.name || '')}"></label>
      <div class="field"><span>Avatar</span><div class="avatars">${av.map((a, i) => `<button type="button" data-act="avatar" data-i="${i}" class="${i === cur ? 'on' : ''}" style="background:${esc(a.bg)}" aria-label="Avatar ${i + 1}">${esc(a.emoji)}</button>`).join('')}</div><input type="hidden" name="avatar" value="${cur}"></div>
      <label class="switch"><span>Kids profile<br><small class="hint">Only G / PG / TV-Y / TV-G titles are shown.</small></span><input type="checkbox" name="kids" ${p?.kids ? 'checked' : ''}></label>
      <label class="field"><span>PIN lock (optional, 4 digits)${p?.locked ? ' — leave blank to keep current' : ''}</span><input name="pin" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="off"></label>
      ${p?.locked ? '<label class="switch"><span>Remove PIN</span><input type="checkbox" name="removepin"></label>' : ''}
      ${p ? '<label class="field"><span>Account password (needed to change the PIN or Kids setting)</span><input name="password" type="password" autocomplete="current-password"></label>' : ''}
      <div class="err" id="perr" role="alert"></div>
      <div class="row">${p && S.profiles.length > 1 ? '<button type="button" class="btn btn-danger" data-act="delprofile" data-id="' + p.id + '" style="margin-right:auto">Delete</button>' : ''}
        <button type="button" class="btn btn-ghost" data-act="closemodal">Cancel</button><button class="btn btn-primary" type="submit">Save</button></div>
    </form>`);
}

async function saveProfile(form) {
  const f = new FormData(form);
  const body = { name: f.get('name'), avatar: Number(f.get('avatar')), kids: f.get('kids') === 'on' };
  const id = form.dataset.id;
  if (f.get('pin')) body.pin = f.get('pin'); else if (f.get('removepin')) body.pin = null;
  if (f.get('password')) body.password = f.get('password');
  try {
    await api(id ? `/api/profiles/${id}` : '/api/profiles', { method: id ? 'PATCH' : 'POST', body });
    closeModal();
    renderProfiles();
  } catch (e) { $('#perr').textContent = e.message; }
}

/* ---------- Shell ---------- */
const NAV = [['home', 'Home'], ['movies', 'Movies'], ['shows', 'TV Shows'], ['list', 'My List']];

function renderShell() {
  const p = S.session.profile;
  app.innerHTML = `<header class="nav" id="nav">
      <div class="logo" data-act="nav" data-r="home" style="cursor:pointer">NEXUS</div>
      <nav class="links" aria-label="Main">${NAV.map(([r, l]) => `<button data-act="nav" data-r="${r}" data-nav="${r}">${l}</button>`).join('')}</nav>
      <div class="sp"></div>
      <div class="search"><input id="q" type="search" placeholder="Search" aria-label="Search titles" autocomplete="off"></div>
      <button class="pbtn" data-act="menu" aria-label="Profile menu" aria-haspopup="true">${avatarHtml(p)}</button>
    </header>
    <main id="main"></main>
    <nav class="mnav" aria-label="Main">${NAV.map(([r, l]) => `<button data-act="nav" data-r="${r}" data-nav="${r}">${l}</button>`).join('')}</nav>`;
  onScroll();
  route();
}

function onScroll() { $('#nav')?.classList.toggle('solid', scrollY > 30); }
addEventListener('scroll', onScroll, { passive: true });

function toggleMenu() {
  const ex = $('.menu');
  if (ex) return ex.remove();
  const p = S.session.profile;
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = `<div class="who">${esc(S.session.user.name)} · ${esc(p.name)}</div>
    <button data-act="switchprofile">Switch profile</button>
    ${isAdmin() ? '<button data-act="nav" data-r="sources">Libraries &amp; sources</button>' : ''}
    <button data-act="help">Help &amp; Troubleshooting</button>
    <button data-act="chpw">Change password</button>
    <button data-act="lang">Language: English / Français</button><hr>
    <button data-act="logout">Sign out</button>`;
  document.body.append(m);
}

function go(r) { if (location.hash === `#/${r}`) route(); else location.hash = `#/${r}`; }
addEventListener('hashchange', () => { if (S.session?.profile && $('#main')) route(); });

function route() {
  clearInterval(S.poll);
  const h = location.hash.replace(/^#\//, '') || 'home';
  const [r, qs] = h.split('?');
  S.route = r;
  document.querySelectorAll('[data-nav]').forEach((b) => b.classList.toggle('on', b.dataset.nav === r));
  $('.menu')?.remove();
  scrollTo(0, 0);
  if (r === 'home') return viewHome();
  if (r === 'movies' || r === 'shows') { S.browse = { genre: '', sort: 'recent', offset: 0, items: [], hasMore: false, genres: [] }; return viewBrowse(r === 'movies' ? 'movie' : 'show', r === 'movies' ? 'Movies' : 'TV Shows'); }
  if (r === 'list') return viewList();
  if (r === 'search') return viewSearch(new URLSearchParams(qs).get('q') || '');
  if (r === 'sources' && isAdmin()) return viewSources();
  location.hash = '#/home';
}

/* ---------- Tiles ---------- */
const kidsBanner = () => (S.session?.profile?.kids
  ? '<div class="kidsbanner" role="note"><span aria-hidden="true">🧒</span><span>Kids mode is active — unrated and mature titles are hidden on this profile.</span></div>'
  : '');

function tile(it, wide = false) {
  const img = wide && it.backdrop ? it.backdrop : it.poster;
  const sub = it.progress?.label || [it.year, it.kind === 'show' ? 'Series' : fmtDur(it.durationMin)].filter(Boolean).join(' · ');
  return `<button class="tile ${wide ? 'wide' : ''}" data-act="open" data-id="${it.id}" aria-label="${esc(it.title)}">
    <div class="poster"><div class="ph">${esc(it.title)}</div>${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
    ${it.progress ? `<div class="bar"><i style="width:${Math.round(it.progress.pct * 100)}%"></i></div>` : ''}</div>
    <div class="t">${esc(it.title)}</div><div class="s">${esc(sub)}</div></button>`;
}
document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.remove(); }, true);

/* ---------- Views ---------- */
function emptyState() {
  return `<div class="empty"><div class="logo" style="font-size:2rem;margin-bottom:14px">NEXUS</div>
    <h2>Your library is empty</h2>
    ${isAdmin()
      ? `<p>Connect a Plex server to stream your own movies and shows, or add free public-domain classics to try NEXUS right away.</p>
         <div class="acts"><button class="btn btn-primary" data-act="addplex">Connect Plex</button><button class="btn btn-ghost" data-act="addclassics">Add public-domain classics</button><button class="btn btn-ghost" data-act="nav" data-r="sources">All sources</button></div>`
      : '<p>Nothing has been added yet. Ask the owner of this NEXUS to connect a library.</p>'}</div>`;
}

async function viewHome() {
  const main = $('#main');
  main.innerHTML = '<div class="center"><div class="spinner"></div></div>';
  let d;
  try { d = await api('/api/home'); } catch (e) { return fail(e); }
  if (S.route !== 'home') return;
  if (S.session.profile.kids && !d.empty && !d.rows.length && !d.hero) {
    main.innerHTML = `<div class="pagehead" style="padding-bottom:0">${kidsBanner()}</div><div class="empty" style="margin-top:6vh"><h2>Nothing to watch here yet</h2><p>This library has titles, but none are rated for Kids profiles. Ask the owner to add G or PG titles, or switch to another profile.</p></div>`;
    return;
  }
  if (d.empty || (!d.rows.length && !d.hero)) { main.innerHTML = emptyState(); return; }
  const h = d.hero;
  main.innerHTML = `${S.session.profile.kids ? `<div style="padding-top:calc(var(--nav) + 8px)">${kidsBanner()}</div>` : ''}${h ? `<section class="hero"><div class="bg" style="background-image:url('${esc(h.backdrop || h.poster || '')}')"></div><div class="in">
      <div class="eyebrow">Featured ${h.kind === 'show' ? 'series' : 'film'}</div><h1>${esc(h.title)}</h1>
      <div class="meta">${h.rating ? `<span class="sc">★ ${h.rating.toFixed(1)}</span>` : ''}${h.year ? `<span>${h.year}</span>` : ''}${h.contentRating ? `<span class="pill">${esc(h.contentRating)}</span>` : ''}${h.durationMin ? `<span>${fmtDur(h.durationMin)}</span>` : ''}${h.genres.slice(0, 3).map((g) => `<span>${esc(g)}</span>`).join('')}</div>
      <p style="margin-top:14px">${esc(h.summary)}</p>
      <div class="acts">${h.kind === 'movie' ? `<button class="btn btn-primary" data-act="play" data-id="${h.id}">▶ ${h.progress ? 'Resume' : 'Play'}</button>` : ''}<button class="btn btn-ghost" data-act="open" data-id="${h.id}">ⓘ ${h.kind === 'show' ? 'Episodes' : 'More info'}</button></div>
    </div></section>` : '<div class="no-hero"></div>'}
    ${d.rows.map((r) => `<div class="rowh" data-row="${esc(r.id)}"><h2>${esc(r.title)}</h2></div><div class="scroller" data-row="${esc(r.id)}">${r.items.map((i) => (r.id === 'continue' ? `<div class="tilewrap">${tile(i, true)}<button class="dismiss" data-act="dismiss" data-id="${i.id}" aria-label="Remove ${esc(i.title)} from Continue Watching" title="Remove from Continue Watching">✕</button></div>` : tile(i, !!r.wide))).join('')}</div>`).join('')}`;
}

async function viewBrowse(kind, title) {
  const main = $('#main');
  const b = S.browse;
  if (!b.items.length && !b.loaded) main.innerHTML = '<div class="center"><div class="spinner"></div></div>';
  const p = new URLSearchParams({ kind, sort: b.sort, offset: b.offset });
  if (b.genre) p.set('genre', b.genre);
  let d;
  try { d = await api(`/api/browse?${p}`); } catch (e) { return fail(e); }
  b.items = b.offset ? [...b.items, ...d.items] : d.items;
  b.hasMore = d.hasMore; b.genres = d.genres; b.loaded = true;
  drawBrowse(kind, title);
}

function drawBrowse(kind, title) {
  const b = S.browse;
  $('#main').innerHTML = `<div class="pagehead"><h1>${esc(title)}</h1>${kidsBanner()}
    <div class="chips"><button class="chip ${b.genre ? '' : 'on'}" data-act="genre" data-g="">All</button>
      ${b.genres.slice(0, 14).map((g) => `<button class="chip ${b.genre === g.genre ? 'on' : ''}" data-act="genre" data-g="${esc(g.genre)}">${esc(g.genre)}</button>`).join('')}
      <select id="sort" aria-label="Sort"><option value="recent">Recently added</option><option value="title">A–Z</option><option value="rating">Top rated</option><option value="year">Newest release</option></select></div></div>
    ${b.items.length ? `<div class="grid">${b.items.map((i) => tile(i)).join('')}</div>` : '<div class="empty"><p>Nothing here yet.</p></div>'}
    ${b.hasMore ? '<div style="text-align:center;margin-top:28px"><button class="btn btn-ghost" data-act="more">Load more</button></div>' : ''}`;
  $('#sort').value = b.sort;
  $('#sort').dataset.kind = kind; $('#sort').dataset.title = title;
}

async function viewList() {
  try {
    const { items } = await api('/api/mylist');
    $('#main').innerHTML = `<div class="pagehead"><h1>My List</h1>${kidsBanner()}</div>${items.length ? `<div class="grid">${items.map((i) => tile(i)).join('')}</div>` : '<div class="empty"><p>Titles you add with “+ My List” show up here.</p></div>'}`;
  } catch (e) { fail(e); }
}

async function viewSearch(q) {
  try {
    const d = await api(`/api/browse?q=${encodeURIComponent(q)}&limit=60`);
    $('#main').innerHTML = `<div class="pagehead"><h1>${q ? `Results for “${esc(q)}”` : 'Search'}</h1>${kidsBanner()}</div>${d.items.length ? `<div class="grid">${d.items.map((i) => tile(i)).join('')}</div>` : '<div class="empty"><p>No matches in your library.</p></div>'}`;
  } catch (e) { fail(e); }
}

/* ---------- Detail ---------- */
async function openDetail(id) {
  openModal('<div class="center" style="min-height:300px"><div class="spinner"></div></div>', 'detail');
  let d;
  try { d = await api(`/api/items/${id}`); } catch (e) { closeModal(); return fail(e); }
  S.detail = d;
  drawDetail(d, d.seasons?.[0]?.key);
}

function drawDetail(d, seasonKey) {
  const it = d.item;
  const season = d.seasons?.find((s) => s.key === seasonKey) || d.seasons?.[0];
  const firstEp = d.seasons?.flatMap((s) => s.episodes)[0];
  const resumeEp = it.progress?.epKey || '';
  const bg = it.backdrop || it.poster;
  modalRoot.querySelector('.modal').innerHTML = `<button class="x" data-act="closemodal" aria-label="Close">✕</button>
    <div class="top" style="${bg ? `background-image:url('${esc(bg)}')` : ''}"><div>
      <h2>${esc(it.title)}</h2>
      <div class="meta">${it.rating ? `<span class="sc">★ ${it.rating.toFixed(1)}</span>` : ''}${it.year ? `<span>${it.year}</span>` : ''}${it.contentRating ? `<span class="pill">${esc(it.contentRating)}</span>` : ''}${it.durationMin ? `<span>${fmtDur(it.durationMin)}</span>` : ''}${it.kind === 'show' ? '<span>Series</span>' : ''}${it.genres.map((g) => `<span>${esc(g)}</span>`).join('')}</div></div></div>
    <div class="body">
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${it.kind === 'movie' || resumeEp || firstEp ? `<button class="btn btn-primary" data-act="play" data-id="${it.id}" data-ep="${esc(it.kind === 'show' ? resumeEp || firstEp?.key || '' : '')}">▶ ${it.progress ? 'Resume' : 'Play'}${it.progress?.label ? ` ${esc(it.progress.label)}` : ''}</button>` : ''}
        <button class="btn btn-ghost" data-act="mylist" data-id="${it.id}">${it.inList ? '✓ In My List' : '+ My List'}</button>
        ${isAdmin() && it.source === 'direct' ? `<button class="btn btn-danger" data-act="rmitem" data-id="${it.id}">Remove</button>` : ''}
      </div>
      <p class="sum">${esc(it.summary || 'No description available.')}</p>
      ${d.episodesError ? `<p class="err">Could not load episodes: ${esc(d.episodesError)}</p>` : ''}
      ${season ? `<div class="eps"><header><h3>Episodes</h3><select data-change="season">${d.seasons.map((s) => `<option value="${esc(s.key)}" ${s.key === season.key ? 'selected' : ''}>${esc(s.title)}</option>`).join('')}</select></header>
        ${season.episodes.map((e) => { const w = d.watched?.[e.key] || 0; return `<button class="ep" data-act="play" data-id="${it.id}" data-ep="${esc(e.key)}"><span class="n">${e.index}</span><span class="i"><b>${esc(e.title)}</b><span>${esc(e.summary)}</span>${w > 0.02 ? `<div class="w"><i style="width:${Math.min(100, Math.round(w * 100))}%"></i></div>` : ''}</span><span class="d">${e.durationMs ? fmtDur(Math.round(e.durationMs / 60000)) : ''}</span></button>`; }).join('')}</div>` : ''}
      ${d.related?.length ? `<div class="related"><h3>More like this</h3><div class="scroller">${d.related.map((r) => tile(r)).join('')}</div></div>` : ''}
    </div>`;
}

/* ---------- Player ---------- */
const P = { video: null, hls: null, info: null, itemId: 0, timer: 0, idle: 0, onKey: null, lastSave: 0, stall: 0, drag: false, recovery: false, lastError: '' };

async function startPlayback(itemId, epKey = '', opts = {}) {
  let info;
  try {
    const q = new URLSearchParams();
    if (epKey) q.set('ep', epKey);
    if (opts.mode) q.set('mode', opts.mode);
    if (opts.kbps) q.set('kbps', opts.kbps);
    info = await api(`/api/items/${itemId}/play?${q}`);
  } catch (e) { return fail(e); }
  closeModal();
  teardownPlayer(false);
  if (opts.startMs != null) info.startMs = opts.startMs;
  P.info = info; P.itemId = itemId; P.opts = opts; P.drag = false; P.recovery = false; P.lastError = ''; clearTimeout(P.stall);

  let el = $('#player');
  if (!el) { el = document.createElement('div'); el.id = 'player'; document.body.append(el); }
  document.body.classList.add('locked');
  const next = findNext(itemId, info.epKey);
  const isPlex = !!info.plex; P.isPlex = isPlex;
  el.className = '';
  el.innerHTML = `<video playsinline preload="auto"></video>
    <div class="chrome" id="chrome">
      <div class="ptop"><button class="back" data-act="closeplayer" aria-label="Back">←</button><div><b>${esc(info.title)}</b><small>${esc(info.epLabel || '')}</small></div></div>
      <div class="msg" id="pmsg"></div>
      <div class="pbot">
        <div class="seek" id="seek" role="slider" aria-label="Seek" tabindex="0"><div class="tip" id="tip" hidden>0:00</div><div class="tr"><div class="buf" id="buf"></div><div class="pos" id="pos"></div></div></div>
        <div class="ctl">
          <button data-act="ptoggle" id="pp" aria-label="Play or pause">▶</button>
          <button data-act="pseek" data-d="-10" aria-label="Back 10 seconds">⟲</button>
          <button data-act="pseek" data-d="10" aria-label="Forward 10 seconds">⟳</button>
          <button data-act="pmute" id="mute" aria-label="Mute">🔊</button><input type="range" id="vol" min="0" max="1" step="0.05" value="1" aria-label="Volume">
          <span class="time" id="time">0:00 / 0:00</span><span class="sp"></span>
          ${isPlex && info.relay ? '<span class="relay" title="Your Plex server is connected through Plex Relay, which Plex limits to low bitrates. Enable Remote Access on the server for HD.">● Relay — quality limited</span>' : ''}
          ${isPlex ? `<select id="qual" aria-label="Quality"><option value="">Auto</option><option value="8000">1080p · 8 Mbps</option><option value="4000">720p · 4 Mbps</option><option value="2000">480p · 2 Mbps</option></select>` : ''}
          ${next ? '<button data-act="pnext" aria-label="Next episode" title="Next episode">⏭</button>' : ''}
          <button data-act="pfull" aria-label="Fullscreen">⛶</button>
        </div></div></div>`;
  const v = P.video = $('video', el);
  if (isPlex) { const q = $('#qual'); q.value = opts.kbps ? String(opts.kbps) : ''; }

  v.addEventListener('loadedmetadata', () => { if (info.startMs > 5000 && !P.resumed) { v.currentTime = info.startMs / 1000; } P.resumed = true; });
  v.addEventListener('timeupdate', onTime);
  v.addEventListener('progress', onTime);
  v.addEventListener('play', () => { $('#pp').textContent = '⏸'; });
  v.addEventListener('pause', () => { $('#pp').textContent = '▶'; saveProgress(); });
  v.addEventListener('waiting', () => {
    if (P.recovery) return;
    $('#pmsg').innerHTML = '<div class="spinner"></div>';
    clearTimeout(P.stall);
    P.stall = setTimeout(() => showRecovery('This is taking longer than expected.', 'Buffering for more than 10 seconds'), 10_000);
  });
  v.addEventListener('playing', () => { clearTimeout(P.stall); P.recovery = false; $('#pmsg').innerHTML = ''; });
  v.addEventListener('ended', () => { saveProgress(true); if (next) $('#pmsg').innerHTML = '<div><button class="btn btn-primary" data-act="pnext">Next episode ⏭</button></div>'; });
  v.addEventListener('error', onVideoError);
  P.resumed = false;
  attachSource(v, info);

  P.timer = setInterval(() => { if (!v.paused) saveProgress(); }, 10_000);
  wireIdle(el);
  P.onKey = (e) => {
    if (/INPUT|SELECT/.test(e.target.tagName) && e.key !== 'Escape') return;
    const k = e.key;
    if (k === ' ' || k === 'k') { e.preventDefault(); togglePlay(); }
    else if (k === 'ArrowRight') seekBy(10);
    else if (k === 'ArrowLeft') seekBy(-10);
    else if (k === 'f') toggleFull();
    else if (k === 'm') { v.muted = !v.muted; }
    else if (k === 'Escape' && !document.fullscreenElement) closePlayer();
  };
  addEventListener('keydown', P.onKey);
}

function attachSource(v, info) {
  P.hls?.destroy(); P.hls = null;
  const err = (m, detail) => showRecovery(m, detail || m);
  if (info.type === 'hls') {
    if (window.Hls?.isSupported()) {
      const hls = P.hls = new Hls({ maxBufferLength: 40, enableWorker: true });
      hls.loadSource(info.url);
      hls.attachMedia(v);
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR && d.details !== 'manifestLoadError') return hls.startLoad();
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR) return hls.recoverMediaError();
        err('This stream could not be played.', `HLS ${d.type}: ${d.details}`);
      });
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) v.src = info.url;
    else return err('This browser cannot play this kind of stream.', 'HLS unsupported');
  } else v.src = info.url;
  v.play().catch(() => { /* needs a tap — controls are visible */ });
}

function onVideoError() {
  const info = P.info;
  if (info?.mode === 'direct' && /\/proxy\?/.test(info.url) && !P.opts?.mode) {
    toast('Switching to compatibility mode…');
    return startPlayback(P.itemId, info.epKey, { mode: 'hls', startMs: (P.video?.currentTime || 0) * 1000 });
  }
  const code = P.video?.error?.code;
  showRecovery(`This video could not be played${info?.mode === 'direct' && !P.isPlex ? ' — the link may be offline or in a format your browser does not support' : ''}.`, `Media error ${code ?? '?'} ${P.video?.error?.message || ''}`.trim());
}

/** Friendly recovery card: lower quality (Plex only), retry, copy diagnostics. */
function showRecovery(message, detail) {
  clearTimeout(P.stall);
  P.recovery = true;
  P.lastError = detail || message;
  const el = $('#player'); el?.classList.remove('idle');
  const msg = $('#pmsg'); if (!msg) return;
  msg.innerHTML = `<div class="recover" role="alert"><h3>Having trouble playing this?</h3><p>${esc(message)}</p>
    <div class="acts">${P.isPlex ? '<button class="btn btn-primary" data-act="plower">Try lower quality (480p)</button>' : ''}
    <button class="btn ${P.isPlex ? 'btn-ghost' : 'btn-primary'}" data-act="pretry">Retry</button>
    <button class="btn btn-ghost" data-act="copysupport">Copy error info</button></div>
    <button class="btn btn-ghost btn-sm" data-act="closeplayer" style="margin-top:12px">Close</button></div>`;
}

function supportInfo() {
  const p = S.session?.profile;
  const i = P.info;
  return [
    'NEXUS support info',
    `Time: ${new Date().toISOString()}`,
    `Browser: ${navigator.userAgent}`,
    `Screen: ${screen.width}x${screen.height} @${devicePixelRatio}x · Language: ${i18n.lang}`,
    `Profile: ${p ? `${p.name}${p.kids ? ' (Kids)' : ''}` : 'none'} · Account: ${S.session?.user?.email || 'signed out'}`,
    i ? `Stream: ${i.type}/${i.mode}${i.relay ? ' via Plex Relay' : ''} · Title: ${i.title}` : 'Stream: none active',
    `Last error: ${P.lastError || 'none'}`,
  ].join('\n');
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.append(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
  return ok;
}

function onTime() {
  const v = P.video; if (!v) return;
  const d = v.duration || (P.info.durationMs ? P.info.durationMs / 1000 : 0);
  if (!P.drag) $('#pos').style.width = d ? `${(v.currentTime / d) * 100}%` : '0';
  const b = v.buffered; $('#buf').style.width = d && b.length ? `${(b.end(b.length - 1) / d) * 100}%` : '0';
  $('#time').textContent = `${fmtClock(v.currentTime)} / ${fmtClock(d)}`;
}

function saveProgress(done = false) {
  const v = P.video; if (!v || !P.info) return;
  const dur = (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : (P.info.durationMs || 0) / 1000);
  if (!dur || v.currentTime < 1) return;
  api('/api/progress', { method: 'POST', keepalive: true, body: {
    itemId: P.itemId, epKey: P.info.epKey || '', epLabel: P.info.epLabel,
    positionMs: done ? dur * 1000 : v.currentTime * 1000, durationMs: dur * 1000,
  } }).catch(() => {});
}

function togglePlay() { const v = P.video; if (v) v.paused ? v.play() : v.pause(); }
function seekBy(s) { const v = P.video; if (v) v.currentTime = Math.max(0, Math.min((v.duration || 1e9), v.currentTime + s)); }
function toggleFull() { const el = $('#player'); document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.(); }

function wireIdle(el) {
  const wake = () => { el.classList.remove('idle'); clearTimeout(P.idle); P.idle = setTimeout(() => { if (P.video && !P.video.paused && !P.recovery && !P.drag) el.classList.add('idle'); }, 3000); };
  el.onmousemove = el.ontouchstart = wake; wake();
  wireSeek();
  $('#vol').addEventListener('input', (e) => { P.video.volume = Number(e.target.value); P.video.muted = false; });
  el.addEventListener('dblclick', (e) => { if (e.target.tagName === 'VIDEO') toggleFull(); });
  el.addEventListener('click', (e) => { if (e.target.tagName === 'VIDEO') togglePlay(); });
  $('#qual')?.addEventListener('change', (e) => {
    const kbps = Number(e.target.value) || 0;
    const t = P.video.currentTime;
    saveProgress();
    startPlayback(P.itemId, P.info.epKey, { mode: 'hls', kbps: kbps || undefined, startMs: t * 1000 });
  });
}

/** Click, mouse-drag and touch-drag scrubbing with a timestamp tooltip. Commits the seek on release. */
function wireSeek() {
  const seek = $('#seek'), tip = $('#tip');
  const dur = () => (Number.isFinite(P.video?.duration) && P.video.duration > 0 ? P.video.duration : (P.info.durationMs || 0) / 1000);
  const frac = (e) => { const r = seek.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  const show = (e) => { const f = frac(e); tip.hidden = false; tip.style.left = `${f * 100}%`; tip.textContent = fmtClock(f * dur()); return f; };
  seek.addEventListener('pointermove', (e) => { const f = show(e); if (P.drag) $('#pos').style.width = `${f * 100}%`; });
  seek.addEventListener('pointerleave', () => { if (!P.drag) tip.hidden = true; });
  seek.addEventListener('pointerdown', (e) => { P.drag = true; seek.setPointerCapture(e.pointerId); $('#pos').style.width = `${show(e) * 100}%`; });
  seek.addEventListener('pointerup', (e) => {
    if (!P.drag) return;
    P.drag = false;
    const d = dur();
    if (P.video && d) P.video.currentTime = frac(e) * d;
    tip.hidden = true;
  });
  seek.addEventListener('pointercancel', () => { P.drag = false; tip.hidden = true; });
}

function findNext(itemId, epKey) {
  const seasons = S.detail?.item?.id === itemId ? S.detail.seasons : null;
  if (!seasons || !epKey) return null;
  const all = seasons.flatMap((s) => s.episodes);
  const i = all.findIndex((e) => e.key === epKey);
  return i >= 0 ? all[i + 1] || null : null;
}

function teardownPlayer(removeEl) {
  clearInterval(P.timer); clearTimeout(P.idle); clearTimeout(P.stall);
  if (P.onKey) removeEventListener('keydown', P.onKey);
  P.onKey = null;
  P.hls?.destroy(); P.hls = null;
  if (P.video) { P.video.removeAttribute('src'); P.video.load(); }
  P.video = null;
  if (removeEl) $('#player')?.remove();
}

function closePlayer() {
  saveProgress();
  const info = P.info;
  if (info?.session) api(`/api/sources/${info.sourceId}/stop`, { method: 'POST', body: { session: info.session }, keepalive: true }).catch(() => {});
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  teardownPlayer(true);
  P.info = null;
  document.body.classList.remove('locked');
  if (S.route === 'home') viewHome(); else if (S.route === 'list') viewList();
}

/* ---------- Sources (owner) ---------- */
const ICON = { plex: '▶', archive: '🏛', direct: '🔗' };

async function viewSources() {
  const main = $('#main');
  let src, st, users;
  try { [{ sources: src }, st, { users }] = await Promise.all([api('/api/sources'), api('/api/settings'), api('/api/users')]); } catch (e) { return fail(e); }
  if (S.route !== 'sources') return;
  main.innerHTML = `<div class="panel"><h1>Libraries &amp; sources</h1>
    <p class="sub">Everything here feeds your NEXUS library. Plex streams are relayed by this server, so your Plex token never reaches a browser.</p>
    <div class="sect"><h3>Connected</h3>${src.length ? src.map((s) => `<div class="src"><div class="ic">${ICON[s.type] || '•'}</div>
      <div class="i"><b>${esc(s.name)}</b><span>${esc({ plex: 'Plex', archive: 'Internet Archive', direct: 'Direct links' }[s.type] || s.type)}${s.host ? ` · ${esc(s.host)}` : ''} · ${s.itemCount} titles${s.lastSync ? ` · synced ${new Date(s.lastSync).toLocaleString()}` : ''}</span>${s.lastError ? `<div class="err" style="margin:4px 0 0">${esc(s.lastError)}</div>` : ''}</div>
      ${s.via === 'relay' ? '<span class="st relay" title="Connected through Plex Relay, which Plex limits to low bitrates. Enable Remote Access on the server for HD.">Relay · limited quality</span>' : ''}<span class="st ${esc(s.status)}">${esc(s.status === 'ok' ? 'Ready' : s.status)}</span>
      ${s.syncable ? `<button class="btn btn-ghost btn-sm" data-act="syncsrc" data-id="${s.id}">Sync</button>` : ''}
      <button class="btn btn-danger btn-sm" data-act="rmsrc" data-id="${s.id}" data-name="${esc(s.name)}">Remove</button></div>`).join('') : '<p class="hint">Nothing connected yet.</p>'}</div>
    <div class="sect"><h3>Add titles</h3><div class="addgrid">
      <button class="addcard" data-act="addplex"><div class="ic">▶</div><b>Plex server</b><span>Sign in with Plex or enter your server address. Your local or remote library, with posters and episodes.</span></button>
      <button class="addcard" data-act="addarchive"><div class="ic">🏛</div><b>Internet Archive</b><span>Import free public-domain feature films. Plays straight from archive.org.</span></button>
      <button class="addcard" data-act="addlink"><div class="ic">🔗</div><b>Video link</b><span>Add a single title from an MP4, WebM or HLS (.m3u8) URL you are allowed to stream.</span></button></div></div>
    <div class="sect"><h3>Access</h3><label class="switch"><span>Allow others to create accounts<br><small class="hint">Off by default. Turn on briefly to let family or testers sign up, then switch it off.</small></span><input type="checkbox" data-change="signup" ${st.openSignup ? 'checked' : ''}></label>
      <h3 style="margin-top:18px">People with an account</h3>
      ${users.map((u) => `<div class="src"><div class="ic">👤</div><div class="i"><b>${esc(u.name)}</b><span>${esc(u.email)}${u.isAdmin ? ' · Owner' : ''}</span></div>${u.id !== S.session.user.id ? `<button class="btn btn-ghost btn-sm" data-act="resetpw" data-id="${u.id}" data-name="${esc(u.name)}">Reset password</button>` : ''}</div>`).join('')}</div></div>`;
  if (src.some((s) => s.status === 'syncing')) S.poll = setInterval(() => { if (S.route === 'sources' && !modalRoot.innerHTML) viewSources(); }, 3000);
}

function plexModal() {
  openModal(`<h2>Connect Plex</h2>
    <div id="plexbody"><p class="hint" style="margin-bottom:14px">NEXUS needs to reach your server from where NEXUS runs. At home that is your LAN address; online it is your Plex Remote Access address.</p>
      <button class="btn btn-primary" style="width:100%" data-act="plexsignin">Sign in with Plex</button>
      <details class="adv"><summary>Advanced: Connect manually</summary>
      <form data-form="plexmanual"><label class="field"><span>Server address</span><input name="url" placeholder="http://192.168.1.20:32400" required></label>
        <label class="field"><span>Plex token</span><input name="token" type="password" autocomplete="off" required></label>
        <label class="field"><span>Display name (optional)</span><input name="name" maxlength="60"></label>
        <div class="err" id="perr" role="alert"></div>
        <div class="row"><button type="button" class="btn btn-ghost" data-act="closemodal">Cancel</button><button class="btn btn-primary" type="submit">Connect</button></div></form></details>
      <div class="row" style="margin-top:12px"><button type="button" class="btn btn-ghost" data-act="closemodal">Cancel</button></div></div>`);
}

async function plexSignIn() {
  const win = window.open('about:blank', '_blank');
  const body = $('#plexbody');
  body.innerHTML = '<div style="text-align:center;padding:24px"><div class="spinner" style="margin:auto"></div><p class="hint" style="margin-top:14px">Waiting for you to approve NEXUS in the Plex window…</p></div>';
  let pin;
  try { pin = await api('/api/sources/plex/pin', { method: 'POST', body: {} }); } catch (e) { win?.close(); body.innerHTML = `<p class="err">${esc(e.message)}</p><button class="btn btn-ghost" data-act="addplex">Back</button>`; return; }
  if (win) { win.opener = null; win.location = pin.authUrl; } else body.insertAdjacentHTML('beforeend', `<p class="hint" style="text-align:center">Popup blocked — <a href="${esc(pin.authUrl)}" target="_blank" rel="noopener">open Plex sign-in</a>.</p>`);
  const until = Date.now() + 5 * 60_000;
  S.poll = setInterval(async () => {
    if (!$('#plexbody') || Date.now() > until) return clearInterval(S.poll);
    try {
      const r = await api(`/api/sources/plex/pin/${pin.id}?code=${encodeURIComponent(pin.code)}`);
      if (!r.authorized) return;
      clearInterval(S.poll);
      $('#plexbody').innerHTML = r.servers.length
        ? `<p class="hint" style="margin-bottom:12px">Choose a server to add:</p><div class="srvlist">${r.servers.map((s) => `<button data-act="plexpick" data-h="${esc(r.handle)}" data-i="${s.index}"><span>${esc(s.name)}</span><span class="hint">${s.owned ? 'Yours' : 'Shared with you'}</span></button>`).join('')}</div><div class="err" id="perr"></div>`
        : '<p class="err">No Plex servers were found on that account.</p>';
    } catch (e) { clearInterval(S.poll); $('#plexbody').innerHTML = `<p class="err">${esc(e.message)}</p><button class="btn btn-ghost" data-act="addplex">Try again</button>`; }
  }, 2000);
}

async function plexPick(h, i, btn) {
  btn.disabled = true;
  try {
    await api('/api/sources/plex/connect', { method: 'POST', body: { handle: h, index: Number(i) } });
    closeModal(); toast('Server connected — syncing your library…'); go('sources');
  } catch (e) { btn.disabled = false; const el = $('#perr'); if (el) el.textContent = e.message; }
}

function archiveModal() {
  openModal(`<h2>Import from Internet Archive</h2><p class="hint" style="margin-bottom:14px">Free, public-domain feature films. Leave the search blank for the most-watched classics.</p>
    <form data-form="archive"><label class="field"><span>Search within the collection (optional)</span><input name="query" maxlength="120" placeholder="e.g. noir, western, horror"></label>
      <label class="field"><span>How many titles</span><select name="limit"><option>20</option><option selected>40</option><option>80</option></select></label>
      <div class="err" id="perr" role="alert"></div><div class="row"><button type="button" class="btn btn-ghost" data-act="closemodal">Cancel</button><button class="btn btn-primary" type="submit">Import</button></div></form>`);
}

function linkModal() {
  openModal(`<h2>Add a video link</h2><form data-form="link">
      <label class="field"><span>Title</span><input name="title" required maxlength="140"></label>
      <label class="field"><span>Video URL (MP4, WebM or .m3u8)</span><input name="url" type="url" required placeholder="https://…"></label>
      <label class="field"><span>Poster image URL (optional)</span><input name="poster" type="url"></label>
      <label class="field"><span>Year (optional)</span><input name="year" inputmode="numeric" maxlength="4"></label>
      <label class="field"><span>Description (optional)</span><input name="summary" maxlength="800"></label>
      <p class="hint">HLS links and links on other domains must allow cross-origin playback (CORS).</p>
      <div class="err" id="perr" role="alert"></div><div class="row"><button type="button" class="btn btn-ghost" data-act="closemodal">Cancel</button><button class="btn btn-primary" type="submit">Add</button></div></form>`);
}

function helpModal() {
  openModal(`<h2>Help &amp; Troubleshooting</h2>
    <div class="helpcards">
      <div class="helpcard"><b>🎞️ Video buffering or blurry?</b><p>Open the player and use the <em>Quality</em> menu at the bottom right: switch from Auto to 720p or 480p. If it still stalls, tap <em>Try lower quality</em> on the message that appears. Titles added by link play at their original quality, so check your connection.</p></div>
      <div class="helpcard"><b>🔎 Missing movies or shows?</b><p>Kids profiles hide unrated and mature titles (including many classic films). New Plex titles appear within about 6 hours; the owner can press <em>Sync</em> under Libraries &amp; sources to refresh right away.</p></div>
      <div class="helpcard"><b>🔑 Forgot a PIN or password?</b><p>PIN: choose <em>Switch profile</em> → <em>Manage profiles</em>, open the profile and set a new PIN (your account password is required). Password: ask the account owner to reset it for you, then change it from the profile menu.</p></div>
    </div>
    <div class="row"><button class="btn btn-ghost" data-act="copysupport">Copy support info</button><button class="btn btn-primary" data-act="closemodal">Close</button></div>`);
}

function changePwModal() {
  openModal(`<h2>Change password</h2><form data-form="chpw" autocomplete="off">
    <label class="field"><span>Current password</span><input name="current" type="password" autocomplete="current-password" required></label>
    <label class="field"><span>New password (8+ characters)</span><input name="next" type="password" minlength="8" autocomplete="new-password" required></label>
    <label class="field"><span>Confirm new password</span><input name="confirm" type="password" minlength="8" autocomplete="new-password" required></label>
    <p class="hint">Other devices will be signed out.</p><div class="err" id="perr" role="alert"></div>
    <div class="row"><button type="button" class="btn btn-ghost" data-act="closemodal">Cancel</button><button class="btn btn-primary" type="submit">Update password</button></div></form>`);
}

/* ---------- Event delegation ---------- */
const A = {
  reload: () => location.reload(),
  lang: () => { i18n.toggle(); },
  overlay: (el, e) => { if (e.target === el) closeModal(); },
  closemodal: closeModal,
  authtab: (el) => renderAuth(el.dataset.m),
  logout: async () => { try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* ignore */ } S.managing = false; $('.menu')?.remove(); boot(); },
  togglemanage: () => { S.managing = !S.managing; renderProfiles(); },
  pick: (el) => (el.dataset.locked === '1' ? pinPrompt(el.dataset.id) : pickProfile(el.dataset.id)),
  editprofile: (el) => profileEditor(S.profiles.find((p) => String(p.id) === el.dataset.id)),
  newprofile: () => profileEditor(null),
  avatar: (el) => { $('input[name=avatar]', modalRoot).value = el.dataset.i; modalRoot.querySelectorAll('.avatars button').forEach((b) => b.classList.toggle('on', b === el)); },
  delprofile: async (el) => { if (!confirm(i18n.t('Delete this profile and its watch history?'))) return; try { await api(`/api/profiles/${el.dataset.id}`, { method: 'DELETE' }); closeModal(); renderProfiles(); } catch (e) { fail(e); } },
  menu: (el, e) => { e.stopPropagation(); toggleMenu(); },
  switchprofile: async () => { await api('/api/profile/leave', { method: 'POST', body: {} }).catch(fail); boot(); },
  nav: (el) => go(el.dataset.r),
  open: (el) => openDetail(el.dataset.id),
  play: (el) => startPlayback(Number(el.dataset.id), el.dataset.ep || ''),
  mylist: async (el) => {
    const it = S.detail.item;
    try { await api(`/api/mylist/${it.id}`, { method: it.inList ? 'DELETE' : 'POST', body: it.inList ? undefined : {} }); it.inList = !it.inList; drawDetail(S.detail, $('.eps select')?.value); toast(it.inList ? 'Added to My List' : 'Removed from My List'); } catch (e) { fail(e); }
  },
  rmitem: async (el) => { if (!confirm('Remove this title?')) return; try { await api(`/api/items/${el.dataset.id}`, { method: 'DELETE' }); closeModal(); route(); } catch (e) { fail(e); } },
  genre: (el) => { S.browse.genre = el.dataset.g; S.browse.offset = 0; viewBrowse(S.route === 'movies' ? 'movie' : 'show', S.route === 'movies' ? 'Movies' : 'TV Shows'); },
  more: () => { S.browse.offset = S.browse.items.length; viewBrowse(S.route === 'movies' ? 'movie' : 'show', S.route === 'movies' ? 'Movies' : 'TV Shows'); },
  dismiss: async (el) => {
    try {
      await api(`/api/progress/${el.dataset.id}`, { method: 'DELETE' });
      const sc = el.closest('.scroller');
      el.closest('.tilewrap').remove();
      if (sc && !sc.children.length) { $(`.rowh[data-row="continue"]`)?.remove(); sc.remove(); }
      toast('Removed from Continue Watching');
    } catch (e) { fail(e); }
  },
  help: () => { $('.menu')?.remove(); helpModal(); },
  chpw: () => { $('.menu')?.remove(); changePwModal(); },
  resetpw: async (el) => {
    if (!confirm(i18n.t(`Reset the password for ${el.dataset.name}? They will be signed out everywhere.`))) return;
    try {
      const r = await api(`/api/users/${el.dataset.id}/password`, { method: 'POST', body: {} });
      openModal(`<h2>Temporary password</h2><p class="hint" style="margin-bottom:12px">Share this with ${esc(el.dataset.name)} privately. It is shown only once — they should change it from their profile menu after signing in.</p>
        <div class="field"><span>${esc(r.email)}</span><input id="tmp" readonly value="${esc(r.temporaryPassword)}"></div>
        <div class="row"><button class="btn btn-ghost" data-act="copytmp">Copy</button><button class="btn btn-primary" data-act="closemodal">Done</button></div>`);
      $('#tmp').select();
    } catch (e) { fail(e); }
  },
  copytmp: async () => toast((await copyText($('#tmp').value)) ? 'Copied' : 'Could not copy automatically'),
  closeplayer: closePlayer,
  plower: () => startPlayback(P.itemId, P.info.epKey, { mode: 'hls', kbps: 2000, startMs: (P.video?.currentTime || 0) * 1000 }),
  pretry: () => startPlayback(P.itemId, P.info.epKey, { ...P.opts, startMs: (P.video?.currentTime || 0) * 1000 }),
  copysupport: async () => toast((await copyText(supportInfo())) ? 'Support info copied — paste it to whoever is helping you' : 'Could not copy automatically', false),
  ptoggle: togglePlay,
  pseek: (el) => seekBy(Number(el.dataset.d)),
  pmute: () => { P.video.muted = !P.video.muted; $('#mute').textContent = P.video.muted ? '🔇' : '🔊'; },
  pfull: toggleFull,
  pnext: () => { const n = findNext(P.itemId, P.info.epKey); if (n) { saveProgress(true); startPlayback(P.itemId, n.key); } },
  addplex: plexModal,
  plexsignin: plexSignIn,
  plexpick: (el) => plexPick(el.dataset.h, el.dataset.i, el),
  addarchive: archiveModal,
  addlink: linkModal,
  addclassics: async () => { try { await api('/api/sources/archive', { method: 'POST', body: { limit: 40 } }); toast('Importing classics — this takes a minute'); go('sources'); } catch (e) { fail(e); } },
  syncsrc: async (el) => { try { await api(`/api/sources/${el.dataset.id}/sync`, { method: 'POST', body: {} }); viewSources(); } catch (e) { fail(e); } },
  rmsrc: async (el) => { if (!confirm(`Remove “${el.dataset.name}” and its titles from NEXUS? Your files are not touched.`)) return; try { await api(`/api/sources/${el.dataset.id}`, { method: 'DELETE' }); viewSources(); } catch (e) { fail(e); } },
};

document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu,[data-act=menu]')) $('.menu')?.remove();
  const el = e.target.closest('[data-act]');
  if (el && A[el.dataset.act]) A[el.dataset.act](el, e);
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.change === 'season') drawDetail(S.detail, t.value);
  else if (t.dataset.change === 'signup') { try { await api('/api/settings', { method: 'PATCH', body: { openSignup: t.checked } }); toast(t.checked ? 'Sign-ups are open' : 'Sign-ups are closed'); } catch (err) { fail(err); t.checked = !t.checked; } }
  else if (t.id === 'sort') { S.browse.sort = t.value; S.browse.offset = 0; viewBrowse(t.dataset.kind, t.dataset.title); }
});

document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const kind = f.dataset.form;
  const val = (n) => f.elements[n]?.value?.trim();
  const err = (m) => { const el = $('#perr') || $('#pinerr'); if (el) el.textContent = m; };
  const btn = $('button[type=submit]', f);
  try {
    if (kind === 'login' || kind === 'register') return submitAuth(f, kind);
    if (kind === 'pin') return pickProfile(f.dataset.id, val('pin'));
    if (kind === 'profile') return saveProfile(f);
    if (kind === 'chpw') {
      if (f.elements.next.value !== f.elements.confirm.value) return err('The new passwords do not match');
      btn.disabled = true;
      await api('/api/account/password', { method: 'POST', body: { currentPassword: f.elements.current.value, newPassword: f.elements.next.value } });
      closeModal(); toast('Password updated'); return;
    }
    btn.disabled = true;
    if (kind === 'plexmanual') { await api('/api/sources/plex/manual', { method: 'POST', body: { url: val('url'), token: val('token'), name: val('name') } }); toast('Server connected — syncing…'); }
    if (kind === 'archive') { await api('/api/sources/archive', { method: 'POST', body: { query: val('query'), limit: Number(val('limit')) } }); toast('Importing — this takes a minute'); }
    if (kind === 'link') { await api('/api/sources/direct/items', { method: 'POST', body: { title: val('title'), url: val('url'), poster: val('poster'), year: val('year'), summary: val('summary') } }); toast('Title added'); }
    closeModal(); go('sources'); if (S.route === 'sources') viewSources();
  } catch (x) { err(x.message); if (btn) btn.disabled = false; }
});

let searchT;
document.addEventListener('input', (e) => {
  if (e.target.id !== 'q') return;
  clearTimeout(searchT);
  const q = e.target.value.trim();
  searchT = setTimeout(() => { if (q) { history.replaceState(null, '', `#/search?q=${encodeURIComponent(q)}`); S.route = 'search'; viewSearch(q); } else go('home'); }, 280);
});

addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalRoot.innerHTML && !$('#player')) closeModal();
});
addEventListener('beforeunload', () => saveProgress());
boot();
