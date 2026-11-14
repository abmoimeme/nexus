// In-memory stand-in for the Firebase SDK facade (firebase/sdk.js), for tests only.
export const db = new Map();           // 'users/u1/profiles/p1' -> data
export const users = new Map();        // email -> { uid, password, displayName }
let uid = 0;
const fail = (code) => Object.assign(new Error(code), { code });
const A = { currentUser: null, authStateReady: async () => {} };
export const resetFake = () => { db.clear(); users.clear(); A.currentUser = null; };

export const initializeApp = (cfg) => ({ cfg });
export const getAuth = () => A;
export const getFirestore = () => ({ db });
const mk = (email, u) => ({ uid: u.uid, email, get displayName() { return u.displayName; }, _u: u });
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
export const updateDoc = async (ref, patch) => { if (!db.has(ref.path)) throw fail('not-found'); db.set(ref.path, { ...db.get(ref.path), ...patch }); };
export const deleteDoc = async (ref) => { db.delete(ref.path); };
export const writeBatch = () => { const ops = []; return { delete: (r) => ops.push(r.path), commit: async () => ops.forEach((p) => db.delete(p)) }; };
