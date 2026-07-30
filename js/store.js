// Firebase Realtime Database layer.
//
// Data shape:
//   games/{CODE}/
//     meta   : { code, name, createdAt, webhook }
//     players: { [playerId]: { name, discordId, joinedAt, lastSeen } }
//     state  : { lastClaimAt, lastClaim, duel }        <- the contested node
//     claims : { [claimId]: { by, at, rawSeconds, multiplier, seconds, status } }
//     announced: { [eventKey]: true }                  <- webhook dedupe locks
//
//   accounts/{uid}/
//     username: string
//     roster  : { [code]: { synced, playerId } }        <- cross-device game list
//
// Everything that two browsers can race on lives under `state` and is only ever
// written through runTransaction, so the database serialises the conflict for us.

import {
  initializeApp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  push,
  child,
  onValue,
  runTransaction,
  onDisconnect,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
  getAuth,
  signInAnonymously,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeAppCheck,
  ReCaptchaV3Provider,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js";

import { DUEL_TIMEOUT_MS, firebaseConfig, MIN_CLAIM_INTERVAL_MS, RECAPTCHA_SITE_KEY, TIE_WINDOW_MS } from "./config.js";
import { multiplierAt } from "./rules.js";
import {
  applyClaim,
  applyDoubleChoice,
  applyDuelActivity,
  applyDuelTimeout,
  applyReactionClear,
  applySettle,
  applyStartReaction,
  applyThrow,
} from "./engine.js";

let db = null;
let auth = null;
let serverOffset = 0;

/** Connect. Anonymous auth is attempted but not required. */
export async function init() {
  const app = initializeApp(firebaseConfig);

  // Proves requests come from a real load of this site, not just anything
  // that copied the (never-secret) config above. Skipped entirely if no site
  // key is set — see config.js for the console steps to get one.
  if (RECAPTCHA_SITE_KEY) {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(RECAPTCHA_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  }

  db = getDatabase(app);
  auth = getAuth(app);

  try {
    await signInAnonymously(auth);
  } catch (err) {
    // Anonymous auth not enabled — fine as long as the rules don't require it.
    console.info("[store] anonymous auth unavailable, continuing unauthenticated", err.code);
  }

  // Keep a running estimate of the gap between this device's clock and the
  // server's. Every timestamp the game reasons about goes through now().
  onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
    serverOffset = snap.val() || 0;
  });

  return new Promise((resolve) => {
    const connRef = ref(db, ".info/connected");
    const unsub = onValue(connRef, (snap) => {
      if (snap.val() === true) {
        unsub();
        resolve();
      }
    });
    // Don't hang forever if the socket is slow; the UI shows a connection state.
    setTimeout(resolve, 4000);
  });
}

/** Server-aligned wall clock. Use this everywhere instead of Date.now(). */
export const now = () => Date.now() + serverOffset;

export function onConnectionChange(cb) {
  return onValue(ref(db, ".info/connected"), (snap) => cb(snap.val() === true));
}

const gameRef = (code) => ref(db, `games/${code}`);

/**
 * runTransaction, but guaranteed to have seen server data first.
 *
 * Firebase runs a transaction's callback against the LOCAL cache before going
 * to the server, and if that first pass aborts (returns undefined) it
 * short-circuits — the server is never contacted and `committed` comes back
 * false. So any updater that aborts on missing data silently does nothing on a
 * node this client hasn't synced yet.
 *
 * A get() does NOT fix this: it fetches the value but doesn't populate the sync
 * tree the transaction reads. Only an attached listener does.
 *
 * Use this for every updater that can abort. Updaters whose empty branch
 * returns a value instead (see claimAnnouncement) are already correct, because
 * a wrong local pass just loses the race and retries against real data.
 */
