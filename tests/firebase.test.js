// Exercises firebase/backend.js (the browser-side API) against an in-memory fake of Firebase Auth + Firestore.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { items, AVATARS } from '../demo/catalog.mjs';

const root = new URL('..', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-fb-'));
const bundle = path.join(tmp, 'backend.mjs');
await build({
  entryPoints: [path.join(root, 'firebase/backend.js')], outfile: bundle, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
  plugins: [{ name: 'fake-sdk', setup(b) { b.onResolve({ filter: /^\.\/sdk\.js$/ }, () => ({ path: path.join(root, 'tests/fake-firebase-sdk.js'), external: true })); } }],
});
const fake = await import(path.join(root, 'tests/fake-firebase-sdk.js'));

const store = new Map();
globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.location = { origin: 'https://nexus.test' };
const nativeFetch = globalThis.fetch;
globalThis.window = globalThis;
globalThis.fetch = async (u) => {
  const p = new URL(u, 'https://nexus.test').pathname;
  if (p === '/__/firebase/init.json') return new Response(JSON.stringify({ projectId: 'x', apiKey: 'k' }));
  if (p === '/catalog.json') return new Response(JSON.stringify({ avatars: AVATARS, items: items.map((i, n) => (n === items.length - 1 ? { ...i, private: true } : i)) }));
  throw new Error(`unexpected fetch ${p}`);
};
await import(bundle);
const shimmed = globalThis.fetch; globalThis.fetch = shimmed;
void nativeFetch;

const call = async (method, p, body) => {
  const res = await shimmed(p, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, ...(await res.json()) };
};
const get = (p) => call('GET', p);
const post = (p, b = {}) => call('POST', p, b);

test.beforeEach(() => { fake.resetFake(); store.clear(); });

const seedInvite = (code = 'TEST-CODE', inv = {}) => fake.db.set(`invites/${code}`, { email: '', maxUses: 100, uses: 0, createdAt: 1, ...inv });
async function signUp(email = 'a@b.co', name = 'Abdoul Samb', invite = 'TEST-CODE') {
  if (!fake.db.has(`invites/${invite}`)) seedInvite(invite);
  const r = await post('/api/auth/register', { name, email, password: 'secret-pass-1', invite }); assert.equal(r.status, 200, r.error); return r;
}
async function pick(name) { const { profiles } = await get('/api/profiles'); const p = profiles.find((x) => x.name === name); const r = await post(`/api/profiles/${p.id}/select`); assert.equal(r.status, 200, r.error); return p; }

test('session starts signed out and offers sign-up and email reset', async () => {
  const s = await get('/api/session');
  assert.equal(s.user, null); assert.equal(s.signupOpen, true); assert.equal(s.canReset, true); assert.equal(s.avatars.length, 10);
});

test('register creates the account and a first profile; wrong password and duplicates are refused', async () => {
  await signUp();
  const s = await get('/api/session');
  assert.equal(s.user.email, 'a@b.co'); assert.equal(s.user.name, 'Abdoul Samb'); assert.equal(s.profile, null);
  const { profiles } = await get('/api/profiles'); assert.equal(profiles.length, 1); assert.equal(profiles[0].name, 'Abdoul');
  await post('/api/auth/logout');
  assert.equal((await get('/api/session')).user, null);
  assert.equal((await post('/api/auth/login', { email: 'a@b.co', password: 'nope' })).status, 401);
  assert.equal((await post('/api/auth/register', { name: 'X', email: 'a@b.co', password: 'secret-pass-1', invite: 'TEST-CODE' })).status, 409);
  assert.equal((await post('/api/auth/register', { name: 'X', email: 'c@d.co', password: 'short' })).status, 400);
  assert.equal((await post('/api/auth/login', { email: 'a@b.co', password: 'secret-pass-1' })).status, 200);
});

test('signed-out calls are refused; catalog calls need a chosen profile', async () => {
  assert.equal((await get('/api/profiles')).status, 401);
  assert.equal((await get('/api/home')).status, 401);
  await signUp();
  assert.equal((await get('/api/home')).status, 409);
  await pick('Abdoul');
  const h = await get('/api/home'); assert.equal(h.status, 200); assert.ok(h.hero); assert.ok(h.rows.length > 3);
});

test('profiles: create, limit of 6, rename, delete (and its data)', async () => {
  await signUp();
  for (let i = 0; i < 5; i++) assert.equal((await post('/api/profiles', { name: `P${i}`, avatar: i })).status, 200);
  assert.equal((await post('/api/profiles', { name: 'Seventh' })).status, 400);
  const { profiles } = await get('/api/profiles'); assert.equal(profiles.length, 6);
  const ids = new Set(profiles.map((p) => p.id)); assert.equal(ids.size, 6);
  const p = await pick('P0');
  await post('/api/progress', { itemId: 1, positionMs: 30000, durationMs: 100000 });
  assert.equal((await call('PATCH', `/api/profiles/${p.id}`, { name: 'Renamed' })).profile.name, 'Renamed');
  assert.equal((await call('DELETE', `/api/profiles/${p.id}`)).status, 200);
  assert.ok(![...fake.db.keys()].some((k) => k.includes(`/profiles/${p.id}`)), 'profile data removed');
  assert.equal((await get('/api/session')).profile, null);
});

test('kids profile hides unrated and adult titles everywhere', async () => {
  await signUp();
  assert.equal((await post('/api/profiles', { name: 'Kid', kids: true })).status, 200);
  await pick('Kid');
  const all = (await get('/api/browse?limit=200')).items; assert.ok(all.length > 0);
  assert.ok(all.every((i) => ['G', 'PG', 'TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G', 'TV-PG', 'U'].includes(i.contentRating)));
  const adult = items.find((i) => i.contentRating === 'R');
  assert.equal((await get(`/api/items/${adult.id}`)).status, 404);
  assert.equal((await get(`/api/items/${adult.id}/play`)).status, 404);
  assert.equal((await post(`/api/mylist/${adult.id}`)).status, 404);
  assert.equal((await post('/api/progress', { itemId: adult.id, positionMs: 1000, durationMs: 5000 })).status, 400);
  assert.ok(!(await get('/api/mylist')).items.some((i) => i.id === adult.id), 'adult title never listed for kids');
});

test('PIN: needs the account password to set, 4 digits, wrong PIN refused, lock-out after 5 tries', async () => {
  await signUp();
  const p = (await get('/api/profiles')).profiles[0];
  assert.equal((await call('PATCH', `/api/profiles/${p.id}`, { pin: '1234' })).status, 403);
  assert.equal((await call('PATCH', `/api/profiles/${p.id}`, { pin: '1234', password: 'wrong-pass' })).status, 403);
  assert.equal((await call('PATCH', `/api/profiles/${p.id}`, { pin: '12', password: 'secret-pass-1' })).status, 400);
  const ok = await call('PATCH', `/api/profiles/${p.id}`, { pin: '1234', password: 'secret-pass-1' }); assert.equal(ok.status, 200); assert.equal(ok.profile.locked, true);
  const stored = fake.db.get(`users/${(await get('/api/session')).user.id}/profiles/${p.id}`); assert.ok(stored.pinHash && stored.pinSalt && !JSON.stringify(stored).includes('1234'));
  for (let i = 0; i < 5; i++) assert.equal((await post(`/api/profiles/${p.id}/select`, { pin: '0000' })).status, 401);
  assert.equal((await post(`/api/profiles/${p.id}/select`, { pin: '1234' })).status, 429);
});

test('PIN accepted when right; removing it needs the password; Kids flag change needs the password', async () => {
  await signUp();
  const p = (await get('/api/profiles')).profiles[0];
  await call('PATCH', `/api/profiles/${p.id}`, { pin: '4321', password: 'secret-pass-1' });
  assert.equal((await post(`/api/profiles/${p.id}/select`, { pin: '4321' })).status, 200);
  assert.equal((await call('PATCH', `/api/profiles/${p.id}`, { pin: null })).status, 403);
  assert.equal((await call('PATCH', `/api/profiles/${p.id}`, { pin: null, password: 'secret-pass-1' })).profile.locked, false);
  assert.equal((await call('PATCH', `/api/profiles/${p.id}`, { kids: true })).status, 403);
  assert.equal((await call('PATCH', `/api/profiles/${p.id}`, { kids: true, password: 'secret-pass-1' })).profile.kids, true);
});

test('progress and My List persist per profile and drive Continue Watching', async () => {
  await signUp(); await post('/api/profiles', { name: 'Other' });
  await pick('Abdoul');
  assert.equal((await post('/api/mylist/2')).inList, true);
  assert.equal((await post('/api/progress', { itemId: 1, positionMs: 50000, durationMs: 100000 })).status, 200);
  const h = await get('/api/home');
  assert.equal(h.rows[0].id, 'continue'); assert.equal(h.rows[0].items[0].id, 1); assert.ok(Math.abs(h.rows[0].items[0].progress.pct - 0.5) < 1e-9);
  assert.ok(h.rows.find((r) => r.id === 'mylist').items.some((i) => i.id === 2));
  // data survives a reload (fresh in-memory cache) because it is in the store
  await post('/api/profile/leave'); await pick('Abdoul');
  assert.equal((await get('/api/mylist')).items[0].id, 2);
  // a different profile sees none of it
  await post('/api/profile/leave'); await pick('Other');
  assert.equal((await get('/api/mylist')).items.length, 0);
  assert.equal((await get('/api/home')).rows[0].id !== 'continue', true);
  // dismissing progress
  await post('/api/profile/leave'); await pick('Abdoul');
  assert.equal((await call('DELETE', '/api/progress/1')).status, 200);
  assert.notEqual((await get('/api/home')).rows[0].id, 'continue');
  assert.equal((await post('/api/progress', { itemId: 999, positionMs: 1, durationMs: 2 })).status, 400);
  assert.equal((await call('DELETE', '/api/mylist/2')).inList, false);
});

test('play returns the sample clip with resume position; shows need an episode', async () => {
  await signUp(); await pick('Abdoul');
  const m = await get('/api/items/1/play'); assert.equal(m.type, 'mp4'); assert.equal(m.url, '/clip.mp4'); assert.equal(m.startMs, 0);
  await post('/api/progress', { itemId: 1, positionMs: 5000, durationMs: 8000 });
  assert.equal((await get('/api/items/1/play')).startMs, 5000);
  const show = items.find((i) => i.kind === 'show');
  assert.equal((await get(`/api/items/${show.id}/play`)).status, 400);
  const ep = show.seasons[0].episodes[0];
  const e = await get(`/api/items/${show.id}/play?ep=${ep.key}`); assert.equal(e.status, 200); assert.match(e.epLabel, /^S1 · E1$/);
});

test('account password change and email reset', async () => {
  await signUp();
  assert.equal((await post('/api/account/password', { currentPassword: 'bad', newPassword: 'another-pass-2' })).status, 403);
  assert.equal((await post('/api/account/password', { currentPassword: 'secret-pass-1', newPassword: 'x' })).status, 400);
  assert.equal((await post('/api/account/password', { currentPassword: 'secret-pass-1', newPassword: 'another-pass-2' })).status, 200);
  await post('/api/auth/logout');
  assert.equal((await post('/api/auth/login', { email: 'a@b.co', password: 'secret-pass-1' })).status, 401);
  assert.equal((await post('/api/auth/login', { email: 'a@b.co', password: 'another-pass-2' })).status, 200);
  assert.equal((await post('/api/auth/forgot', { email: 'a@b.co' })).status, 200);
  assert.equal((await post('/api/auth/forgot', { email: 'nobody@x.co' })).status, 200, 'same answer for unknown emails');
  assert.deepEqual(fake.sendPasswordResetEmail.sent.slice(-1), ['nobody@x.co']);
  assert.equal((await post('/api/auth/forgot', { email: 'not-an-email' })).status, 400);
});

test('owner access comes only from an admins/{uid} document; owners can list people and email reset links', async () => {
  await signUp('owner@x.co', 'Owner One'); await post('/api/auth/logout'); await signUp('friend@x.co', 'Friend Two');
  let s = await get('/api/session'); assert.equal(s.user.isAdmin, false); assert.equal(s.hosted, true);
  for (const p of ['/api/users', '/api/sources', '/api/settings']) assert.equal((await get(p)).status, 403, p);
  assert.equal((await post(`/api/users/${s.user.id}/password`)).status, 403);
  await post('/api/auth/logout'); await post('/api/auth/login', { email: 'owner@x.co', password: 'secret-pass-1' });
  s = await get('/api/session'); fake.db.set(`admins/${s.user.id}`, { role: 'owner' });
  s = await get('/api/session'); assert.equal(s.user.isAdmin, true);
  const { users } = await get('/api/users'); assert.deepEqual(users.map((u) => u.email).sort(), ['friend@x.co', 'owner@x.co']);
  const friend = users.find((u) => u.email === 'friend@x.co');
  const r = await post(`/api/users/${friend.id}/password`); assert.equal(r.emailed, true); assert.equal(fake.sendPasswordResetEmail.sent.slice(-1)[0], 'friend@x.co');
  assert.equal((await post('/api/users/nobody/password')).status, 404);
  assert.deepEqual((await get('/api/sources')).sources, []);
});

test('unknown routes are cleanly unavailable', async () => {
  await signUp(); await pick('Abdoul');
  const r = await post('/api/sources/plex/pin'); assert.equal(r.status, 404); assert.match(r.error, /no media-server admin/);
});

test('sign-up needs a valid invite; a bad one leaves no account behind', async () => {
  const reg = (b) => post('/api/auth/register', { name: 'N', email: 'new@x.co', password: 'secret-pass-1', ...b });
  assert.equal((await get('/api/session')).inviteRequired, true);
  assert.equal((await reg({})).status, 400);
  const bad = await reg({ invite: 'nx-nope' }); assert.equal(bad.status, 403); assert.match(bad.error, /invite code is not valid/);
  assert.equal(fake.users.has('new@x.co'), false); assert.deepEqual(fake.fakeDeleted, ['new@x.co']);
  assert.equal([...fake.db.keys()].some((k) => k.startsWith('users/')), false);
  seedInvite('NX-GOOD', { maxUses: 1 });
  assert.equal((await reg({ invite: ' nx-good ' })).status, 200);
  assert.equal(fake.db.get('invites/NX-GOOD').uses, 1);
  await post('/api/auth/logout');
  const again = await post('/api/auth/register', { name: 'Two', email: 'two@x.co', password: 'secret-pass-1', invite: 'NX-GOOD' });
  assert.equal(again.status, 403); assert.equal(fake.users.has('two@x.co'), false);
});

test('an invite made for one email works only for that email (any letter case)', async () => {
  seedInvite('NX-MINE', { email: 'mom@x.co', maxUses: 1 });
  const other = await post('/api/auth/register', { name: 'Eve', email: 'eve@x.co', password: 'secret-pass-1', invite: 'NX-MINE' });
  assert.equal(other.status, 403); assert.equal(fake.db.get('invites/NX-MINE').uses, 0);
  const mom = await post('/api/auth/register', { name: 'Mom', email: 'Mom@X.co', password: 'secret-pass-1', invite: 'NX-MINE' });
  assert.equal(mom.status, 200, mom.error);
});

test('the owner can create, list and delete invites; others cannot', async () => {
  await signUp('owner@x.co', 'Owner'); assert.equal((await get('/api/invites')).status, 403);
  fake.db.set(`admins/${(await get('/api/session')).user.id}`, { role: 'owner' });
  const bound = await post('/api/invites', { email: ' Dad@X.co ', maxUses: 9 });
  assert.equal(bound.status, 200); assert.match(bound.code, /^NX-[A-Z2-9]{12}$/); assert.equal(bound.email, 'dad@x.co'); assert.equal(bound.maxUses, 1);
  const shared = await post('/api/invites', { maxUses: 5 }); assert.equal(shared.maxUses, 5); assert.notEqual(shared.code, bound.code);
  assert.equal((await post('/api/invites', { email: 'nope' })).status, 400);
  assert.equal((await get('/api/invites')).invites.length, 3);
  assert.equal((await call('DELETE', `/api/invites/${shared.code}`)).status, 200);
  assert.equal((await get('/api/invites')).invites.some((v) => v.code === shared.code), false);
  await post('/api/auth/logout');
  const dad = await post('/api/auth/register', { name: 'Dad', email: 'dad@x.co', password: 'secret-pass-1', invite: bound.code });
  assert.equal(dad.status, 200, dad.error);
});

test('titles exported from Plex are listed but cannot be played on the public site', async () => {
  await signUp(); await pick('Abdoul');
  const r = await get(`/api/items/${items[items.length - 1].id}/play`); assert.equal(r.status, 403); assert.match(r.error, /private NEXUS server/);
  assert.equal((await get(`/api/items/${items[1].id}/play`)).status, 200);
});
