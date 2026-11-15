/* NEXUS on Firebase: answers the front end's /api/* calls in the browser using Firebase Auth + Firestore.
   Accounts live in Firebase Auth. Per-account data lives in Firestore under users/{uid} (profiles, progress, My List) and is
   locked to its owner by firestore.rules. The title catalog is a static /catalog.json. Plex/streaming servers are not reachable
   from a static site, so this build plays direct links (mp4 / m3u8) and the built-in sample clip. */
import * as sdk from './sdk.js';

const AVATAR_COUNT = 10;
const MAX_PROFILES = 6;
const KIDS_OK = ['G', 'PG', 'TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G', 'TV-PG', 'U'];
const sess = (k, v) => { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { /* private mode */ } return null; };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

let auth, db, catalog = [], AVATARS = [];
const ready = (async () => {
  const [cfg, cat] = await Promise.all([
    fetch('/__/firebase/init.json').then((r) => { if (!r.ok) throw new Error('config'); return r.json(); }),
    fetch('/catalog.json').then((r) => r.json()),
  ]);
  catalog = cat.items; AVATARS = cat.avatars;
  const app = sdk.initializeApp(cfg);
  auth = sdk.getAuth(app); db = sdk.getFirestore(app);
  await auth.authStateReady();
})().catch((e) => {
  // Until a Firebase web app exists for this project there is no config; keep the site useful by showing the sample-title demo.
  if (e.message === 'config' && typeof location !== 'undefined' && location.replace && !/demo\.html$/.test(location.pathname)) { console.warn('NEXUS: Firebase is not set up yet; showing the demo.'); location.replace('/demo.html'); }
  throw new HttpError(503, e.message === 'config' ? 'NEXUS is not connected to Firebase yet (no web app is registered for this project).' : `Could not start NEXUS (${e.message})`); });

/* ---------- Small helpers ---------- */
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function hashPin(pin, saltHex) {
  const salt = saltHex ? Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16))) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256);
  return { hash: hex(bits), salt: hex(salt) };
}
const pinTries = new Map();
function pinBudget(pid) {
  const now = Date.now(); const t = (pinTries.get(pid) || []).filter((x) => now - x < 300_000);
  if (t.length >= 5) throw new HttpError(429, 'Too many wrong PINs. Try again in a few minutes.');
  return t;
}

const AUTH_ERRORS = {
  'auth/invalid-credential': [401, 'Wrong email or password'], 'auth/wrong-password': [401, 'Wrong email or password'], 'auth/user-not-found': [401, 'Wrong email or password'],
  'auth/invalid-email': [400, 'That email address does not look right'], 'auth/email-already-in-use': [409, 'An account with this email already exists'],
  'auth/weak-password': [400, 'Choose a password of at least 8 characters'], 'auth/too-many-requests': [429, 'Too many attempts. Try again in a few minutes.'],
  'auth/network-request-failed': [503, 'No connection. Check your internet and try again.'], 'auth/operation-not-allowed': [503, 'Email sign-in is not switched on for this project yet.'],
  'auth/configuration-not-found': [503, 'Sign-in is not switched on for this project yet. The owner needs to enable Email/Password in Firebase Authentication.'],
  'auth/requires-recent-login': [401, 'Please sign in again, then retry'],
};
const mapErr = (e) => {
  if (e instanceof HttpError) return e;
  const m = AUTH_ERRORS[e?.code];
  if (m) return new HttpError(m[0], m[1]);
  if (e?.code === 'permission-denied') return new HttpError(403, 'Not allowed');
  if (e?.code === 'unavailable') return new HttpError(503, 'No connection. Check your internet and try again.');
  return new HttpError(500, e?.message || 'Something went wrong');
};

const isOwner = async (u) => { try { return (await sdk.getDoc(sdk.doc(db, 'admins', u.uid))).exists(); } catch { return false; } };
const needAdmin = async () => { const u = need(); if (!(await isOwner(u))) throw new HttpError(403, 'Owner access required'); return u; };
const need = () => { if (!auth.currentUser) throw new HttpError(401, 'Please sign in'); return auth.currentUser; };
const uref = (u) => sdk.doc(db, 'users', u.uid);
const pcol = (u) => sdk.collection(db, 'users', u.uid, 'profiles');
const pdoc = (u, id) => sdk.doc(db, 'users', u.uid, 'profiles', String(id));