async function syncedTransaction(nodeRef, updater) {
  let unsub = null;
  try {
    await new Promise((resolve) => {
      unsub = onValue(nodeRef, () => resolve());
      // Don't hang a click forever on a stalled socket. Proceeding is no worse
      // than the un-synced behaviour this helper exists to prevent.
      setTimeout(resolve, 5000);
    });
    return await runTransaction(nodeRef, updater);
  } finally {
    if (unsub) unsub();
  }
}

// --- Lifecycle --------------------------------------------------------------

export async function gameExists(code) {
  const snap = await get(child(gameRef(code), "meta"));
  return snap.exists();
}

export async function getMeta(code) {
  const snap = await get(child(gameRef(code), "meta"));
  return snap.val();
}

/**
 * @param seed optional imported history, from importer.parseImport:
 *   { players: [{name, seconds}], claims?: [{slot, at, seconds, ...}] }
 *   Slot 0 is the creator. Slot 1 has no player id yet, so its history is
 *   parked in meta.pendingSeeds and applied when the second player joins.
 */
export async function createGame({ code, name, webhook, endsAt, player, seed }) {
  const t = now();

  const payload = {
    meta: {
      code,
      name: name || "Clicky",
      createdAt: serverTimestamp(),
      endsAt,
      webhook: webhook || "",
    },
    players: {
      [player.id]: {
        name: player.name,
        discordId: player.discordId || "",
        joinedAt: serverTimestamp(),
      },
    },
    // The clock starts ticking the moment the game is created. `endsAt` is
    // mirrored here so the claim transaction can enforce it without a second read.
    state: { lastClaimAt: t, lastClaim: null, duel: null, endsAt },
  };

  if (seed) {
    const mine = seedClaimsFor(seed, 0, t);
    if (mine.length) {
      payload.claims = {};
      mine.forEach((c, i) => {
        payload.claims[`seed_a_${i}`] = { ...c, by: player.id };
      });
    }
    const theirs = seedClaimsFor(seed, 1, t);
    if (theirs.length) {
      payload.meta.pendingSeeds = [
        { name: seed.players?.[1]?.name || "Player 2", claims: theirs },
      ];
    }
    // Imported history ends at its last click, so the clock should have been
    // running since then rather than restarting at creation.
    const lastAt = Math.max(
      t,
      ...[...mine, ...theirs].map((c) => c.at).filter((n) => Number.isFinite(n))
    );
    if (Number.isFinite(lastAt)) payload.state.lastClaimAt = Math.min(lastAt, t);
  }

  await set(gameRef(code), payload);
}

/** Turn imported data into claim records for one slot. */
function seedClaimsFor(seed, slot, atFallback) {
  if (Array.isArray(seed.claims) && seed.claims.length) {
    return seed.claims
      .filter((c) => c.slot === slot)
      .map((c) => ({
        at: c.at,
        seconds: c.seconds,
        rawSeconds: c.rawSeconds ?? c.seconds,
        multiplier: c.multiplier ?? 1,
        status: "settled",
        imported: true,
        ...(c.viaDuel ? { viaDuel: c.viaDuel } : {}),
      }));
  }
  // Totals-only import collapses to a single opening claim.
  const p = seed.players?.[slot];
  if (!p || !(p.seconds > 0)) return [];
  return [
    {
      at: atFallback,
      seconds: p.seconds,
      rawSeconds: p.seconds,
      multiplier: 1,
      status: "settled",
      imported: true,
    },
  ];
}

/**
 * Join a game, returning the player id this device should use for it.
 *
 * If someone with this name is already in the game, their id is adopted rather
 * than a new seat taken — that's what lets one person play from a phone and a
 * laptop at once. Both devices then share a total, a cooldown, and a side in any
 * duel. The id is per game, not global, so joining an unrelated game where a
 * stranger happens to share your name can't hijack your identity elsewhere.
 */
