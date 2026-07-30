// In-memory stand-in for store.js, used by dev/index.html (demo mode).
//
// Same exported interface, same engine, no network. It also runs a simple bot
// opponent so the duel flow can be exercised solo. Nothing here ships to the
// real game — the import map in dev/index.html swaps it in.

import { DUEL_TIMEOUT_MS, TIE_WINDOW_MS } from "../js/config.js";
import { multiplierAt } from "../js/rules.js";
import {
  applyClaim,
  applyDoubleChoice,
  applyDuelActivity,
  applyDuelTimeout,
  applyReactionClear,
  applySettle,
  applyStartReaction,
  applyThrow,
  getForcedGame,
} from "../js/engine.js";

const BOT = "bot_opponent";
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));

const world = new Map(); // code -> { meta, players, presence, state, claims, announced, subs }
let uid = 0;
const nextId = (p) => `${p}_${Date.now().toString(36)}_${++uid}`;

export const now = () => Date.now();

export async function init() {
  console.info("[demo] running with the in-memory mock store — no Firebase involved");
  installDemoChrome();
}

/**
 * The demo banner and bot trigger. Built here rather than in the page so that
 * index.html and css/styles.css carry no demo-only markup or styling.
 */
function installDemoChrome() {
  if (document.getElementById("demo-flag")) return;

  const style = document.createElement("style");
  style.textContent = `
    #demo-flag { position: fixed; left: 0; right: 0; bottom: 0; z-index: 70;
      display: flex; gap: 10px; align-items: center; justify-content: center;
      padding: 8px; font: 12px system-ui, sans-serif; text-align: center;
      background: rgba(255,201,77,.14); border-top: 1px solid rgba(255,201,77,.4);
      color: #ffc94d; }
    #demo-flag button { font: 11px system-ui, sans-serif; cursor: pointer;
      background: #1c2130; color: #e8ecf5; border: 1px solid #262c3d;
      border-radius: 6px; padding: 4px 9px; }
    .toast-host { bottom: 56px; }
  `;
  document.head.appendChild(style);

  const bar = document.createElement("div");
  bar.id = "demo-flag";
  bar.innerHTML = `DEMO MODE — in-memory, no Firebase. <button type="button">Bot claims now</button>`;
  bar.querySelector("button").addEventListener("click", () => {
    for (const r of JSON.parse(localStorage.getItem("clicky.roster") || "[]")) botClaim(r.code);
  });
  document.body.appendChild(bar);
}

export function onConnectionChange(cb) {
  cb(true);
  return () => {};
}

function g(code) {
  if (!world.has(code)) {
    world.set(code, {
      meta: null,
      players: {},
      presence: {},
      state: {},
      claims: {},
      announced: {},
      subs: new Set(),
    });
  }
  return world.get(code);
}

function emit(code, patch) {
  const game = g(code);
  for (const cb of game.subs) cb(clone(patch));
}

function emitAll(code) {
  const game = g(code);
  emit(code, {
    meta: game.meta,
    players: game.players,
    presence: game.presence,
    state: game.state,
    claims: Object.entries(game.claims)
      .map(([id, c]) => ({ id, ...c }))
      .sort((a, b) => a.at - b.at),
  });
}

export async function gameExists(code) {
  return !!world.get(code)?.meta;
}

export async function getMeta(code) {
  return clone(world.get(code)?.meta);
}

