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
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import { firebaseConfig, TIE_WINDOW_MS } from "./config.js";
import { multiplierAt } from "./rules.js";
import { applyClaim, applySettle, applyThrow } from "./engine.js";

let db = null;
let serverOffset = 0;

/** Connect. Anonymous auth is attempted but not required. */
export async function init() {
  const app = initializeApp(firebaseConfig);
  db = getDatabase(app);

  try {
    await signInAnonymously(getAuth(app));
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

// --- Lifecycle --------------------------------------------------------------

export async function gameExists(code) {
  const snap = await get(child(gameRef(code), "meta"));
  return snap.exists();
}

export async function getMeta(code) {
  const snap = await get(child(gameRef(code), "meta"));
  return snap.val();
}

export async function createGame({ code, name, webhook, endsAt, player }) {
  const t = now();
  await set(gameRef(code), {
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
  });
}

export async function joinGame({ code, player }) {
  const playersSnap = await get(child(gameRef(code), "players"));
  const players = playersSnap.val() || {};

  if (!players[player.id] && Object.keys(players).length >= 2) {
    throw new Error("This game already has two players.");
  }

  await update(child(gameRef(code), `players/${player.id}`), {
    name: player.name,
    discordId: player.discordId || "",
    joinedAt: players[player.id]?.joinedAt ?? serverTimestamp(),
  });
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

  const result = await runTransaction(child(gameRef(code), "state"), (state) =>
    applyClaim(state, {
      playerId,
      at,
      multiplier,
      claimId,
      duelId,
      tieWindowMs: TIE_WINDOW_MS,
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

export async function submitThrow(code, duelId, playerId, choice) {
  await runTransaction(child(gameRef(code), "state/duel"), (duel) =>
    applyThrow(duel, { duelId, playerId, choice })
  );
}

/**
 * Called by every client whenever the duel node changes. Both players race to
 * settle; the transaction guarantees exactly one of them does the writing.
 *
 * @returns null, or {draw:true} / {winner, loser, throws, potSeconds} for the
 *          single client that actually performed the settlement.
 */
export async function trySettleDuel(code, duelId) {
  const settleClaimId = push(child(gameRef(code), "claims")).key;
  const at = now();

  const result = await runTransaction(child(gameRef(code), "state/duel"), (duel) =>
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

  // Resolved — but was it us who resolved it?
  if (duel.settleClaimId !== settleClaimId) return null;

  await update(gameRef(code), {
    [`claims/${duel.disputedClaimId}/status`]: "void",
    [`claims/${settleClaimId}`]: {
      by: duel.winner,
      at,
      rawSeconds: duel.potRawSeconds,
      multiplier: 1, // the 2x was already applied when the pot was formed
      seconds: duel.potSeconds,
      status: "settled",
      viaDuel: duel.id,
    },
  });

  return { draw: false, duel };
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