const pub = (id, p) => ({ id: Number(id), name: p.name, avatar: p.avatar, emoji: AVATARS[p.avatar]?.emoji || '🙂', bg: AVATARS[p.avatar]?.bg || '#222', kids: !!p.kids, locked: !!p.pinHash });
async function listProfiles(u) { const snap = await sdk.getDocs(pcol(u)); return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); }
async function getProfile(u, id) { const s = await sdk.getDoc(pdoc(u, id)); if (!s.exists()) throw new HttpError(404, 'Profile not found'); return { id: s.id, ...s.data() }; }

async function confirmPassword(u, password) {
  if (!password) throw new HttpError(403, 'Enter your account password to change a PIN or Kids setting');
  try { await sdk.reauthenticateWithCredential(u, sdk.EmailAuthProvider.credential(u.email, String(password))); } catch (e) {
    if (e?.code === 'auth/too-many-requests') throw mapErr(e);
    throw new HttpError(403, 'Enter your account password to change a PIN or Kids setting');
  }
}

/* ---------- Per-profile data (loaded once per selected profile, written through) ---------- */
const P = { key: '', progress: new Map(), list: [] };
async function load(u) {
  const pid = sess(`nexus_p_${u.uid}`);
  if (!pid) throw new HttpError(409, 'Choose a profile first');
  const prof = await getProfile(u, pid).catch(() => { sess(`nexus_p_${u.uid}`, null); throw new HttpError(409, 'Choose a profile first'); });
  if (P.key !== `${u.uid}:${pid}`) {
    const [pr, li] = await Promise.all([
      sdk.getDocs(sdk.collection(db, 'users', u.uid, 'profiles', String(pid), 'progress')),
      sdk.getDocs(sdk.collection(db, 'users', u.uid, 'profiles', String(pid), 'list')),
    ]);
    P.progress = new Map(pr.docs.map((d) => [Number(d.id), d.data()]));
    P.list = li.docs.map((d) => ({ id: Number(d.id), at: d.data().at || 0 })).sort((a, b) => b.at - a.at).map((x) => x.id);
    P.key = `${u.uid}:${pid}`;
  }
  return { u, pid: String(pid), prof };
}

const visible = (prof) => catalog.filter((i) => !prof.kids || KIDS_OK.includes(i.contentRating));
const pct = (p) => (p && p.durationMs ? p.positionMs / p.durationMs : 0);
const ser = (it) => {
  const p = P.progress.get(it.id); const f = pct(p);
  return { id: it.id, kind: it.kind, title: it.title, year: it.year, summary: it.summary, genres: it.genres, rating: it.rating, contentRating: it.contentRating, durationMin: it.durationMin,
    poster: it.poster, backdrop: it.backdrop, source: it.source || 'catalog', addedAt: it.addedAt, inList: P.list.includes(it.id),
    progress: p && f >= 0.02 && f < 0.95 ? { pct: f, label: p.epLabel, epKey: p.epKey, positionMs: p.positionMs } : null };
};
const genreCounts = (arr) => { const m = {}; arr.forEach((i) => i.genres.forEach((g) => { m[g] = (m[g] || 0) + 1; })); return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([genre, n]) => ({ genre, n })); };