export async function createGame({ code, name, webhook, endsAt, player, seed }) {
  const game = g(code);
  game.meta = { code, name: name || "Clicky", createdAt: now(), endsAt, webhook: webhook || "" };
  game.players = {
    [player.id]: { name: player.name, discordId: player.discordId || "", joinedAt: now() },
    // Demo mode seats a bot immediately so there's someone to play against.
    [BOT]: { name: seed?.players?.[1]?.name || "Practice Bot", discordId: "", joinedAt: now() },
  };
  game.presence = { [BOT]: { online: true, at: now() } };
  game.state = { lastClaimAt: now(), lastClaim: null, duel: null, endsAt };
  game.claims = {};

  // Demo mode has both seats filled from the start, so imported history for
  // slot 1 can be applied immediately instead of parked in meta.pendingSeed.
  if (seed) {
    const ids = [player.id, BOT];
    for (const slot of [0, 1]) {
      seedClaims(seed, slot).forEach((c, i) => {
        game.claims[`seed_${slot}_${i}`] = { ...c, by: ids[slot] };
      });
    }
  }
  emitAll(code);
}

function seedClaims(seed, slot) {
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
      }));
  }
  const p = seed.players?.[slot];
  if (!p || !(p.seconds > 0)) return [];
  return [
    { at: now(), seconds: p.seconds, rawSeconds: p.seconds, multiplier: 1, status: "settled", imported: true },
  ];
}

export async function joinGame({ code, player }) {
  const game = g(code);
  // Same name already in the game means the same person on another device —
  // adopt their id rather than taking a second seat. Mirrors store.joinGame.
  const want = String(player.name || "").trim().toLowerCase();
  const sameName = Object.keys(game.players).find(
    (id) => String(game.players[id]?.name || "").trim().toLowerCase() === want
  );
  const playerId = sameName || player.id;

  game.players[playerId] = {
    name: player.name,
    discordId: player.discordId || "",
    joinedAt: game.players[playerId]?.joinedAt ?? now(),
  };
  emitAll(code);
  return playerId;
}

export function trackPresence(code, playerId) {
  const game = g(code);
  game.presence[playerId] = { online: true, at: now() };
  emitAll(code);
}

export async function setWebhook(code, webhook) {
  g(code).meta.webhook = webhook || "";
  emitAll(code);
}

export async function updatePlayer(code, playerId, fields) {
  Object.assign(g(code).players[playerId], fields);
  emitAll(code);
}

export function watchGame(code, cb) {
  const game = g(code);
  game.subs.add(cb);
  queueMicrotask(() => emitAll(code));
  return () => game.subs.delete(cb);
}

export async function claim(code, playerId) {
  const game = g(code);
  const claimId = nextId("c");
  const duelId = nextId("d");
  const at = now();
  const multiplier = multiplierAt(code, at);

  const next = applyClaim(game.state, {
    playerId,
    at,
    multiplier,
    claimId,
    duelId,
    tieWindowMs: TIE_WINDOW_MS,
  });
  if (next === undefined) return { outcome: "blocked" };
  game.state = next;

  if (game.state.duel?.id === duelId) {
    emitAll(code);
    scheduleBotThrow(code, duelId);
    return { outcome: "duel", duel: clone(game.state.duel) };
  }

  const c = game.state.lastClaim;
  game.claims[claimId] = {
    by: c.by,
    at: c.at,
    rawSeconds: c.rawSeconds,
    multiplier: c.multiplier,
    seconds: c.seconds,
    status: "settled",
  };
  emitAll(code);

  // A forced game (?demo&game=...) means the tester wants a duel every time,
  // not just when they happen to out-race the bot within the tie window — so
  // make the bot immediately race the player's claim instead of waiting for
  // a manual "Bot claims now" click.
  if (playerId !== BOT && getForcedGame()) {
    setTimeout(() => claim(code, BOT), 250);
  }

  return { outcome: "claim", claim: { id: claimId, ...c } };
}

export async function submitThrow(code, duelId, playerId, choice, path) {
  const game = g(code);
  const next = applyThrow(game.state.duel, { duelId, playerId, choice, path });
  if (next !== undefined) {
    game.state = { ...game.state, duel: next };
    emitAll(code);
  }
}

