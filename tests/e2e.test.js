import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startMock, TOKEN } from './mock-plex.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let mock, child, base, dataDir, log = '';

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

/** Minimal cookie-aware client. */
class Client {
  cookie = '';
  async req(method, url, body, headers = {}) {
    const r = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const set = r.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return r;
  }
  async json(method, url, body, headers) {
    const r = await this.req(method, url, body, headers);
    let data = null;
    try { data = await r.json(); } catch { /* none */ }
    return { status: r.status, data, headers: r.headers };
  }
  get(url) { return this.json('GET', url); }
  post(url, body = {}) { return this.json('POST', url, body); }
}

before(async () => {
  mock = await startMock();
  const port = await freePort();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-'));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, PLEX_TV_URL: mock.origin, ARCHIVE_URL: mock.origin, FETCH_TIMEOUT_MS: '1500', SYNC_HOURS: '0' },
  });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${log}`);
});

after(async () => {
  child?.kill();
  await mock?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const owner = new Client();
const wait = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 150));
  }
};

/* ---------- Accounts & profiles ---------- */

test('first run: owner account, then sign-ups close', async () => {
  const s = await new Client().get('/api/session');
  assert.equal(s.data.setupNeeded, true);
  assert.equal(s.data.user, null);

  assert.equal((await owner.post('/api/auth/register', { name: 'AB Samb', email: 'AB@example.com', password: 'short' })).status, 400);
  const r = await owner.post('/api/auth/register', { name: 'AB Samb', email: 'AB@example.com', password: 'correct horse' });
  assert.equal(r.status, 201);
  assert.match(owner.cookie, /^nexus_sid=/);

  const me = await owner.get('/api/session');
  assert.equal(me.data.user.isAdmin, true);
  assert.equal(me.data.user.email, 'ab@example.com');
  assert.equal(me.data.signupOpen, false);

  const other = await new Client().post('/api/auth/register', { name: 'Eve', email: 'eve@example.com', password: 'password123' });
  assert.equal(other.status, 403);
});

test('login: wrong password rejected, right password works, passwords never returned', async () => {
  const c = new Client();
  assert.equal((await c.post('/api/auth/login', { email: 'ab@example.com', password: 'nope' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { email: 'ghost@example.com', password: 'nope' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { email: 'ab@example.com', password: 'correct horse' })).status, 200);
  assert.ok(!JSON.stringify((await c.get('/api/session')).data).includes('pass'));
});

test('API requires a session and a profile', async () => {
  assert.equal((await new Client().get('/api/home')).status, 401);
  const r = await owner.get('/api/home');
  assert.equal(r.status, 409); // signed in, no profile chosen yet
});

test('profiles: create kids profile with PIN, PIN gate, limit of 6', async () => {
  const list = await owner.get('/api/profiles');
  assert.equal(list.data.profiles.length, 1);
  const first = list.data.profiles[0];
  assert.equal((await owner.post(`/api/profiles/${first.id}/select`)).status, 200);

  const kid = await owner.post('/api/profiles', { name: 'Maimouna', avatar: 3, kids: true, pin: '1234' });
  assert.equal(kid.status, 201);
  assert.equal(kid.data.profile.kids, true);
  assert.equal(kid.data.profile.locked, true);
  assert.ok(!JSON.stringify(kid.data).includes('1234'));
  globalThis.kidId = kid.data.profile.id;

  assert.equal((await owner.post('/api/profiles', { name: 'x', avatar: 99 })).status, 400);
  assert.equal((await owner.post('/api/profiles', { name: 'x', pin: '12' })).status, 400);

  for (let i = 0; i < 4; i++) assert.equal((await owner.post('/api/profiles', { name: `P${i}`, avatar: i })).status, 201);
  assert.equal((await owner.post('/api/profiles', { name: 'Seventh' })).status, 400);
});

/* ---------- Empty state ---------- */

test('empty library reports onboarding state', async () => {
  const h = await owner.get('/api/home');
  assert.equal(h.status, 200);
  assert.equal(h.data.empty, true);
  assert.deepEqual(h.data.rows, []);
});

/* ---------- Plex: sign-in flow ---------- */

test('Plex "Sign in with Plex" flow connects a server and syncs it', async () => {
  const pin = await owner.post('/api/sources/plex/pin');
  assert.equal(pin.status, 200);
  assert.match(pin.data.authUrl, /^https:\/\/app\.plex\.tv\/auth/);

  const poll = () => owner.get(`/api/sources/plex/pin/${pin.data.id}?code=${pin.data.code}`);
  assert.equal((await poll()).data.authorized, false);
  const done = await poll();
  assert.equal(done.data.authorized, true);
  assert.equal(done.data.servers.length, 1);
  assert.ok(!JSON.stringify(done.data).includes('account-token'));
  assert.ok(!JSON.stringify(done.data).includes(TOKEN));

  const bad = await owner.post('/api/sources/plex/connect', { handle: 'nope', index: 0 });
  assert.equal(bad.status, 410);

  const c = await owner.post('/api/sources/plex/connect', { handle: done.data.handle, index: 0 });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  assert.equal(c.data.via, 'remote'); // the unreachable LAN address was skipped

  const src = await wait(async () => {
    const l = (await owner.get('/api/sources')).data.sources;
    return l.find((s) => s.type === 'plex' && s.status === 'ok');
  });
  assert.equal(src.itemCount, 4); // 3 movies + 1 show; the music section is ignored
  assert.equal(src.host, new URL(mock.origin).host);
  assert.ok(!JSON.stringify(await owner.get('/api/sources')).includes(TOKEN), 'token must never be exposed');
  globalThis.plexId = src.id;
});

test('token is encrypted at rest', () => {
  const files = fs.readdirSync(dataDir).filter((f) => f.endsWith('.db') || f.endsWith('.sqlite'));
  assert.ok(files.length, 'database file exists');
  for (const f of fs.readdirSync(dataDir)) {
    const buf = fs.readFileSync(path.join(dataDir, f));
    assert.ok(!buf.includes(Buffer.from(TOKEN)), `${f} contains the plaintext Plex token`);
  }
});

/* ---------- Browsing ---------- */

test('home, browse, search and details', async () => {
  const h = (await owner.get('/api/home')).data;
  assert.equal(h.empty, false);
  assert.ok(h.hero);
  assert.ok(h.rows.some((r) => r.id === 'recent'));
  assert.equal(h.stats.movies, 3);
  assert.equal(h.stats.shows, 1);

  const movies = (await owner.get('/api/browse?kind=movie&sort=title')).data;
  assert.deepEqual(movies.items.map((i) => i.title), ['Desert Run (MKV)', 'Little Comet', 'Neon Harbor']);
  const sci = (await owner.get('/api/browse?genre=Sci-Fi')).data;
  assert.deepEqual(sci.items.map((i) => i.title), ['Neon Harbor']);
  assert.equal((await owner.get('/api/browse?q=comet')).data.items[0].title, 'Little Comet');
  assert.equal((await owner.get('/api/browse?q=%25')).data.items.length, 0, 'LIKE wildcards are escaped');

  const m = movies.items.find((i) => i.title === 'Neon Harbor');
  assert.ok(m.poster.startsWith(`/api/sources/${globalThis.plexId}/image?`));
  assert.ok(!m.poster.includes(TOKEN));

  const show = (await owner.get('/api/browse?kind=show')).data.items[0];
  const d = (await owner.get(`/api/items/${show.id}`)).data;
  assert.equal(d.seasons[0].episodes.length, 2);
  assert.equal(d.seasons[0].episodes[1].title, 'Static');
});

test('Kids profile only sees G/PG titles, also by direct id', async () => {
  const kid = new Client();
  await kid.post('/api/auth/login', { email: 'ab@example.com', password: 'correct horse' });
  assert.equal((await kid.post(`/api/profiles/${globalThis.kidId}/select`, {})).status, 401);
  assert.equal((await kid.post(`/api/profiles/${globalThis.kidId}/select`, { pin: '0000' })).status, 401);
  assert.equal((await kid.post(`/api/profiles/${globalThis.kidId}/select`, { pin: '1234' })).status, 200);

  const items = (await kid.get('/api/browse')).data.items;
  assert.deepEqual(items.map((i) => i.title), ['Little Comet']);
  const home = (await kid.get('/api/home')).data;
  assert.ok(home.rows.every((r) => r.items.every((i) => i.title === 'Little Comet')));

  const all = (await owner.get('/api/browse')).data.items;
  const r = all.find((i) => i.contentRating === 'R');
  assert.equal((await kid.get(`/api/items/${r.id}`)).status, 404);
  assert.equal((await kid.get(`/api/items/${r.id}/play`)).status, 404);
  assert.equal((await kid.post(`/api/mylist/${r.id}`)).status, 404);

  // Kids profiles cannot reach source management even for the owner account.
  assert.equal((await kid.get('/api/sources')).status, 403);
});

test('PIN brute force is rate limited', async () => {
  const c = new Client();
  await c.post('/api/auth/login', { email: 'ab@example.com', password: 'correct horse' });
  let last;
  for (let i = 0; i < 8; i++) last = await c.post(`/api/profiles/${globalThis.kidId}/select`, { pin: '9999' });
  assert.equal(last.status, 429);
});

/* ---------- Playback ---------- */

test('direct play streams MP4 through the proxy with Range support', async () => {
  const movie = (await owner.get('/api/browse?q=neon')).data.items[0];
  const p = (await owner.get(`/api/items/${movie.id}/play`)).data;
  assert.equal(p.type, 'mp4');
  assert.equal(p.mode, 'direct');
  assert.ok(p.url.startsWith(`/api/sources/${globalThis.plexId}/proxy?u=`));
  assert.ok(!p.url.includes(TOKEN));

  const full = await owner.req('GET', p.url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  const size = (await full.arrayBuffer()).byteLength;
  assert.ok(size > 1000);

  const part = await owner.req('GET', p.url, undefined, { Range: 'bytes=0-99' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-99/${size}`);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
});

