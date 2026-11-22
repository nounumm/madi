// 로그인과 동기화 (Firebase). 연습 기록과 악보 PDF를 본인 계정에만 올린다 (보안 규칙으로 본인만 읽고 쓴다).
// 서버 구조: users/{uid}/practice/{기록 키} = { title, by: { 기기ID: { counts, seconds, days, updated } } }
// 기기마다 자기 칸에만 쓰므로 두 기기가 따로 오프라인으로 쳐도 서로 덮어쓰지 않는다. 보여 줄 때 합친다.
import { initializeApp } from './vendor/firebase-app.js';
import { initializeAuth, indexedDBLocalPersistence, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, sendPasswordResetEmail } from './vendor/firebase-auth.js';
import { getFirestore, doc, setDoc, getDoc, getDocs, deleteDoc, collection, Bytes } from './vendor/firebase-firestore-lite.js';

const app = initializeApp({
  apiKey: 'AIzaSyAhMyFyJCnNT6QXm4KYR3xYf0gyLBI9bd4',
  authDomain: 'han-madi.firebaseapp.com',
  projectId: 'han-madi',
  storageBucket: 'han-madi.firebasestorage.app',
  messagingSenderId: '84323195394',
  appId: '1:84323195394:web:6e146b617cefe78c08a51b'
});
// 로그인 정보는 기기에 남겨서 껐다 켜도, 인터넷이 없어도 로그인된 채로 연다
const auth = initializeAuth(app, { persistence: indexedDBLocalPersistence });
const db = getFirestore(app);

export const onUser = cb => onAuthStateChanged(auth, cb);
export const currentUser = () => auth.currentUser;
export const signIn = (email, pw) => signInWithEmailAndPassword(auth, email, pw);
export const signUp = (email, pw) => createUserWithEmailAndPassword(auth, email, pw);
export const logOut = () => signOut(auth);
export const resetPassword = email => sendPasswordResetEmail(auth, email);

// 이 기기의 기록 여러 개를 올린다
export async function push(uid, device, recs) {
  for (const p of recs) {
    await setDoc(doc(db, 'users', uid, 'practice', p.key), {
      title: p.title || '',
      by: { [device]: { counts: p.counts || {}, seconds: p.seconds || 0, days: p.days || {}, updated: p.updated || Date.now() } }
    }, { merge: true });
  }
}

// 서버의 모든 기록. [{ key, title, by }]
export async function pull(uid) {
  const snap = await getDocs(collection(db, 'users', uid, 'practice'));
  return snap.docs.map(d => ({ key: d.id, title: d.data().title, by: d.data().by || {} }));
}

// ---------- 악보 ----------
// users/{uid}/scores/{PDF 해시} = { title, bpm, order, click, countin, added, updated, chunks, size, deleted, deletedAt }
// PDF 본문은 문서 하나에 1MB까지만 들어가서 조각으로 나눠 users/{uid}/scores/{해시}/chunks/{0,1,…}에 둔다
const CHUNK = 900000;
const scoreDoc = (uid, key) => doc(db, 'users', uid, 'scores', key);
const chunkCol = (uid, key) => collection(db, 'users', uid, 'scores', key, 'chunks');

export async function listScores(uid) {
  const snap = await getDocs(collection(db, 'users', uid, 'scores'));
  return snap.docs.map(d => ({ key: d.id, ...d.data() }));
}
export async function uploadScore(uid, key, buf, meta) {
  const u8 = new Uint8Array(buf), n = Math.max(1, Math.ceil(u8.length / CHUNK));
  for (let i = 0; i < n; i++)
    await setDoc(doc(chunkCol(uid, key), String(i)), { data: Bytes.fromUint8Array(u8.subarray(i * CHUNK, (i + 1) * CHUNK)) });
  // 조각을 다 올린 뒤에 목록에 올린다. 도중에 끊기면 다른 기기는 이 곡을 아직 모른다
  await setDoc(scoreDoc(uid, key), { ...meta, chunks: n, size: u8.length, deleted: false, deletedAt: 0 });
}
export const putScoreMeta = (uid, key, meta) => setDoc(scoreDoc(uid, key), meta, { merge: true });
export async function downloadScore(uid, key, n) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    const d = await getDoc(doc(chunkCol(uid, key), String(i)));
    if (!d.exists()) throw new Error('악보 조각이 없습니다');
    parts.push(d.data().data.toUint8Array());
  }
  const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}
// 지운 곡은 표시만 남기고(다른 기기도 지우도록) PDF 조각은 지운다
export async function deleteScore(uid, key) {
  await setDoc(scoreDoc(uid, key), { deleted: true, deletedAt: Date.now() }, { merge: true });
  for (const d of (await getDocs(chunkCol(uid, key))).docs) await deleteDoc(d.ref);
}

const MESSAGES = {
  'auth/invalid-email': '이메일 형식이 맞지 않습니다.',
  'auth/missing-password': '비밀번호를 입력해 주세요.',
  'auth/weak-password': '비밀번호는 6자 이상이어야 합니다.',
  'auth/email-already-in-use': '이미 가입된 이메일입니다. 로그인해 주세요.',
  'auth/invalid-credential': '이메일이나 비밀번호가 맞지 않습니다.',
  'auth/wrong-password': '이메일이나 비밀번호가 맞지 않습니다.',
  'auth/user-not-found': '이메일이나 비밀번호가 맞지 않습니다.',
  'auth/too-many-requests': '시도가 너무 많습니다. 잠시 뒤 다시 해 주세요.',
  'auth/network-request-failed': '인터넷에 연결되지 않았습니다. 처음 로그인은 인터넷이 필요합니다.',
  'auth/operation-not-allowed': 'Firebase에서 이메일/비밀번호 로그인이 꺼져 있습니다.',
  'auth/configuration-not-found': 'Firebase Authentication이 아직 시작되지 않았습니다.'
};
export const errorText = e => MESSAGES[e && e.code] || `잠시 뒤 다시 해 주세요. (${(e && e.code) || e})`;
