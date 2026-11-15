// In-memory stand-in for the Firebase SDK facade (firebase/sdk.js), for tests only.
export const db = new Map();           // 'users/u1/profiles/p1' -> data
export const users = new Map();        // email -> { uid, password, displayName }
let uid = 0;
const fail = (code) => Object.assign(new Error(code), { code });
const A = { currentUser: null, authStateReady: async () => {} };
export const resetFake = () => { fakeDeleted.length = 0; db.clear(); users.clear(); A.currentUser = null; };

export const initializeApp = (cfg) => ({ cfg });
export const getAuth = () => A;
export const getFirestore = () => ({ db });
const mk = (email, u) => ({ uid: u.uid, email, get displayName() { return u.displayName; }, _u: u,
  delete: async () => { users.delete(email); if (A.currentUser?.uid === u.uid) A.currentUser = null; fakeDeleted.push(email); } });
export const fakeDeleted = [];
export async function createUserWithEmailAndPassword(_a, email, password) {
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw fail('auth/invalid-email');
  if (password.length < 6) throw fail('auth/weak-password');
  if (users.has(email)) throw fail('auth/email-already-in-use');
  const u = { uid: `u${++uid}`, password, displayName: null }; users.set(email, u);
  A.currentUser = mk(email, u); return { user: A.currentUser };
}
export async function signInWithEmailAndPassword(_a, email, password) {
  const u = users.get(email); if (!u || u.password !== password) throw fail('auth/invalid-credential');
  A.currentUser = mk(email, u); return { user: A.currentUser };
}
export const signOut = async () => { A.currentUser = null; };
export const sendPasswordResetEmail = async (_a, email) => { if (!/@/.test(email)) throw fail('auth/invalid-email'); sendPasswordResetEmail.sent.push(email); };
sendPasswordResetEmail.sent = [];
export const updateProfile = async (user, { displayName }) => { user._u.displayName = displayName; };
export const EmailAuthProvider = { credential: (email, password) => ({ email, password }) };
export const reauthenticateWithCredential = async (user, cred) => { if (users.get(cred.email)?.password !== cred.password) throw fail('auth/wrong-password'); };
export const updatePassword = async (user, pw) => { user._u.password = pw; };

const join = (segs) => segs.join('/');
export const doc = (_db, ...segs) => ({ path: join(segs), id: segs[segs.length - 1] });
export const collection = (_db, ...segs) => ({ path: join(segs), col: true });
const snap = (path, data) => ({ id: path.split('/').pop(), ref: { path }, exists: () => data !== undefined, data: () => (data === undefined ? undefined : structuredClone(data)) });
export const getDoc = async (ref) => snap(ref.path, db.get(ref.path));
export const getDocs = async (c) => {
  const depth = c.path.split('/').length + 1;
  return { docs: [...db.keys()].filter((k) => k.startsWith(`${c.path}/`) && k.split('/').length === depth).map((k) => snap(k, db.get(k))) };
};
export const setDoc = async (ref, data) => { db.set(ref.path, structuredClone(data)); };
export const increment = (n) => ({ __inc: n });
const applyPatch = (old, patch) => { const out = { ...old }; for (const [k, v] of Object.entries(patch)) out[k] = v && v.__inc !== undefined ? (out[k] || 0) + v.__inc : v; return out; };
export const updateDoc = async (ref, patch) => { if (!db.has(ref.path)) throw fail('not-found'); db.set(ref.path, applyPatch(db.get(ref.path), patch)); };
export const deleteDoc = async (ref) => { db.delete(ref.path); };
// Mirrors firestore.rules for the one thing that matters here: a users/{uid} document can only be created together with
// claiming a valid invite (exists, uses < maxUses, email matches when bound, uses goes up by exactly one).
export const writeBatch = () => {
  const ops = [];
  return {
    delete: (r) => ops.push({ t: 'del', p: r.path }),
    set: (r, d) => ops.push({ t: 'set', p: r.path, d }),
    update: (r, d) => ops.push({ t: 'upd', p: r.path, d }),
    commit: async () => {
      for (const o of ops) {
        if (o.t === 'set' && /^users\/[^/]+$/.test(o.p) && o.d.invite !== undefined) {
          const inv = db.get(`invites/${o.d.invite}`); const claim = ops.find((x) => x.t === 'upd' && x.p === `invites/${o.d.invite}`);
          const email = A.currentUser?.email?.toLowerCase();
          const ok = inv && claim && inv.uses < inv.maxUses && claim.d.uses?.__inc === 1 && (!inv.email || inv.email.toLowerCase() === email) && o.d.email.toLowerCase() === email;
          if (!ok) throw fail('permission-denied');
        }
      }
      for (const o of ops) {
        if (o.t === 'del') db.delete(o.p); else if (o.t === 'set') db.set(o.p, structuredClone(o.d)); else db.set(o.p, applyPatch(db.get(o.p) || {}, o.d));
      }
    },
  };
};