export async function trySettleDuel(code, duelId) {
  const game = g(code);
  const settleClaimId = nextId("s");
  const at = now();
  const next = applySettle(game.state.duel, { at, settleClaimId, duelId });
  if (next === undefined) return null;

  game.state = { ...game.state, duel: next };

  if (next.status === "open") {
    emitAll(code);
    scheduleBotThrow(code, duelId);
    return { draw: true, duel: clone(next) };
  }

  if (next.status === "double_offer") {
    emitAll(code);
    scheduleBotDoubleChoice(code, duelId);
    return { awaitingDouble: true, duel: clone(next) };
  }

  creditDuelWin(game, next, settleClaimId, at);
  emitAll(code);
  return { draw: false, duel: clone(next) };
}

export async function submitDoubleChoice(code, duelId, playerId, choice) {
  const game = g(code);
  const settleClaimId = nextId("s");
  const at = now();
  const next = applyDoubleChoice(game.state.duel, { duelId, playerId, choice, at, settleClaimId });
  if (next === undefined || next.status !== "resolved") return null;

  game.state = { ...game.state, duel: next };
  creditDuelWin(game, next, settleClaimId, at);
  emitAll(code);
  return { duel: clone(next) };
}

export async function checkDuelTimeout(code, duelId) {
  const game = g(code);
  const settleClaimId = nextId("s");
  const at = now();
  const next = applyDuelTimeout(game.state, { duelId, at, settleClaimId, timeoutMs: DUEL_TIMEOUT_MS });
  if (next === undefined) return null;

  game.state = next;

  if (game.state.voidedClaimId) {
    const voidedId = game.state.voidedClaimId;
    game.claims[voidedId].status = "void";
    game.state = { ...game.state, voidedClaimId: null };
    emitAll(code);
    return { voided: true };
  }

  const duel = game.state.duel;
  if (!duel || duel.status !== "resolved" || duel.settleClaimId !== settleClaimId) return null;

  creditDuelWin(game, duel, settleClaimId, at);
  emitAll(code);
  return { timedOut: true, duel: clone(duel) };
}

export async function checkReactionStart(code, duelId, playerId, iAmClear) {
  const game = g(code);
  const cleared = applyReactionClear(game.state.duel, { duelId, playerId, clear: iAmClear });
  if (cleared !== undefined) game.state = { ...game.state, duel: cleared };

  const started = applyStartReaction(game.state.duel, { duelId, at: now() });
  if (started !== undefined) {
    game.state = { ...game.state, duel: started };
    emitAll(code);
    scheduleBotThrow(code, duelId);
  } else if (cleared !== undefined) {
    emitAll(code);
  }
  return clone(game.state.duel);
}

export async function pingDuelActivity(code, duelId) {
  const game = g(code);
  const next = applyDuelActivity(game.state.duel, { duelId, at: now() });
  if (next !== undefined) {
    game.state = { ...game.state, duel: next };
    emitAll(code);
  }
}

function creditDuelWin(game, duel, settleClaimId, at) {
  const mult = duel.payoutMultiplier || 1;
  game.claims[duel.disputedClaimId].status = "void";
  game.claims[settleClaimId] = {
    by: duel.winner,
    at,
    rawSeconds: duel.potRawSeconds * mult,
    multiplier: 1,
    seconds: duel.potSeconds * mult,
    status: "settled",
    viaDuel: duel.id,
    game: duel.game || null,
    ties: (duel.round || 1) - 1,
    mgDetail: {
      challenger: duel.challenger,
      defender: duel.defender,
      picks: duel.finalPicks || null,
      detail: duel.detail || null,
      potSeconds: duel.potSeconds || 0,
      doubled: !!duel.doubled,
      doubleLost: !!duel.doubleLost,
      doubler: duel.doubler || null,
    },
  };
}

export async function claimAnnouncement(code, eventKey) {
  const game = g(code);
  if (game.announced[eventKey]) return false;
  game.announced[eventKey] = now();
  return true;
}

// --- Accounts (in-memory stand-in) -------------------------------------------

let mockAccount = null; // { uid, username }
let mockRoster = {};
const authSubs = new Set();