export async function joinGame({ code, player }) {
  const playersSnap = await get(child(gameRef(code), "players"));
  const players = playersSnap.val() || {};

  const want = String(player.name || "").trim().toLowerCase();
  const sameName = Object.keys(players).find(
    (id) => String(players[id]?.name || "").trim().toLowerCase() === want
  );
  const playerId = sameName || player.id;
  const isNew = !players[playerId];

  if (isNew && Object.keys(players).length >= 2) {
    throw new Error("This game already has two players.");
  }

  await update(child(gameRef(code), `players/${playerId}`), {
    name: player.name,
    discordId: player.discordId || "",
    joinedAt: players[playerId]?.joinedAt ?? serverTimestamp(),
  });

  if (isNew) await applyPendingSeed(code, playerId, player.name);
  return playerId;
}

/**
 * Hand a joining player the history that was imported for them.
 *
 * Seats are matched by name where possible, so it doesn't matter which of the
 * two players enters the code first. A transaction removes the seat as it is
 * taken, so two joiners can never collect the same history.
 */
async function applyPendingSeed(code, playerId, playerName) {
  const seedsRef = child(gameRef(code), "meta/pendingSeeds");

  // Claim a one-shot lock for this player before touching the seeds.
  //
  // joinGame can fire more than once for the same player (a double submit, a
  // retry). Without this, the second pass would find no name match, fall back to
  // the first remaining seat, and hand this player their OPPONENT's history.
  //
  // This transaction is safe on a cold cache precisely because its empty branch
  // returns a value rather than aborting: if the local pass wrongly sees null it
  // writes `true`, the server rejects the stale write, and the retry sees the
  // real `true` and aborts.
  const lock = await runTransaction(
    child(gameRef(code), `meta/seeded/${playerId}`),
    (v) => (v ? undefined : true)
  );
  if (!lock.committed) return; // already seeded, or another pass is doing it

  let captured = null;

  const res = await syncedTransaction(seedsRef, (seeds) => {
    if (!Array.isArray(seeds) || !seeds.length) return; // nothing parked — abort

    const want = String(playerName || "").trim().toLowerCase();
    let i = seeds.findIndex((s) => String(s?.name || "").trim().toLowerCase() === want);
    if (i < 0) i = 0; // no name match — take the next free seat

    captured = seeds[i];
    const rest = seeds.filter((_, n) => n !== i);
    return rest.length ? rest : null;
  });

  if (!res.committed || !captured) return;

  // Key by playerId, not by the seed's index. `index` is a position within the
  // *remaining* seeds, so once the first player has been consumed the second one
  // is also index 0 — and would overwrite the first player's claims wholesale.
  const updates = {};
  (captured.claims || []).forEach((c, i) => {
    updates[`claims/seed_${playerId}_${i}`] = { ...c, by: playerId };
  });
  if (Object.keys(updates).length) await update(gameRef(code), updates);
}

/** Presence: mark this player online, and clear it automatically on disconnect. */
export function trackPresence(code, playerId) {
  const r = child(gameRef(code), `presence/${playerId}`);
  onDisconnect(r).set(null);
  set(r, { online: true, at: serverTimestamp() });
}

export async function setWebhook(code, webhook) {
  await update(child(gameRef(code), "meta"), { webhook: webhook || "" });
}

export async function updatePlayer(code, playerId, fields) {
  await update(child(gameRef(code), `players/${playerId}`), fields);
}

// --- Subscriptions ----------------------------------------------------------

export function watchGame(code, cb) {
  const unsubs = [
    onValue(child(gameRef(code), "meta"), (s) => cb({ meta: s.val() })),
    onValue(child(gameRef(code), "players"), (s) => cb({ players: s.val() || {} })),
    onValue(child(gameRef(code), "presence"), (s) => cb({ presence: s.val() || {} })),
    onValue(child(gameRef(code), "state"), (s) => cb({ state: s.val() || {} })),
    onValue(child(gameRef(code), "claims"), (s) => {
      const raw = s.val() || {};
      const claims = Object.entries(raw)
        .map(([id, c]) => ({ id, ...c }))
        .sort((a, b) => a.at - b.at);
      cb({ claims });
    }),
  ];
  return () => unsubs.forEach((u) => u());
}

