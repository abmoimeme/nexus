import http from 'node:http';
import crypto from 'node:crypto';
import { hashSecret, verifySecret } from './crypto.js';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { all, get, run, getSetting, setSetting } from './db.js';
import {
  HttpError, Router, sendJson, readJson, setCookie, clientIp, checkOrigin,
  rateLimit, secureHeaders, serveStatic,
} from './http.js';
import * as auth from './auth.js';
import * as lib from './library.js';
import * as plex from './sources/plex.js';
import {
  listSources, loadSource, createSource, deleteSource, publicSource, ensureDirectSource,
} from './sources/index.js';
import { syncInBackground, startScheduler, isSyncing } from './sync.js';
import { proxyStream, proxyImage } from './proxy.js';

const router = new Router();
const DAY = 86_400;

/* ---------- Request guards ---------- */

const needUser = (c) => {
  if (!c.session) throw new HttpError(401, 'Please sign in');
  return c.session;
};

function needProfile(c) {
  const s = needUser(c);
  const p = s.profileId ? auth.getProfile(s.profileId, s.user.id) : null;
  if (!p) throw new HttpError(409, 'Choose a profile first');
  return p;
}

function needAdmin(c) {
  const s = needUser(c);
  if (!s.user.is_admin) throw new HttpError(403, 'Only the owner can do that');
  const p = s.profileId ? auth.getProfile(s.profileId, s.user.id) : null;
  if (p?.kids) throw new HttpError(403, 'Switch to a non-Kids profile to manage sources');
  return s;
}