function home(prof) {
  const vis = visible(prof); const rows = [];
  const push = (id, title, list, extra = {}) => { if (list.length) rows.push({ id, title, items: list.map(ser), ...extra }); };
  const cont = vis.filter((i) => { const f = pct(P.progress.get(i.id)); return f >= 0.02 && f < 0.95; }).sort((a, b) => P.progress.get(b.id).updatedAt - P.progress.get(a.id).updatedAt);
  push('continue', 'Continue Watching', cont, { wide: true });
  push('mylist', 'My List', P.list.map((id) => vis.find((i) => i.id === id)).filter(Boolean));
  push('recent', 'Recently Added', [...vis].sort((a, b) => b.addedAt - a.addedAt).slice(0, 20));
  push('top', 'Top Rated', [...vis].sort((a, b) => b.rating - a.rating).slice(0, 20));
  push('movies', 'Movies', vis.filter((i) => i.kind === 'movie'));
  push('shows', 'TV Shows', vis.filter((i) => i.kind === 'show'));
  genreCounts(vis).filter((g) => g.n >= 3).slice(0, 4).forEach((g) => push(`genre:${g.genre}`, g.genre, vis.filter((i) => i.genres.includes(g.genre))));
  const hero = [...vis].sort((a, b) => b.rating - a.rating).slice(0, 5);
  return { hero: hero.length ? ser(hero[Math.floor(Date.now() / 86_400_000) % hero.length]) : null, rows, empty: !vis.length,
    stats: { movies: vis.filter((i) => i.kind === 'movie').length, shows: vis.filter((i) => i.kind === 'show').length, hours: 0, sources: 1 } };
}

const validAvatar = (a) => (Number.isInteger(a) && a >= 0 && a < AVATAR_COUNT ? a : 0);
const BAD_INVITE = 'That invite code is not valid for this email, or it has already been used.';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => 'NX-' + [...crypto.getRandomValues(new Uint8Array(12))].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');

const cleanName = (n) => String(n ?? '').trim().slice(0, 24);