// --- Claiming ---------------------------------------------------------------

/**
 * The core action.
 *
 * Runs a transaction against `state`. Two outcomes:
 *   - "claim" : normal, time is banked to this player.
 *   - "duel"  : another player claimed under TIE_WINDOW_MS ago, so their claim
 *               plus the sliver since goes into escrow and RPS decides it.
 *
 * Both ids are generated up front so the transaction body stays pure (it can be
 * retried any number of times) and we can identify our own result afterwards.
 */
export async function claim(code, playerId) {
  const claimId = push(child(gameRef(code), "claims")).key;
  const duelId = push(child(gameRef(code), "claims")).key;
  const at = now();
  const multiplier = multiplierAt(code, at);

  const result = await syncedTransaction(child(gameRef(code), "state"), (state) =>
    applyClaim(state, {
      playerId,
      at,
      multiplier,
      claimId,
      duelId,
      tieWindowMs: TIE_WINDOW_MS,
      minIntervalMs: MIN_CLAIM_INTERVAL_MS,
    })
  );

  if (!result.committed) return { outcome: "blocked" };
  const committed = result.snapshot.val() || {};

  // Did *we* win the race?
  if (committed.duel?.id === duelId) {
    // Deliberately no write to the disputed claim here. The other player's
    // `set(claims/{id})` may still be in flight, and two writers on one record
    // race. It stays 'settled' in the database and is excluded from totals by
    // the reader (it's named in state.duel.disputedClaimId), then voided once —
    // by the settler — when the duel resolves.
    return { outcome: "duel", duel: committed.duel };
  }

  if (committed.lastClaim?.id === claimId) {
    const c = committed.lastClaim;
    await set(child(gameRef(code), `claims/${claimId}`), {
      by: c.by,
      at: c.at,
      rawSeconds: c.rawSeconds,
      multiplier: c.multiplier,
      seconds: c.seconds,
      status: "settled",
    });
    return { outcome: "claim", claim: { id: claimId, ...c } };
  }

  // Someone else's write landed on top of ours between commit and read.
  return { outcome: "superseded" };
}

// --- Duels ------------------------------------------------------------------

export async function submitThrow(code, duelId, playerId, choice, path) {
  await syncedTransaction(child(gameRef(code), "state/duel"), (duel) =>
    applyThrow(duel, { duelId, playerId, choice, path })
  );
}

/** Void the disputed claim and write the settlement, honoring a coin's double-or-nothing multiplier. */
async function creditDuelWin(code, duel, settleClaimId, at) {
  const mult = duel.payoutMultiplier || 1;
  await update(gameRef(code), {
    [`claims/${duel.disputedClaimId}/status`]: "void",
    [`claims/${settleClaimId}`]: {
      by: duel.winner,
      at,
      rawSeconds: duel.potRawSeconds * mult,
      multiplier: 1, // the 2x was already applied when the pot was formed
      seconds: duel.potSeconds * mult,
      status: "settled",
      viaDuel: duel.id,
      game: duel.game || null, // which minigame decided it, for the profile's minigame record
      ties: (duel.round || 1) - 1, // redraws before it was decided (round starts at 1)
    },
  });
}

/**
 * Called by every client whenever the duel node changes. Both players race to
 * settle; the transaction guarantees exactly one of them does the writing.
 *
 * @returns null, {draw:true, duel}, {awaitingDouble:true, duel} — a coin duel
 *          landed on its winner's double-or-nothing choice, nothing to credit
 *          yet — or {draw:false, duel} for the single client that actually
 *          performed the settlement.
 */