const intParam = (v, name = 'id') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Bad ${name}`);
  return n;
};

function startSession(c, userId) {
  const token = auth.createSession(userId);
  setCookie(c.res, c.req, auth.COOKIE, token, config.sessionDays * DAY);
}

/* ---------- Session & accounts ---------- */

router.get('/api/health', (c) => sendJson(c.res, 200, { ok: true }));

router.get('/api/session', (c) => {
  const s = c.session;
  const profile = s?.profileId ? auth.getProfile(s.profileId, s.user.id) : null;
  sendJson(c.res, 200, {
    user: s ? auth.publicUser(s.user) : null,
    profile: profile ? auth.publicProfile(profile) : null,
    setupNeeded: auth.userCount() === 0,
    signupOpen: auth.signupOpen(),
    avatars: auth.AVATARS,
    maxProfiles: auth.MAX_PROFILES,
  });
});

router.post('/api/auth/register', async (c) => {
  if (!rateLimit(`reg:${clientIp(c.req)}`, 10, 60 * 60_000)) throw new HttpError(429, 'Too many sign-ups from this address');
  const body = await readJson(c.req);
  const id = await auth.register(body);
  startSession(c, id);
  sendJson(c.res, 201, { ok: true });
});

router.post('/api/auth/login', async (c) => {
  const body = await readJson(c.req);
  const user = await auth.login(body, clientIp(c.req));
  startSession(c, user.id);
  sendJson(c.res, 200, { ok: true });
});

router.post('/api/auth/logout', (c) => {
  auth.destroySession(c.req);
  setCookie(c.res, c.req, auth.COOKIE, '', 0);
  sendJson(c.res, 200, { ok: true });
});

/* ---------- Profiles ---------- */

router.get('/api/profiles', (c) => {
  const s = needUser(c);
  sendJson(c.res, 200, { profiles: auth.listProfiles(s.user.id).map(auth.publicProfile) });
});

router.post('/api/profiles', async (c) => {
  const s = needUser(c);
  const p = await auth.createProfile(s.user.id, await readJson(c.req));
  sendJson(c.res, 201, { profile: auth.publicProfile(p) });
});

/** Verify the signed-in user's account password (used before sensitive changes). */
async function confirmPassword(s, password) {
  if (!rateLimit(`pwchk:${s.user.id}`, 10, 15 * 60_000)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  const row = get('SELECT pass_hash FROM users WHERE id = ?', s.user.id);
  if (!password || !row || !(await verifySecret(String(password), row.pass_hash))) {
    throw new HttpError(403, 'Enter your account password to change a PIN or Kids setting');
  }
}

router.patch('/api/profiles/:id', async (c) => {
  const s = needUser(c);
  const id = intParam(c.params.id);
  const body = await readJson(c.req);
  const existing = auth.getProfile(id, s.user.id);
  if (!existing) throw new HttpError(404, 'Profile not found');
  // A PIN or Kids switch is a parental control: changing it needs the account password,
  // otherwise anyone on a shared screen could unlock an adult profile from "Manage profiles".
  const sensitive = body.pin !== undefined || (body.kids !== undefined && !!body.kids !== !!existing.kids);
  if (sensitive) await confirmPassword(s, body.password);
  const p = await auth.updateProfile(s.user.id, id, body);
  sendJson(c.res, 200, { profile: auth.publicProfile(p) });
});

router.delete('/api/profiles/:id', (c) => {
  const s = needUser(c);
  const id = intParam(c.params.id);
  auth.deleteProfile(s.user.id, id);
  sendJson(c.res, 200, { ok: true });
});

router.post('/api/profiles/:id/select', async (c) => {
  const s = needUser(c);
  const body = await readJson(c.req);
  const p = await auth.selectProfile(s, intParam(c.params.id), body.pin);
  sendJson(c.res, 200, { profile: auth.publicProfile(p) });
});

router.post('/api/profile/leave', (c) => {
  auth.leaveProfile(needUser(c));
  sendJson(c.res, 200, { ok: true });
});

/* ---------- Library ---------- */

router.get('/api/home', (c) => sendJson(c.res, 200, lib.buildHome(needProfile(c))));

router.get('/api/browse', (c) => {
  const profile = needProfile(c);
  const q = c.url.searchParams;
  const kind = ['movie', 'show'].includes(q.get('kind')) ? q.get('kind') : undefined;
  const limit = Math.min(Math.max(parseInt(q.get('limit'), 10) || 48, 1), 100);
  const offset = Math.max(parseInt(q.get('offset'), 10) || 0, 0);
  const opts = {
    kind,
    genre: q.get('genre')?.slice(0, 40) || undefined,
    q: q.get('q')?.trim().slice(0, 80) || undefined,
    sort: q.get('sort') || 'recent',
    limit: limit + 1,
    offset,
  };
  const ctx = lib.context(profile);
  const rows = lib.queryItems(profile, opts);
  sendJson(c.res, 200, {
    items: rows.slice(0, limit).map((r) => lib.serialize(r, ctx)),
    hasMore: rows.length > limit,
    genres: lib.genreCounts(profile, kind),
  });
});

router.get('/api/mylist', (c) => sendJson(c.res, 200, { items: lib.listMyList(needProfile(c)) }));

router.post('/api/mylist/:id', (c) => {
  const profile = needProfile(c);
  const id = intParam(c.params.id);
  if (!lib.getItemRow(profile, id)) throw new HttpError(404, 'Title not found');
  lib.setMyList(profile.id, id, true);
  sendJson(c.res, 200, { inList: true });
});

router.delete('/api/mylist/:id', (c) => {
  const profile = needProfile(c);
  lib.setMyList(profile.id, intParam(c.params.id), false);
  sendJson(c.res, 200, { inList: false });
});

const episodeCache = new Map(); // `${sourceId}:${showKey}` -> { at, seasons }

async function episodesFor(source, showKey) {
  const key = `${source.id}:${showKey}`;
  const hit = episodeCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.seasons;
  const seasons = await plex.getEpisodes(source, showKey);
  episodeCache.set(key, { at: Date.now(), seasons });
  if (episodeCache.size > 200) episodeCache.delete(episodeCache.keys().next().value);
  return seasons;
}

router.get('/api/items/:id', async (c) => {
  const profile = needProfile(c);
  const row = lib.getItemRow(profile, intParam(c.params.id));
  if (!row) throw new HttpError(404, 'Title not found');
  const ctx = lib.context(profile);
  const out = { item: lib.serialize(row, ctx) };

  if (row.kind === 'show' && row.source_type === 'plex') {
    const source = loadSource(row.source_id);
    try {
      out.seasons = await episodesFor(source, JSON.parse(row.play_ref).ratingKey);
      out.watched = lib.episodeProgress(profile.id, row.id);
    } catch (e) {
      out.seasons = [];
      out.episodesError = e.message;
    }
  }
  const g = out.item.genres[0];
  out.related = g
    ? lib.queryItems(profile, { genre: g, sort: 'rating', limit: 13 })
        .filter((r) => r.id !== row.id).slice(0, 12).map((r) => lib.serialize(r, ctx))
    : [];
  sendJson(c.res, 200, out);
});

/** Resolve how to play a title: a direct URL, or a proxied Plex stream. */
router.get('/api/items/:id/play', async (c) => {
  const profile = needProfile(c);
  const row = lib.getItemRow(profile, intParam(c.params.id));
  if (!row) throw new HttpError(404, 'Title not found');
  const ref = JSON.parse(row.play_ref || '{}');
  const epKey = c.url.searchParams.get('ep') || '';
  const forceHls = c.url.searchParams.get('mode') === 'hls';
  const kbps = Math.min(Math.max(parseInt(c.url.searchParams.get('kbps'), 10) || 0, 0), 40000) || undefined;

  let title = row.title;
  let epLabel = null;
  let result;

  if (row.source_type === 'plex') {
    const source = loadSource(row.source_id);
    let mediaKey = ref.ratingKey;
    if (row.kind === 'show') {
      if (!epKey) throw new HttpError(400, 'Choose an episode');
      plex.assertKey(epKey);
      const seasons = await episodesFor(source, ref.ratingKey);
      const ep = seasons.flatMap((s) => s.episodes).find((e) => e.key === epKey);
      if (!ep) throw new HttpError(404, 'Episode not found');
      mediaKey = ep.key;
      epLabel = `S${ep.seasonIndex} · E${ep.index}`;
      title = `${row.title} — ${ep.title}`;
    }
    const m = await plex.getMedia(source, mediaKey);
    const direct = !forceHls
      && ['mp4', 'm4v', 'mov'].includes(m.container)
      && m.videoCodec === 'h264'
      && ['aac', 'mp3', ''].includes(m.audioCodec);
    const proxied = (path) => `/api/sources/${source.id}/proxy?u=${encodeURIComponent(path)}`;
    if (direct) {
      result = { type: 'mp4', url: proxied(m.partKey), mode: 'direct' };
    } else {
      const session = crypto.randomUUID();
      result = {
        type: 'hls',
        url: proxied(plex.transcodePath(mediaKey, { kbps, session })),
        mode: 'transcode',
        session,
        sourceId: source.id,
      };
    }
    result.durationMs = m.durationMs;
    result.plex = true;
    result.relay = source.cfg.via === 'relay';
  } else {
    const url = ref.url;
    if (!url) throw new HttpError(404, 'This title has no playable link');
    result = { type: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'mp4', url, mode: 'direct', durationMs: row.duration_ms };
  }

  const prog = lib.getProgress(profile.id, row.id, epKey);
  const resume = prog && prog.duration_ms && prog.position_ms / prog.duration_ms < 0.95 ? prog.position_ms : 0;
  sendJson(c.res, 200, { ...result, title, epLabel, epKey, startMs: resume });
});

router.post('/api/progress', async (c) => {
  const profile = needProfile(c);
  const b = await readJson(c.req);
  const itemId = intParam(b.itemId, 'itemId');
  if (!lib.getItemRow(profile, itemId)) throw new HttpError(404, 'Title not found');
  const positionMs = Math.round(Number(b.positionMs));
  const durationMs = Math.round(Number(b.durationMs));
  if (![positionMs, durationMs].every((n) => Number.isFinite(n) && n >= 0) || !durationMs) {
    throw new HttpError(400, 'Bad progress values');
  }
  const epKey = b.epKey ? String(b.epKey) : '';
  if (epKey && !/^\d{1,18}$/.test(epKey)) throw new HttpError(400, 'Bad episode');
  lib.saveProgress(profile.id, {
    itemId,
    epKey,
    epLabel: b.epLabel ? String(b.epLabel).slice(0, 40) : null,
    positionMs: Math.min(positionMs, durationMs),
    durationMs,
  });
  sendJson(c.res, 200, { ok: true });
});

router.delete('/api/progress/:itemId', (c) => {
  const profile = needProfile(c);
  run('DELETE FROM progress WHERE profile_id = ? AND item_id = ?', profile.id, intParam(c.params.itemId, 'itemId'));
  sendJson(c.res, 200, { ok: true });
});

/* ---------- Account passwords ---------- */

const GEN_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const tempPassword = () => Array.from(crypto.randomBytes(12), (b) => GEN_ALPHABET[b % GEN_ALPHABET.length]).join('');

router.post('/api/account/password', async (c) => {
  const s = needUser(c);
  const b = await readJson(c.req);
  const next = String(b.newPassword ?? '');
  if (next.length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
  if (next.length > 200) throw new HttpError(400, 'New password is too long');
  const row = get('SELECT pass_hash FROM users WHERE id = ?', s.user.id);
  if (!rateLimit(`pwchg:${s.user.id}`, 10, 15 * 60_000)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  if (!(await verifySecret(String(b.currentPassword ?? ''), row.pass_hash))) throw new HttpError(403, 'Your current password is not correct');
  run('UPDATE users SET pass_hash = ? WHERE id = ?', await hashSecret(next), s.user.id);
  // Sign out every other device; this one stays signed in.
  run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', s.user.id, s.tokenHash);
  sendJson(c.res, 200, { ok: true });
});

router.get('/api/users', (c) => {
  needAdmin(c);
  sendJson(c.res, 200, {
    users: all('SELECT id, email, name, is_admin, created_at FROM users ORDER BY id')
      .map((u) => ({ id: u.id, email: u.email, name: u.name, isAdmin: !!u.is_admin, createdAt: u.created_at })),
  });
});

/** Owner resets a member's password: a one-time temporary password is shown once and the member is signed out everywhere. */
router.post('/api/users/:id/password', async (c) => {
  const s = needAdmin(c);
  const id = intParam(c.params.id);
  const user = get('SELECT id, email FROM users WHERE id = ?', id);
  if (!user) throw new HttpError(404, 'User not found');
  if (id === s.user.id) throw new HttpError(400, 'Use “Change password” in your profile menu for your own account');
  const temp = tempPassword();
  run('UPDATE users SET pass_hash = ? WHERE id = ?', await hashSecret(temp), id);
  run('DELETE FROM sessions WHERE user_id = ?', id);
  sendJson(c.res, 200, { email: user.email, temporaryPassword: temp });
});

/* ---------- Media proxy (Plex) ---------- */

function plexSource(c) {
  needProfile(c);
  const source = loadSource(intParam(c.params.id));
  if (!source || source.type !== 'plex') throw new HttpError(404, 'Source not found');
  return source;
}

router.get('/api/sources/:id/image', async (c) => {
  const source = plexSource(c);
  const q = c.url.searchParams;
  await proxyImage(c.req, c.res, source, q.get('p'), q.get('w'), q.get('h'));
});

router.get('/api/sources/:id/proxy', async (c) => {
  const source = plexSource(c);
  await proxyStream(c.req, c.res, source, c.url.searchParams.get('u'));
});

router.post('/api/sources/:id/stop', async (c) => {
  const source = plexSource(c);
  const b = await readJson(c.req);
  if (typeof b.session === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(b.session)) {
    await plex.stopTranscode(source, b.session);
  }
  sendJson(c.res, 200, { ok: true });
});

/* ---------- Source management (owner only) ---------- */

const pending = new Map(); // handle -> { userId, servers, exp }

function takePending(handle, userId) {
  const now = Date.now();
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
  const p = pending.get(String(handle));
  if (!p || p.userId !== userId) throw new HttpError(410, 'That sign-in expired. Start again.');
  return p;
}

router.get('/api/sources', (c) => {
  needAdmin(c);
  sendJson(c.res, 200, { sources: listSources().map(publicSource) });
});

router.delete('/api/sources/:id', (c) => {
  needAdmin(c);
  const id = intParam(c.params.id);
  if (!loadSource(id)) throw new HttpError(404, 'Source not found');
  deleteSource(id);
  sendJson(c.res, 200, { ok: true });
});

router.post('/api/sources/:id/sync', (c) => {
  needAdmin(c);
  const id = intParam(c.params.id);
  const s = loadSource(id);
  if (!s) throw new HttpError(404, 'Source not found');
  if (s.type === 'direct') throw new HttpError(400, 'Direct links do not sync');
  if (isSyncing(id)) throw new HttpError(409, 'A sync is already running');
  syncInBackground(id);
  sendJson(c.res, 202, { ok: true });
});

router.post('/api/sources/plex/pin', async (c) => {
  needAdmin(c);
  sendJson(c.res, 200, await plex.createPin());
});

router.get('/api/sources/plex/pin/:id', async (c) => {
  const s = needAdmin(c);
  const token = await plex.checkPin(c.params.id, c.url.searchParams.get('code') || '');
  if (!token) return sendJson(c.res, 200, { authorized: false });
  const servers = await plex.listServers(token);
  const handle = crypto.randomUUID();
  pending.set(handle, { userId: s.user.id, servers, exp: Date.now() + 15 * 60_000 });
  sendJson(c.res, 200, {
    authorized: true,
    handle,
    servers: servers.map((v, index) => ({ index, name: v.name, owned: v.owned, product: v.product })),
  });
});

router.post('/api/sources/plex/connect', async (c) => {
  const s = needAdmin(c);
  const b = await readJson(c.req);
  const p = takePending(b.handle, s.user.id);
  const server = p.servers[Number(b.index)];
  if (!server) throw new HttpError(400, 'Pick a server');
  const conn = await plex.pickConnection(server);
  if (!conn) {
    throw new HttpError(502, `NEXUS could not reach "${server.name}" from where it is running. If NEXUS is hosted online, enable Remote Access in Plex (Settings → Remote Access) or use a Tailscale/VPN address with “Add by address”.`);
  }
  const baseUrl = conn.uri.replace(/\/$/, '');
  const info = await plex.testConnection(baseUrl, server.accessToken);
  const via = conn.relay ? 'relay' : conn.local ? 'local' : 'remote';
  const id = createSource('plex', server.name, { baseUrl, token: server.accessToken, via });
  syncInBackground(id);
  pending.delete(String(b.handle));
  sendJson(c.res, 201, { source: publicSource(loadSource(id)), via, sections: info.sections });
});

router.post('/api/sources/plex/manual', async (c) => {
  needAdmin(c);
  const b = await readJson(c.req);
  const token = String(b.token || '').trim();
  if (!b.url || !token) throw new HttpError(400, 'Enter the server address and its Plex token');
  const info = await plex.testConnection(String(b.url).trim(), token);
  const name = String(b.name || info.name).trim().slice(0, 60) || info.name;
  const id = createSource('plex', name, { baseUrl: info.origin, token });
  syncInBackground(id);
  sendJson(c.res, 201, { source: publicSource(loadSource(id)), sections: info.sections });
});

router.post('/api/sources/archive', async (c) => {
  needAdmin(c);
  const b = await readJson(c.req);
  const query = String(b.query || '').trim().slice(0, 120);
  const limit = Math.min(Math.max(parseInt(b.limit, 10) || 30, 1), 100);
  const name = String(b.name || '').trim().slice(0, 60) || (query ? `Internet Archive — ${query}` : 'Public-domain classics');
  const id = createSource('archive', name, { collection: 'feature_films', query, limit });
  syncInBackground(id);
  sendJson(c.res, 201, { source: publicSource(loadSource(id)) });
});

router.post('/api/sources/direct/items', async (c) => {
  needAdmin(c);
  const b = await readJson(c.req);
  const title = String(b.title || '').trim().slice(0, 140);
  let url;
  try { url = new URL(String(b.url || '').trim()); } catch { throw new HttpError(400, 'Enter a valid video link'); }
  if (!/^https?:$/.test(url.protocol)) throw new HttpError(400, 'Link must start with http:// or https://');
  if (!title) throw new HttpError(400, 'Give the title a name');
  let poster = null;
  if (b.poster) {
    try {
      const pu = new URL(String(b.poster));
      if (/^https?:$/.test(pu.protocol)) poster = `url:${pu.href}`;
    } catch { /* ignore bad poster */ }
  }
  const year = parseInt(b.year, 10);
  const cr = String(b.contentRating || '').toUpperCase();
  const sourceId = ensureDirectSource();
  const r = run(
    `INSERT INTO items(source_id, ext_id, kind, title, year, summary, genres, content_rating, poster, backdrop, added_at, play_ref)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    sourceId, crypto.randomUUID(), 'movie', title,
    Number.isFinite(year) && year > 1880 && year < 2200 ? year : null,
    String(b.summary || '').slice(0, 800),
    JSON.stringify(['Added by you']),
    ['G', 'PG', 'PG-13', 'R', 'NC-17', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'].includes(cr) ? cr : null,
    poster, poster, Date.now(), JSON.stringify({ url: url.href }),
  );
  run(`UPDATE sources SET item_count = (SELECT COUNT(*) FROM items WHERE source_id = ?) WHERE id = ?`, sourceId, sourceId);
  sendJson(c.res, 201, { id: Number(r.lastInsertRowid) });
});