/* ---------- Routes ---------- */
async function route(method, path, q, body) {
  await ready;
  let m;
  if (path === '/api/session') {
    const u = auth.currentUser; let profile = null;
    if (u) { const pid = sess(`nexus_p_${u.uid}`); if (pid) profile = await getProfile(u, pid).then((p) => pub(pid, p)).catch(() => null); }
    return { user: u ? { id: u.uid, name: u.displayName || (u.email || '').split('@')[0], email: u.email, isAdmin: await isOwner(u) } : null, profile,
      setupNeeded: false, signupOpen: true, inviteRequired: true, canReset: true, hosted: true, avatars: AVATARS, maxProfiles: MAX_PROFILES };
  }
  if (path === '/api/auth/register') {
    const name = String(body.name || '').trim().slice(0, 60); const email = String(body.email || '').trim();
    if (String(body.password || '').length < 8) throw new HttpError(400, 'Choose a password of at least 8 characters');
    const code = String(body.invite || '').trim().toUpperCase();
    if (!code) throw new HttpError(400, 'Enter your invite code');
    if (!/^[A-Z0-9-]{4,40}$/.test(code)) throw new HttpError(403, BAD_INVITE);
    const cred = await sdk.createUserWithEmailAndPassword(auth, email, String(body.password));
    try {
      // One atomic write: create my account record AND use up one use of the invite. The rules reject it unless the code exists,
      // has uses left and (if it was made for one email) matches the email I just signed up with.
      const batch = sdk.writeBatch(db);
      batch.set(uref(cred.user), { name: name || email.split('@')[0], email, createdAt: Date.now(), invite: code });
      batch.update(sdk.doc(db, 'invites', code), { uses: sdk.increment(1) });
      await batch.commit();
    } catch (e) {
      await cred.user.delete().catch(() => {});   // undo the sign-up so a bad code leaves nothing behind
      if (e?.code === 'permission-denied' || e?.code === 'not-found') throw new HttpError(403, BAD_INVITE);
      throw e;
    }
    await sdk.updateProfile(cred.user, { displayName: name || email.split('@')[0] });
    await sdk.setDoc(pdoc(cred.user, Date.now()), { name: (name || 'Me').split(' ')[0].slice(0, 24), avatar: 0, kids: false, createdAt: Date.now() });
    return { ok: true };
  }
  if (path === '/api/auth/login') { await sdk.signInWithEmailAndPassword(auth, String(body.email || '').trim(), String(body.password || '')); return { ok: true }; }
  if (path === '/api/auth/forgot') {
    // Same answer whether or not the email has an account, so the form cannot be used to discover accounts.
    try { await sdk.sendPasswordResetEmail(auth, String(body.email || '').trim()); } catch (e) { if (['auth/too-many-requests', 'auth/network-request-failed', 'auth/invalid-email'].includes(e?.code)) throw mapErr(e); }
    return { ok: true };
  }
  if (path === '/api/auth/logout') { const u = auth.currentUser; if (u) sess(`nexus_p_${u.uid}`, null); P.key = ''; await sdk.signOut(auth); return { ok: true }; }
  if (path === '/api/account/password') {
    const u = need();
    if (String(body.newPassword || '').length < 8) throw new HttpError(400, 'Choose a password of at least 8 characters');
    try { await sdk.reauthenticateWithCredential(u, sdk.EmailAuthProvider.credential(u.email, String(body.currentPassword || ''))); } catch (e) { throw e?.code === 'auth/too-many-requests' ? mapErr(e) : new HttpError(403, 'Your current password is not right'); }
    await sdk.updatePassword(u, String(body.newPassword)); return { ok: true };
  }

  if (path === '/api/profiles' && method === 'GET') { const u = need(); return { profiles: (await listProfiles(u)).map((p) => pub(p.id, p)) }; }
  if (path === '/api/profiles' && method === 'POST') {
    const u = need(); const all = await listProfiles(u);
    if (all.length >= MAX_PROFILES) throw new HttpError(400, `You can have up to ${MAX_PROFILES} profiles`);
    const name = cleanName(body.name); if (!name) throw new HttpError(400, 'Give the profile a name');
    const p = { name, avatar: validAvatar(body.avatar), kids: !!body.kids, createdAt: Date.now() };
    if (body.pin !== undefined && body.pin !== null) {
      if (!/^\d{4}$/.test(String(body.pin))) throw new HttpError(400, 'The PIN must be 4 digits');
      const h = await hashPin(String(body.pin)); p.pinHash = h.hash; p.pinSalt = h.salt;
    }
    const id = String(Math.max(Date.now(), ...all.map((x) => Number(x.id) + 1)));
    await sdk.setDoc(pdoc(u, id), p); return { profile: pub(id, p) };
  }
  if ((m = /^\/api\/profiles\/(\d+)\/select$/.exec(path))) {
    const u = need(); const p = await getProfile(u, m[1]);
    if (p.pinHash) {
      const t = pinBudget(m[1]);
      const h = await hashPin(String(body.pin || ''), p.pinSalt);
      if (h.hash !== p.pinHash) { t.push(Date.now()); pinTries.set(m[1], t); throw new HttpError(401, 'Wrong PIN'); }
      pinTries.delete(m[1]);
    }
    sess(`nexus_p_${u.uid}`, m[1]); return { profile: pub(m[1], p) };
  }
  if ((m = /^\/api\/profiles\/(\d+)$/.exec(path))) {
    const u = need(); const p = await getProfile(u, m[1]);
    if (method === 'DELETE') {
      const all = await listProfiles(u); if (all.length <= 1) throw new HttpError(400, 'You need at least one profile');
      const base = ['users', u.uid, 'profiles', m[1]];
      const [pr, li] = await Promise.all([sdk.getDocs(sdk.collection(db, ...base, 'progress')), sdk.getDocs(sdk.collection(db, ...base, 'list'))]);
      const batch = sdk.writeBatch(db); pr.docs.forEach((d) => batch.delete(d.ref)); li.docs.forEach((d) => batch.delete(d.ref)); batch.delete(pdoc(u, m[1]));
      await batch.commit();
      if (sess(`nexus_p_${u.uid}`) === m[1]) sess(`nexus_p_${u.uid}`, null);
      P.key = ''; return { ok: true };
    }
    const sensitive = (body.pin !== undefined && body.pin !== null) || (body.pin === null && p.pinHash) || (body.kids !== undefined && !!body.kids !== !!p.kids);
    if (sensitive) await confirmPassword(u, body.password);
    const patch = {};
    if (body.name !== undefined) { const n = cleanName(body.name); if (!n) throw new HttpError(400, 'Give the profile a name'); patch.name = n; }
    if (body.avatar !== undefined) patch.avatar = validAvatar(Number(body.avatar));
    if (body.kids !== undefined) patch.kids = !!body.kids;
    if (body.pin === null) { patch.pinHash = null; patch.pinSalt = null; }
    else if (body.pin !== undefined) {
      if (!/^\d{4}$/.test(String(body.pin))) throw new HttpError(400, 'The PIN must be 4 digits');
      const h = await hashPin(String(body.pin)); patch.pinHash = h.hash; patch.pinSalt = h.salt;
    }
    await sdk.updateDoc(pdoc(u, m[1]), patch);
    return { profile: pub(m[1], { ...p, ...patch }) };
  }
  if (path === '/api/profile/leave') { const u = need(); sess(`nexus_p_${u.uid}`, null); P.key = ''; return { ok: true }; }

  if (path === '/api/home') { const c = await load(need()); return home(c.prof); }
  if (path === '/api/browse') {
    const c = await load(need()); let arr = visible(c.prof);
    if (q.get('kind')) arr = arr.filter((i) => i.kind === q.get('kind'));
    if (q.get('genre')) arr = arr.filter((i) => i.genres.includes(q.get('genre')));
    if (q.get('q')) arr = arr.filter((i) => `${i.title} ${i.summary}`.toLowerCase().includes(q.get('q').toLowerCase()));
    const sort = q.get('sort') || 'recent';
    arr = [...arr].sort({ title: (a, b) => a.title.localeCompare(b.title), rating: (a, b) => b.rating - a.rating, year: (a, b) => b.year - a.year }[sort] || ((a, b) => b.addedAt - a.addedAt));
    const off = +q.get('offset') || 0; const lim = Math.min(+q.get('limit') || 48, 200);
    return { items: arr.slice(off, off + lim).map(ser), hasMore: arr.length > off + lim, genres: genreCounts(visible(c.prof).filter((i) => !q.get('kind') || i.kind === q.get('kind'))) };
  }
  if (path === '/api/mylist') { const c = await load(need()); const vis = visible(c.prof); return { items: P.list.map((id) => vis.find((i) => i.id === id)).filter(Boolean).map(ser) }; }
  if ((m = /^\/api\/mylist\/(\d+)$/.exec(path))) {
    const c = await load(need()); const id = Number(m[1]); const ref = sdk.doc(db, 'users', c.u.uid, 'profiles', c.pid, 'list', String(id));
    if (method === 'POST') { if (!visible(c.prof).some((i) => i.id === id)) throw new HttpError(404, 'Title not found'); if (!P.list.includes(id)) { await sdk.setDoc(ref, { at: Date.now() }); P.list.unshift(id); } return { inList: true }; }
    await sdk.deleteDoc(ref); P.list = P.list.filter((x) => x !== id); return { inList: false };
  }
  if ((m = /^\/api\/items\/(\d+)\/play$/.exec(path))) {
    const c = await load(need()); const it = visible(c.prof).find((i) => i.id === +m[1]); if (!it) throw new HttpError(404, 'Title not found');
    if (it.private) throw new HttpError(403, 'This title plays on the private NEXUS server, not on the public site.');
    const ep = q.get('ep') || ''; let label = null; let title = it.title; let url = it.streamUrl || '/clip.mp4'; let durationMs = (it.durationMin ? it.durationMin * 60000 : 8000);
    if (it.kind === 'show') {
      const e = it.seasons.flatMap((s) => s.episodes).find((x) => x.key === ep); if (!e) throw new HttpError(400, 'Choose an episode');
      label = `S${e.seasonIndex} · E${e.index}`; title = `${it.title} — ${e.title}`; url = e.streamUrl || it.streamUrl || '/clip.mp4';
    }
    if (url === '/clip.mp4') durationMs = 8000;
    const p = P.progress.get(it.id); const resume = p && (p.epKey || '') === ep && pct(p) < 0.95 ? Math.min(p.positionMs, durationMs - 2000) : 0;
    return { type: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'mp4', url, mode: 'direct', durationMs, title, epLabel: label, epKey: ep, startMs: Math.max(0, resume) };
  }
  if ((m = /^\/api\/items\/(\d+)$/.exec(path))) {
    const c = await load(need()); const it = visible(c.prof).find((i) => i.id === +m[1]); if (!it) throw new HttpError(404, 'Title not found');
    const out = { item: ser(it), related: visible(c.prof).filter((x) => x.id !== it.id && x.genres.some((g) => it.genres.includes(g))).slice(0, 12).map(ser) };
    if (it.kind === 'show') { out.seasons = it.seasons; out.watched = {}; const p = P.progress.get(it.id); if (p?.epKey) out.watched[p.epKey] = pct(p); }
    return out;
  }
  if (path === '/api/progress' && method === 'POST') {
    const c = await load(need()); const itemId = Number(body.itemId);
    if (!visible(c.prof).some((i) => i.id === itemId) || !(body.durationMs > 0) || !(body.positionMs >= 0)) throw new HttpError(400, 'Bad progress');
    const rec = { epKey: String(body.epKey || ''), epLabel: body.epLabel || null, positionMs: Math.round(body.positionMs), durationMs: Math.round(body.durationMs), updatedAt: Date.now() };
    P.progress.set(itemId, rec);
    await sdk.setDoc(sdk.doc(db, 'users', c.u.uid, 'profiles', c.pid, 'progress', String(itemId)), rec); return { ok: true };
  }
  if ((m = /^\/api\/progress\/(\d+)$/.exec(path)) && method === 'DELETE') {
    const c = await load(need()); P.progress.delete(Number(m[1]));
    await sdk.deleteDoc(sdk.doc(db, 'users', c.u.uid, 'profiles', c.pid, 'progress', m[1])); return { ok: true };
  }
  if (path === '/api/invites' && method === 'GET') {
    await needAdmin(); const snap = await sdk.getDocs(sdk.collection(db, 'invites'));
    return { invites: snap.docs.map((d) => ({ code: d.id, ...d.data() })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) };
  }
  if (path === '/api/invites' && method === 'POST') {
    await needAdmin();
    const email = String(body.email || '').trim().toLowerCase();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'That email address does not look right');
    const maxUses = email ? 1 : Math.min(500, Math.max(1, Math.floor(Number(body.maxUses) || 1)));
    const code = newCode(); const inv = { email, maxUses, uses: 0, createdAt: Date.now() };
    await sdk.setDoc(sdk.doc(db, 'invites', code), inv); return { code, ...inv };
  }
  if ((m = /^\/api\/invites\/([A-Z0-9-]+)$/.exec(path)) && method === 'DELETE') { await needAdmin(); await sdk.deleteDoc(sdk.doc(db, 'invites', m[1])); return { ok: true }; }
  if (path === '/api/sources') { await needAdmin(); return { sources: [] }; }
  if (path === '/api/settings') { await needAdmin(); return { openSignup: true }; }
  if (path === '/api/users') {
    const me = await needAdmin(); const snap = await sdk.getDocs(sdk.collection(db, 'users'));
    return { users: snap.docs.map((d) => ({ id: d.id, name: d.data().name, email: d.data().email, isAdmin: d.id === me.uid })).sort((a, b) => String(a.name).localeCompare(String(b.name))) };
  }
  if ((m = /^\/api\/users\/([^/]+)\/password$/.exec(path))) {
    await needAdmin(); const snap = await sdk.getDoc(sdk.doc(db, 'users', m[1])); if (!snap.exists()) throw new HttpError(404, 'Account not found');
    await sdk.sendPasswordResetEmail(auth, snap.data().email); return { email: snap.data().email, emailed: true };
  }
  throw new HttpError(404, 'This build of NEXUS has no media-server admin. Titles come from the built-in catalog.');
}

/* ---------- fetch shim: the UI keeps calling fetch('/api/...') exactly as it does against the Node server ---------- */
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
  if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
  let body = {};
  try { body = init.body ? JSON.parse(init.body) : {}; } catch { /* none */ }
  try {
    const data = await route((init.method || 'GET').toUpperCase(), url.pathname, url.searchParams, body);
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    const err = mapErr(e);
    return new Response(JSON.stringify({ error: err.message }), { status: err.status, headers: { 'Content-Type': 'application/json' } });
  }
};
