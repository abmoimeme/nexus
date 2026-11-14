import { all, get, run, tx, getSetting } from './db.js';
import { hashSecret, verifySecret, sha256, randomToken } from './crypto.js';
import { HttpError, parseCookies, rateLimit, rateLimitClear } from './http.js';
import { config } from './config.js';

export const COOKIE = 'nexus_sid';
export const MAX_PROFILES = 6;

/** Avatars are chosen by index so the client can never inject arbitrary CSS. */
export const AVATARS = [
  { emoji: '🦸', bg: 'linear-gradient(135deg,#1a0533,#4a0070)' },
  { emoji: '🧝', bg: 'linear-gradient(135deg,#001a33,#003d6e)' },
  { emoji: '🧙', bg: 'linear-gradient(135deg,#1a0014,#4a0030)' },
  { emoji: '🦊', bg: 'linear-gradient(135deg,#1a0a00,#4d2200)' },
  { emoji: '🐉', bg: 'linear-gradient(135deg,#001a14,#004d35)' },
  { emoji: '🌙', bg: 'linear-gradient(135deg,#00101a,#002d4d)' },
  { emoji: '⭐', bg: 'linear-gradient(135deg,#1a1200,#4d3600)' },
  { emoji: '🎭', bg: 'linear-gradient(135deg,#0a1a00,#244d00)' },
  { emoji: '🤖', bg: 'linear-gradient(135deg,#0d0d1c,#2a2a4a)' },
  { emoji: '🎸', bg: 'linear-gradient(135deg,#1a0a0a,#4d1a1a)' },
];

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
// A real hash of a throwaway value, so unknown-email logins cost the same time as wrong-password logins.
const DUMMY_HASH = await hashSecret('nexus-dummy-password');

/* ---------- Users ---------- */

export const userCount = () => get('SELECT COUNT(*) AS n FROM users').n;
export const signupOpen = () => userCount() === 0 || getSetting('open_signup', '0') === '1';

export const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, isAdmin: !!u.is_admin });

export async function register({ name, email, password }) {
  name = String(name ?? '').trim();
  email = String(email ?? '').trim().toLowerCase();
  password = String(password ?? '');
  if (!name || name.length > 60) throw new HttpError(400, 'Enter your name (up to 60 characters)');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (password.length > 200) throw new HttpError(400, 'Password is too long');
  if (!signupOpen()) throw new HttpError(403, 'Sign-ups are closed. Ask the owner for an invitation.');

  const hash = await hashSecret(password);
  try {
    return tx(() => {
      // Re-check inside the write lock so two simultaneous first sign-ups can't both become owner.
      const first = get('SELECT COUNT(*) AS n FROM users').n === 0;
      if (!first && getSetting('open_signup', '0') !== '1') throw new HttpError(403, 'Sign-ups are closed.');
      const now = Date.now();
      const r = run(
        'INSERT INTO users(email, name, pass_hash, is_admin, created_at) VALUES (?,?,?,?,?)',
        email, name, hash, first ? 1 : 0, now,
      );
      run(
        'INSERT INTO profiles(user_id, name, avatar, kids, created_at) VALUES (?,?,?,?,?)',
        r.lastInsertRowid, name.split(/\s+/)[0].slice(0, 24), 0, 0, now,
      );
      return Number(r.lastInsertRowid);
    });
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw new HttpError(409, 'An account with that email already exists');
    throw e;
  }
}