test('non-browser-friendly files fall back to HLS and playlists are rewritten', async () => {
  const movie = (await owner.get('/api/browse?q=desert')).data.items[0];
  const p = (await owner.get(`/api/items/${movie.id}/play`)).data;
  assert.equal(p.type, 'hls');
  assert.equal(p.mode, 'transcode');
  assert.ok(p.session);

  const pl = await owner.req('GET', p.url);
  assert.equal(pl.status, 200);
  const text = await pl.text();
  const segs = text.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.ok(segs.length >= 3);
  for (const s of segs) {
    assert.ok(s.startsWith(`/api/sources/${globalThis.plexId}/proxy?u=`), `segment not proxied: ${s}`);
    assert.ok(!s.includes(mock.origin) && !s.includes(TOKEN));
  }
  const seg = await owner.req('GET', segs[0]);
  assert.equal(seg.status, 200);
  assert.ok((await seg.arrayBuffer()).byteLength > 1000);

  await owner.post(`/api/sources/${globalThis.plexId}/stop`, { session: p.session });
  assert.equal(mock.stats.stopped, p.session);

  const forced = (await owner.get(`/api/items/${(await owner.get('/api/browse?q=neon')).data.items[0].id}/play?mode=hls`)).data;
  assert.equal(forced.type, 'hls');
});

