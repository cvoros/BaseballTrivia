// Storage adapters. LocalStore keeps a hot-seat game in localStorage.
// OnlineStore syncs game state through Cloud Firestore (loaded lazily from
// the CDN only when online play is actually used).

import { firebaseConfig } from './firebase-config.js';

const LOCAL_KEY = 'bt_local_game';

export const LocalStore = {
  save(game) {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(game));
  },
  load() {
    try {
      return JSON.parse(localStorage.getItem(LOCAL_KEY));
    } catch {
      return null;
    }
  },
  clear() {
    localStorage.removeItem(LOCAL_KEY);
  },
};

export const onlineEnabled = !!firebaseConfig;

let fb = null; // { db, fns } once initialized

async function getDb() {
  if (fb) return fb;
  const [appMod, fsMod] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  const db = fsMod.getFirestore(app);
  fb = { db, fs: fsMod };
  return fb;
}

export function newGameCode() {
  // 6 chars, no ambiguous 0/O/1/I
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Per-browser identity for a given game code. sessionStorage wins so two
// tabs in the same browser can play each other (handy for testing);
// localStorage is the durable fallback across restarts.
export function myIdentity(code) {
  try {
    const s = sessionStorage.getItem(`bt_id_${code}`);
    if (s) return JSON.parse(s);
    return JSON.parse(localStorage.getItem(`bt_id_${code}`));
  } catch {
    return null;
  }
}

export function saveIdentity(code, playerIdx) {
  const val = JSON.stringify({ playerIdx });
  sessionStorage.setItem(`bt_id_${code}`, val);
  localStorage.setItem(`bt_id_${code}`, val);
}

export function forgetIdentity(code) {
  sessionStorage.removeItem(`bt_id_${code}`);
  localStorage.removeItem(`bt_id_${code}`);
}

// Registry of games this device has been part of, for the home-page list.
export function rememberGame(code, game) {
  try {
    const all = JSON.parse(localStorage.getItem('bt_games') || '{}');
    all[code] = {
      names: game.players.map(p => p.name),
      status: game.status,
      updated: Date.now(),
    };
    localStorage.setItem('bt_games', JSON.stringify(all));
  } catch { /* storage full/blocked: the list is a convenience only */ }
}

export function knownGames() {
  try {
    const all = JSON.parse(localStorage.getItem('bt_games') || '{}');
    return Object.entries(all)
      .map(([code, v]) => ({ code, ...v }))
      .sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

export const OnlineStore = {
  async create(code, game) {
    const { db, fs } = await getDb();
    await fs.setDoc(fs.doc(db, 'games', code), game);
  },

  async load(code) {
    const { db, fs } = await getDb();
    const snap = await fs.getDoc(fs.doc(db, 'games', code));
    return snap.exists() ? snap.data() : null;
  },

  async save(code, game) {
    const { db, fs } = await getDb();
    await fs.setDoc(fs.doc(db, 'games', code), game);
  },

  // Claim the second player slot. Returns the updated game, or throws if full.
  async join(code, name) {
    const { db, fs } = await getDb();
    const ref = fs.doc(db, 'games', code);
    return fs.runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('No game found with that code.');
      const game = snap.data();
      if (game.players[1].name) throw new Error('That game already has two players.');
      game.players[1].name = name;
      game.status = 'active';
      tx.set(ref, game);
      return game;
    });
  },

  async subscribe(code, cb) {
    const { db, fs } = await getDb();
    return fs.onSnapshot(fs.doc(db, 'games', code), snap => {
      if (snap.exists()) cb(snap.data());
    });
  },
};