function emitAuth() {
  for (const cb of authSubs) cb(clone(mockAccount));
}

export function normalizeUsername(raw) {
  return String(raw || "").trim().toLowerCase();
}

export function isValidUsername(username) {
  return /^[a-z0-9_]{3,20}$/.test(username);
}

export function authErrorMessage(err) {
  return err?.message || "Something went wrong.";
}

export async function signUp(username, password) {
  const uname = normalizeUsername(username);
  if (!isValidUsername(uname)) throw new Error("Usernames are 3-20 characters: lowercase letters, numbers, underscore.");
  mockAccount = { uid: "demo_" + uname, username: uname };
  emitAuth();
  return clone(mockAccount);
}

export async function signIn(username, password) {
  const uname = normalizeUsername(username);
  mockAccount = { uid: "demo_" + uname, username: uname };
  emitAuth();
  return clone(mockAccount);
}

export async function signOutUser() {
  mockAccount = null;
  emitAuth();
}

export function onAuthChange(cb) {
  authSubs.add(cb);
  queueMicrotask(() => cb(clone(mockAccount)));
  return () => authSubs.delete(cb);
}

export async function getAccountRoster() {
  return clone(mockRoster);
}

export function setAccountRoster(uid, rosterObj) {
  mockRoster = clone(rosterObj);
  return Promise.resolve();
}

export function watchAccountRoster(uid, cb) {
  queueMicrotask(() => cb(clone(mockRoster)));
  return () => {};
}

// --- Bot opponent -----------------------------------------------------------

function botPickFor(duel) {
  switch (duel.game) {
    case "closest":
      return 1 + Math.floor(Math.random() * 10);
    case "coin":
      return Math.random() < 0.5 ? "heads" : "tails";
    case "dice":
      return true; // no real "choice" for this one — just needs to be present
    case "golf":
      return 0; // always sinks — forces ties/replays so obstacle rounds are easy to test
    default: {
      const opts = ["rock", "paper", "scissors"];
      return opts[Math.floor(Math.random() * 3)];
    }
  }
}

function scheduleBotThrow(code, duelId) {
  const duel = g(code).state.duel;
  if (!duel) return;

  // Reaction needs the bot to wait for "go" and then react with some
  // human-ish lag, not just fire on a flat random timer like the other games.
  if (duel.game === "reaction") {
    // The bot only ever plays one game at a time, so it's always clear to
    // start — report that the same way a real client would.
    if (!duel.goAt) {
      checkReactionStart(code, duelId, BOT, true);
      return;
    }
    const wait = Math.max(0, duel.goAt - now()) + 150 + Math.random() * 400;
    setTimeout(() => {
      const cur = g(code).state.duel;
      if (cur?.id !== duelId || cur.status !== "open") return;
      if ((cur.picks || {})[BOT] !== undefined) return;
      submitThrow(code, duelId, BOT, now());
    }, wait);
    return;
  }

  setTimeout(() => {
    const cur = g(code).state.duel;
    if (cur?.id !== duelId || cur.status !== "open") return;
    if ((cur.picks || {})[BOT] !== undefined) return;
    submitThrow(code, duelId, BOT, botPickFor(cur));
  }, 1200 + Math.random() * 1500);
}

/** If the bot won a coin flip, it decides take-or-double after a beat — mostly takes it. */
function scheduleBotDoubleChoice(code, duelId) {
  const duel = g(code).state.duel;
  if (!duel || duel.winner !== BOT) return;
  setTimeout(() => {
    const cur = g(code).state.duel;
    if (cur?.id !== duelId || cur.status !== "double_offer") return;
    submitDoubleChoice(code, duelId, BOT, Math.random() < 0.7 ? "take" : "double");
  }, 900 + Math.random() * 900);
}

/** Exposed on window so the demo page can poke the bot into claiming. */
export function botClaim(code) {
  return claim(code, BOT);
}