test('episodes play; unknown episode ids are rejected', async () => {
  const show = (await owner.get('/api/browse?kind=show')).data.items[0];
  assert.equal((await owner.get(`/api/items/${show.id}/play`)).status, 400);
  assert.equal((await owner.get(`/api/items/${show.id}/play?ep=101`)).status, 404, 'movie id must not play as an episode');
  assert.equal((await owner.get(`/api/items/${show.id}/play?ep=abc`)).status, 400);
  const p = (await owner.get(`/api/items/${show.id}/play?ep=402`)).data;
  assert.equal(p.epLabel, 'S1 · E2');
  assert.equal(p.title, 'Signal Lost — Static');
});

test('image proxy works and the stream proxy cannot be abused', async () => {
  const movie = (await owner.get('/api/browse?q=neon')).data.items[0];
  const img = await owner.req('GET', movie.poster);
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type'), /^image\//);

  const proxy = (u) => owner.req('GET', `/api/sources/${globalThis.plexId}/proxy?u=${encodeURIComponent(u)}`);
  assert.equal((await proxy('/secret/admin')).status, 403);
  assert.equal((await proxy('/library/sections')).status, 403);
  assert.equal((await proxy('/library/parts/../../secret/admin')).status, 403);
  assert.equal((await proxy('/library/parts/%2e%2e/%2e%2e/secret/admin')).status, 403);
  assert.equal((await proxy('//evil.example/library/parts/1')).status, 400);
  assert.equal((await proxy('http://evil.example/library/parts/1')).status, 400);
  assert.equal((await owner.req('GET', `/api/sources/${globalThis.plexId}/image?p=${encodeURIComponent('/secret/admin')}`)).status, 400);
  assert.equal((await new Client().req('GET', movie.poster)).status, 401);
});