export async function trySettleDuel(code, duelId) {
  const settleClaimId = push(child(gameRef(code), "claims")).key;
  const at = now();

  const result = await syncedTransaction(child(gameRef(code), "state/duel"), (duel) =>
    applySettle(duel, { at, settleClaimId, duelId })
  );

  if (!result.committed) return null;
  const duel = result.snapshot.val();
  if (!duel) return null;

  // A draw: report it, but only from the client that actually bumped the round.
  // (Firebase strips null keys, so cleared picks come back as undefined.)
  if (duel.status === "open") {
    if (duel.lastDraw && !duel.picks) return { draw: true, duel };
    return null;
  }

  if (duel.status === "double_offer") return { awaitingDouble: true, duel };

  // Resolved — but was it us who resolved it?
  if (duel.settleClaimId !== settleClaimId) return null;

  await creditDuelWin(code, duel, settleClaimId, at);
  return { draw: false, duel };
}

/**
 * The coin winner has decided: bank the pot now, or risk it on one more flip
 * for double. Same single-writer guarantee as trySettleDuel.
 *
 * @returns null, or {duel} for the client whose choice actually landed.
 */
export async function submitDoubleChoice(code, duelId, playerId, choice) {
  const settleClaimId = push(child(gameRef(code), "claims")).key;
  const at = now();

  const result = await syncedTransaction(child(gameRef(code), "state/duel"), (duel) =>
    applyDoubleChoice(duel, { duelId, playerId, choice, at, settleClaimId })
  );

  if (!result.committed) return null;
  const duel = result.snapshot.val();
  if (!duel || duel.status !== "resolved" || duel.settleClaimId !== settleClaimId) return null;

  await creditDuelWin(code, duel, settleClaimId, at);
  return { duel };
}

/**
 * A player's client reports whether *they* are currently free to start a
 * reaction round (no other open duel of theirs elsewhere), then — if that
 * makes both sides clear — starts the round's clock. Only the reporting
 * player's own client can know its half of this, since it's derived from
 * games only that browser has loaded; the other half was already reported
 * (or not) by the opponent's own client the same way.
 *
 * @returns the committed duel (whether or not it actually started), or null.
 */
export async function checkReactionStart(code, duelId, playerId, iAmClear) {
  const clearResult = await syncedTransaction(child(gameRef(code), "state/duel"), (duel) =>
    applyReactionClear(duel, { duelId, playerId, clear: iAmClear })
  );
  if (!clearResult.committed) return null;

  const startResult = await syncedTransaction(child(gameRef(code), "state/duel"), (duel) =>
    applyStartReaction(duel, { duelId, at: now() })
  );
  const duel = (startResult.committed ? startResult.snapshot.val() : clearResult.snapshot.val()) || null;
  return duel;
}

/** A player interacted with the duel UI — pushes the 2-min timeout back out to a full window. */
export async function pingDuelActivity(code, duelId) {
  await syncedTransaction(child(gameRef(code), "state/duel"), (duel) =>
    applyDuelActivity(duel, { duelId, at: now() })
  );
}

/**
 * Called periodically (see app.js's tick loop) for any game with an open duel
 * or double_offer. Runs against the whole `state` node, not just `state/duel`,
 * because the neither-responded case has to rewind `lastClaimAt` too.
 *
 * @returns null, {voided: true} — the disputed claim was voided and the clock
 *          rewound, nobody credited — or {timedOut: true, duel} for the
 *          client whose timeout write actually landed.
 */
export async function checkDuelTimeout(code, duelId) {
  const settleClaimId = push(child(gameRef(code), "claims")).key;
  const at = now();

  const result = await syncedTransaction(child(gameRef(code), "state"), (state) =>
    applyDuelTimeout(state, { duelId, at, settleClaimId, timeoutMs: DUEL_TIMEOUT_MS })
  );

  if (!result.committed) return null;
  const committed = result.snapshot.val() || {};

  if (committed.voidedClaimId) {
    const voidedId = committed.voidedClaimId;
    await update(gameRef(code), {
      [`claims/${voidedId}/status`]: "void",
      "state/voidedClaimId": null,
    });
    return { voided: true };
  }

  const duel = committed.duel;
  if (!duel || duel.status !== "resolved" || duel.settleClaimId !== settleClaimId) return null;

  await creditDuelWin(code, duel, settleClaimId, at);
  return { timedOut: true, duel };
}