export async function login({ email, password }, ip) {
  email = String(email ?? '').trim().toLowerCase();
  password = String(password ?? '');
  if (!rateLimit(`login:ip:${ip}`, 30, 15 * 60_000) || !rateLimit(`login:em:${email}`, 10, 15 * 60_000)) {
    throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  }
  const user = get('SELECT * FROM users WHERE email = ?', email);
  const ok = await verifySecret(password, user ? user.pass_hash : DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Incorrect email or password');
  rateLimitClear(`login:em:${email}`);
  return user;
}

/* ---------- Sessions ---------- */

export function createSession(userId) {
  const token = randomToken(32);
  const now = Date.now();
  run(
    'INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)',
    sha256(token), userId, now, now + config.sessionDays * 86_400_000,
  );
  return token;
}

export function destroySession(req) {
  const t = parseCookies(req)[COOKIE];
  if (t) run('DELETE FROM sessions WHERE token_hash = ?', sha256(t));
}

/** Returns { tokenHash, user, profileId } or null. */
export function authenticate(req) {
  const t = parseCookies(req)[COOKIE];
  if (!t) return null;
  const row = get(
    `SELECT s.token_hash, s.profile_id, s.expires_at,
            u.id AS uid, u.email, u.name, u.is_admin
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    sha256(t),
  );
  if (!row || row.expires_at < Date.now()) return null;
  return {
    tokenHash: row.token_hash,
    profileId: row.profile_id,
    user: { id: row.uid, email: row.email, name: row.name, is_admin: row.is_admin },
  };
}

/* ---------- Profiles ---------- */

export const publicProfile = (p) => ({
  id: p.id,
  name: p.name,
  avatar: p.avatar,
  emoji: AVATARS[p.avatar]?.emoji ?? '🙂',
  bg: AVATARS[p.avatar]?.bg ?? AVATARS[0].bg,
  kids: !!p.kids,
  locked: !!p.pin_hash,
});

export const listProfiles = (userId) =>
  all('SELECT * FROM profiles WHERE user_id = ? ORDER BY id', userId);

export const getProfile = (id, userId) =>
  get('SELECT * FROM profiles WHERE id = ? AND user_id = ?', id, userId) ?? null;

function cleanProfileInput(body, { partial }) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 24) throw new HttpError(400, 'Profile name must be 1–24 characters');
    out.name = name;
  }
  if (!partial || body.avatar !== undefined) {
    const a = Number(body.avatar ?? 0);
    if (!Number.isInteger(a) || a < 0 || a >= AVATARS.length) throw new HttpError(400, 'Unknown avatar');
    out.avatar = a;
  }
  if (!partial || body.kids !== undefined) out.kids = body.kids ? 1 : 0;
  if (body.pin !== undefined) {
    if (body.pin === null || body.pin === '') out.pin = null;
    else if (/^\d{4}$/.test(String(body.pin))) out.pin = String(body.pin);
    else throw new HttpError(400, 'PIN must be exactly 4 digits');
  }
  return out;
}

export async function createProfile(userId, body) {
  if (listProfiles(userId).length >= MAX_PROFILES) {
    throw new HttpError(400, `You can have up to ${MAX_PROFILES} profiles`);
  }
  const c = cleanProfileInput(body, { partial: false });
  const pinHash = c.pin ? await hashSecret(c.pin) : null;
  const r = run(
    'INSERT INTO profiles(user_id, name, avatar, kids, pin_hash, created_at) VALUES (?,?,?,?,?,?)',
    userId, c.name, c.avatar, c.kids, pinHash, Date.now(),
  );
  return getProfile(Number(r.lastInsertRowid), userId);
}

export async function updateProfile(userId, id, body) {
  const existing = getProfile(id, userId);
  if (!existing) throw new HttpError(404, 'Profile not found');
  const c = cleanProfileInput(body, { partial: true });
  const next = {
    name: c.name ?? existing.name,
    avatar: c.avatar ?? existing.avatar,
    kids: c.kids ?? existing.kids,
    pin_hash: 'pin' in c ? (c.pin ? await hashSecret(c.pin) : null) : existing.pin_hash,
  };
  run(
    'UPDATE profiles SET name = ?, avatar = ?, kids = ?, pin_hash = ? WHERE id = ? AND user_id = ?',
    next.name, next.avatar, next.kids, next.pin_hash, id, userId,
  );
  return getProfile(id, userId);
}

export function deleteProfile(userId, id) {
  if (!getProfile(id, userId)) throw new HttpError(404, 'Profile not found');
  if (listProfiles(userId).length <= 1) throw new HttpError(400, 'You need at least one profile');
  run('DELETE FROM profiles WHERE id = ? AND user_id = ?', id, userId);
}

export async function selectProfile(session, id, pin) {
  const profile = getProfile(id, session.user.id);
  if (!profile) throw new HttpError(404, 'Profile not found');
  if (profile.pin_hash) {
    const key = `pin:${session.tokenHash}:${id}`;
    if (!rateLimit(key, 5, 5 * 60_000)) throw new HttpError(429, 'Too many PIN attempts. Wait a few minutes.');
    if (!pin || !(await verifySecret(String(pin), profile.pin_hash))) throw new HttpError(401, 'Wrong PIN');
    rateLimitClear(key);
  }
  run('UPDATE sessions SET profile_id = ? WHERE token_hash = ?', id, session.tokenHash);
  return profile;
}

export function leaveProfile(session) {
  run('UPDATE sessions SET profile_id = NULL WHERE token_hash = ?', session.tokenHash);
}