test('progress: resume position, continue-watching row, My List', async () => {
  const movie = (await owner.get('/api/browse?q=neon')).data.items[0];
  assert.equal((await owner.post('/api/progress', { itemId: movie.id, positionMs: 3000, durationMs: 6000 })).status, 200);
  assert.equal((await owner.post('/api/progress', { itemId: movie.id, positionMs: -1, durationMs: 6000 })).status, 400);
  assert.equal((await owner.post('/api/progress', { itemId: 9999, positionMs: 1, durationMs: 6000 })).status, 404);

  assert.equal((await owner.get(`/api/items/${movie.id}/play`)).data.startMs, 3000);
  const home = (await owner.get('/api/home')).data;
  const cont = home.rows.find((r) => r.id === 'continue');
  assert.equal(cont.items[0].id, movie.id);
  assert.equal(Math.round(cont.items[0].progress.pct * 100), 50);

  // Finished titles drop off Continue Watching.
  await owner.post('/api/progress', { itemId: movie.id, positionMs: 6000, durationMs: 6000 });
  assert.ok(!(await owner.get('/api/home')).data.rows.some((r) => r.id === 'continue'));

  assert.equal((await owner.post(`/api/mylist/${movie.id}`)).status, 200);
  assert.equal((await owner.get('/api/mylist')).data.items[0].id, movie.id);
  assert.equal((await owner.get('/api/home')).data.rows[0].id, 'mylist');
  assert.equal((await owner.json('DELETE', `/api/mylist/${movie.id}`)).status, 200);
  assert.equal((await owner.get('/api/mylist')).data.items.length, 0);
});

/* ---------- Other sources ---------- */

test('Internet Archive import skips titles without a web-playable file', async () => {
  const r = await owner.post('/api/sources/archive', { limit: 10 });
  assert.equal(r.status, 201);
  const src = await wait(async () => (await owner.get('/api/sources')).data.sources.find((s) => s.type === 'archive' && s.status === 'ok'));
  assert.equal(src.itemCount, 2);

  const z = (await owner.get('/api/browse?q=zombies')).data.items[0];
  assert.equal(z.year, 1968);
  assert.equal(z.source, 'archive');
  assert.ok(z.genres.includes('Horror'));
  const detail = (await owner.get(`/api/items/${z.id}`)).data.item;
  assert.ok(!detail.summary.includes('<'), 'HTML stripped from descriptions');

  const p = (await owner.get(`/api/items/${z.id}/play`)).data;
  assert.equal(p.type, 'mp4');
  assert.equal(p.url, `${mock.origin}/download/night_of_the_zombies/clip.mp4`, 'picks the largest file under 1.2 GB');
  assert.equal((await fetch(p.url)).status, 200);
});