router.delete('/api/items/:id', (c) => {
  needAdmin(c);
  const id = intParam(c.params.id);
  const row = get(`SELECT items.source_id FROM items JOIN sources ON sources.id = items.source_id WHERE items.id = ? AND sources.type = 'direct'`, id);
  if (!row) throw new HttpError(404, 'Only titles you added by link can be removed here');
  run('DELETE FROM items WHERE id = ?', id);
  run(`UPDATE sources SET item_count = (SELECT COUNT(*) FROM items WHERE source_id = ?) WHERE id = ?`, row.source_id, row.source_id);
  sendJson(c.res, 200, { ok: true });
});

router.get('/api/settings', (c) => {
  needAdmin(c);
  sendJson(c.res, 200, { openSignup: getSetting('open_signup', '0') === '1' });
});

router.patch('/api/settings', async (c) => {
  needAdmin(c);
  const b = await readJson(c.req);
  if (b.openSignup !== undefined) setSetting('open_signup', b.openSignup ? '1' : '0');
  sendJson(c.res, 200, { openSignup: getSetting('open_signup', '0') === '1' });
});

/* ---------- Server ---------- */

async function handle(req, res) {
  secureHeaders(res);
  const url = new URL(req.url, 'http://localhost');
  const isApi = url.pathname.startsWith('/api/');
  try {
    if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(req.method)) throw new HttpError(405, 'Method not allowed');
    if (isApi) {
      if (!['GET', 'HEAD'].includes(req.method)) checkOrigin(req);
      const m = router.match(req.method, url.pathname);
      if (!m) throw new HttpError(404, 'Not found');
      await m.handler({ req, res, url, params: m.params, session: auth.authenticate(req) });
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Method not allowed');
    let p;
    try { p = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'Bad path'); }
    if (p.includes('\0')) throw new HttpError(400, 'Bad path');
    if (serveStatic(req, res, p)) return;
    // Single-page app: unknown non-file routes fall back to the shell.
    if (!/\.[a-z0-9]+$/i.test(p) && serveStatic(req, res, '/')) return;
    throw new HttpError(404, 'Not found');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (!(e instanceof HttpError)) console.error('[error]', req.method, req.url, e);
    if (res.headersSent) { res.destroy(); return; }
    if (isApi) sendJson(res, status, { error: status === 500 ? 'Something went wrong on the server' : e.message });
    else {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(status === 404 ? 'Not found' : e.message);
    }
  }
}

export function start() {
  const server = http.createServer(handle);
  server.requestTimeout = 0; // streams are long-lived
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  startScheduler();
  server.listen(config.port, config.host, () => {
    console.log(`NEXUS listening on http://${config.host}:${config.port}  (data: ${config.dataDir})`);
    if (!auth.userCount()) console.log('No accounts yet — open the site and create the owner account.');
  });
  const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