// --- Webhook dedupe ---------------------------------------------------------

/**
 * Both browsers observe the same events (a 2x window opening, a duel starting),
 * but Discord should only hear about it once. First client to claim the lock for
 * an event key is the one that sends.
 */
export async function claimAnnouncement(code, eventKey) {
  const safeKey = eventKey.replace(/[.#$/[\]]/g, "_");
  const result = await runTransaction(child(gameRef(code), `announced/${safeKey}`), (val) =>
    val ? undefined : now()
  );
  return result.committed && result.snapshot.exists();
}

// --- Accounts -----------------------------------------------------------
//
// A username + password is really just Firebase email/password auth wearing
// a costume: there's no real email involved, so the username is turned into
// a synthetic address under a fake domain. Firebase's own uniqueness check on
// that address is what makes usernames unique — no separate lookup needed.
// Everything under accounts/{uid} is only readable/writable by that uid (see
// the security rules), so it's safe to key by uid directly.

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const toAuthEmail = (username) => `${username}@clicky.invalid`;

export function normalizeUsername(raw) {
  return String(raw || "").trim().toLowerCase();
}

export function isValidUsername(username) {
  return USERNAME_RE.test(username);
}

/** Friendlier text for the handful of auth errors a login form actually hits. */
export function authErrorMessage(err) {
  switch (err?.code) {
    case "auth/email-already-in-use":
      return "That username is taken.";
    case "auth/weak-password":
      return "Password needs to be at least 6 characters.";
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-credential":
      return "Wrong username or password.";
    case "auth/too-many-requests":
      return "Too many attempts — wait a bit and try again.";
    default:
      return err?.message || "Something went wrong.";
  }
}

export async function signUp(username, password) {
  const uname = normalizeUsername(username);
  if (!isValidUsername(uname)) {
    throw new Error("Usernames are 3-20 characters: lowercase letters, numbers, underscore.");
  }
  const cred = await createUserWithEmailAndPassword(auth, toAuthEmail(uname), password);
  await updateProfile(cred.user, { displayName: uname });
  await set(ref(db, `accounts/${cred.user.uid}/username`), uname);
  return { uid: cred.user.uid, username: uname };
}

export async function signIn(username, password) {
  const uname = normalizeUsername(username);
  const cred = await signInWithEmailAndPassword(auth, toAuthEmail(uname), password);
  return { uid: cred.user.uid, username: cred.user.displayName || uname };
}

export async function signOutUser() {
  await signOut(auth);
}

const accountRef = (uid) => ref(db, `accounts/${uid}`);

/** @param cb({uid, username} | null) — fires immediately with the current state, then on every change. */
export function onAuthChange(cb) {
  return onAuthStateChanged(auth, async (user) => {
    // Anonymous sessions (from init()) don't count as "logged in" for account
    // purposes — only a real username/password sign-in does.
    if (!user || user.isAnonymous) {
      cb(null);
      return;
    }
    // Read the username back from the record signUp wrote, rather than
    // trusting auth's displayName — updateProfile() doesn't reliably re-fire
    // this listener, so displayName can still be empty on the very first
    // event right after signing up.
    const snap = await get(child(accountRef(user.uid), "username"));
    cb({ uid: user.uid, username: snap.val() || user.displayName || "" });
  });
}

/** The account's cross-device roster: { [code]: { synced, playerId } }. */
export async function getAccountRoster(uid) {
  const snap = await get(child(accountRef(uid), "roster"));
  return snap.val() || {};
}

export function setAccountRoster(uid, rosterObj) {
  return set(child(accountRef(uid), "roster"), rosterObj);
}

export function watchAccountRoster(uid, cb) {
  return onValue(child(accountRef(uid), "roster"), (snap) => cb(snap.val() || {}));
}