test('direct links: validation, add, play, remove', async () => {
  const add = (b) => owner.post('/api/sources/direct/items', b);
  assert.equal((await add({ title: 'Bad', url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await add({ title: 'Bad', url: 'ftp://x/y.mp4' })).status, 400);
  assert.equal((await add({ url: 'https://example.com/a.mp4' })).status, 400);

  const r = await add({ title: 'My Stream', url: 'https://example.com/live/index.m3u8?x=1', poster: 'javascript:alert(1)', year: 2024 });
  assert.equal(r.status, 201);
  const it = (await owner.get('/api/browse?q=stream')).data.items[0];
  assert.equal(it.poster, null, 'non-http poster is dropped');
  const p = (await owner.get(`/api/items/${it.id}/play`)).data;
  assert.equal(p.type, 'hls');
  assert.equal((await owner.json('DELETE', `/api/items/${it.id}`)).status, 200);
  assert.equal((await owner.get('/api/browse?q=stream')).data.items.length, 0);
});

test('manual Plex connection validates address and token', async () => {
  const bad = await owner.post('/api/sources/plex/manual', { url: mock.origin, token: 'wrong' });
  assert.equal(bad.status, 502);
  assert.match(bad.data.error, /token/i);
  assert.equal((await owner.post('/api/sources/plex/manual', { url: '', token: '' })).status, 400);
  const ok = await owner.post('/api/sources/plex/manual', { url: mock.origin, token: TOKEN, name: 'Manual' });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.source.name, 'Manual');
  await wait(async () => (await owner.get('/api/sources')).data.sources.find((s) => s.name === 'Manual' && s.status === 'ok'));
  // Same server twice must not duplicate titles in a source, and removing a source removes only its titles.
  const before = (await owner.get('/api/home')).data.stats.movies;
  const manual = (await owner.get('/api/sources')).data.sources.find((s) => s.name === 'Manual');
  assert.equal((await owner.json('DELETE', `/api/sources/${manual.id}`)).status, 200);
  assert.equal((await owner.get('/api/home')).data.stats.movies, before - 3);
});

test('a failing source reports a readable error and keeps its titles', async () => {
  const mgr = await owner.post('/api/sources/plex/manual', { url: mock.origin, token: TOKEN, name: 'Flaky' });
  const id = mgr.data.source.id;
  await wait(async () => (await owner.get('/api/sources')).data.sources.find((s) => s.id === id && s.status === 'ok'));
  await mock.close();
  assert.equal((await owner.post(`/api/sources/${id}/sync`)).status, 202);
  const failed = await wait(async () => (await owner.get('/api/sources')).data.sources.find((s) => s.id === id && s.status === 'error'));
  assert.match(failed.lastError, /Could not reach/);
  assert.equal(failed.itemCount, 4);
  mock = await startMock(Number(new URL(mock.origin).port)).catch(() => mock);
});

/* ---------- Security ---------- */

test('cross-origin writes are blocked; security headers present', async () => {
  const r = await owner.json('POST', '/api/auth/logout', {}, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  const page = await owner.req('GET', '/');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const trav = await owner.req('GET', '/..%2f..%2fetc/passwd'); // extensionless → SPA shell, never the real file
  assert.ok(!(await trav.text()).includes('root:'));
  assert.equal((await owner.req('GET', '/%2e%2e/server/config.js')).status, 404);
  assert.equal((await owner.req('GET', '/api/nope')).status, 404);
});

test('members cannot manage sources; owner can open sign-up for them', async () => {
  assert.equal((await owner.json('PATCH', '/api/settings', { openSignup: true })).status, 200);
  const m = new Client();
  assert.equal((await m.post('/api/auth/register', { name: 'Fatou', email: 'fatou@example.com', password: 'password123' })).status, 201);
  assert.equal((await owner.json('PATCH', '/api/settings', { openSignup: false })).status, 200);

  const profiles = (await m.get('/api/profiles')).data.profiles;
  await m.post(`/api/profiles/${profiles[0].id}/select`);
  assert.equal((await m.get('/api/sources')).status, 403);
  assert.equal((await m.post('/api/sources/archive', {})).status, 403);
  assert.equal((await m.json('PATCH', '/api/settings', { openSignup: true })).status, 403);
  assert.equal((await m.get('/api/home')).status, 200, 'members share the library');
  // Profiles and history are private per account.
  assert.equal((await m.post(`/api/profiles/${globalThis.kidId}/select`)).status, 404);
  assert.equal((await m.get('/api/mylist')).data.items.length, 0);
});

test('sign out invalidates the session', async () => {
  const c = new Client();
  await c.post('/api/auth/login', { email: 'ab@example.com', password: 'correct horse' });
  const old = c.cookie;
  assert.equal((await c.post('/api/auth/logout')).status, 200);
  const r = await fetch(`${base}/api/profiles`, { headers: { Cookie: old } });
  assert.equal(r.status, 401);
});

/* ---------- Self-service account & parental controls ---------- */

test('Continue Watching entries can be dismissed per profile', async () => {
  const movie = (await owner.get('/api/browse?q=neon')).data.items[0];
  await owner.post('/api/progress', { itemId: movie.id, positionMs: 2000, durationMs: 6000 });
  assert.ok((await owner.get('/api/home')).data.rows.some((r) => r.id === 'continue'));
  assert.equal((await owner.json('DELETE', `/api/progress/${movie.id}`)).status, 200);
  assert.ok(!(await owner.get('/api/home')).data.rows.some((r) => r.id === 'continue'));
  assert.equal((await owner.get(`/api/items/${movie.id}/play`)).data.startMs, 0);
  assert.equal((await new Client().json('DELETE', `/api/progress/${movie.id}`)).status, 401);
});

test('play info and sources expose connection type for the relay indicator', async () => {
  const movie = (await owner.get('/api/browse?q=neon')).data.items[0];
  const p = (await owner.get(`/api/items/${movie.id}/play`)).data;
  assert.equal(p.plex, true);
  assert.equal(p.relay, false);
  const plexSrc = (await owner.get('/api/sources')).data.sources.find((s) => s.id === globalThis.plexId);
  assert.equal(plexSrc.via, 'remote');
});

test('members can change their own password; other devices are signed out', async () => {
  const a = new Client(); const b = new Client();
  for (const c of [a, b]) assert.equal((await c.post('/api/auth/login', { email: 'fatou@example.com', password: 'password123' })).status, 200);
  assert.equal((await a.post('/api/account/password', { currentPassword: 'wrong', newPassword: 'brand-new-pass' })).status, 403);
  assert.equal((await a.post('/api/account/password', { currentPassword: 'password123', newPassword: 'short' })).status, 400);
  assert.equal((await a.post('/api/account/password', { currentPassword: 'password123', newPassword: 'brand-new-pass' })).status, 200);
  assert.equal((await a.get('/api/profiles')).status, 200, 'this device stays signed in');
  assert.equal((await b.get('/api/profiles')).status, 401, 'other device is signed out');
  assert.equal((await new Client().post('/api/auth/login', { email: 'fatou@example.com', password: 'password123' })).status, 401);
  assert.equal((await new Client().post('/api/auth/login', { email: 'fatou@example.com', password: 'brand-new-pass' })).status, 200);
});

test('owner can list users and reset a member password with a one-time temporary password', async () => {
  const users = (await owner.get('/api/users')).data.users;
  assert.deepEqual(users.map((u) => u.email), ['ab@example.com', 'fatou@example.com']);
  assert.ok(!JSON.stringify(users).includes('hash'));
  const fatou = users.find((u) => u.email === 'fatou@example.com');
  const member = new Client();
  await member.post('/api/auth/login', { email: 'fatou@example.com', password: 'brand-new-pass' });

  const r = await owner.post(`/api/users/${fatou.id}/password`);
  assert.equal(r.status, 200);
  assert.match(r.data.temporaryPassword, /^[A-Za-z0-9]{12}$/);
  assert.equal((await member.get('/api/profiles')).status, 401, 'member is signed out everywhere');
  assert.equal((await new Client().post('/api/auth/login', { email: 'fatou@example.com', password: 'brand-new-pass' })).status, 401);
  assert.equal((await new Client().post('/api/auth/login', { email: 'fatou@example.com', password: r.data.temporaryPassword })).status, 200);

  const self = users.find((u) => u.email === 'ab@example.com');
  assert.equal((await owner.post(`/api/users/${self.id}/password`)).status, 400);
  assert.equal((await owner.post('/api/users/99999/password')).status, 404);

  const m2 = new Client();
  await m2.post('/api/auth/login', { email: 'fatou@example.com', password: r.data.temporaryPassword });
  const prof = (await m2.get('/api/profiles')).data.profiles[0];
  await m2.post(`/api/profiles/${prof.id}/select`);
  assert.equal((await m2.get('/api/users')).status, 403);
  assert.equal((await m2.post(`/api/users/${self.id}/password`)).status, 403);
});

test('changing a PIN or Kids setting requires the account password; renaming does not', async () => {
  const id = globalThis.kidId;
  assert.equal((await owner.json('PATCH', `/api/profiles/${id}`, { pin: null })).status, 403);
  assert.equal((await owner.json('PATCH', `/api/profiles/${id}`, { pin: null, password: 'wrong' })).status, 403);
  assert.equal((await owner.json('PATCH', `/api/profiles/${id}`, { kids: false })).status, 403, 'turning Kids off is guarded');
  assert.equal((await owner.json('PATCH', `/api/profiles/${id}`, { name: 'Maimouna K', kids: true })).status, 200, 'unchanged Kids flag + rename is fine');
  const ok = await owner.json('PATCH', `/api/profiles/${id}`, { pin: null, password: 'correct horse' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.profile.locked, false);
  assert.equal(ok.data.profile.kids, true);
});
