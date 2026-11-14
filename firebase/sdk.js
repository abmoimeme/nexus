// The only place the Firebase SDK is imported. Tests swap this file for an in-memory fake (see scripts/build-firebase.mjs).
export { initializeApp } from 'firebase/app';
export {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, sendPasswordResetEmail,
  updateProfile, reauthenticateWithCredential, EmailAuthProvider, updatePassword,
} from 'firebase/auth';
export { getFirestore, doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch } from 'firebase/firestore';
