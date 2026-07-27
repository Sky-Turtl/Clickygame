// In-memory stand-in for store.js, used by dev/index.html (demo mode).
//
// Same exported interface, same engine, no network. It also runs a simple bot
// opponent so the duel flow can be exercised solo. Nothing here ships to the
// real game — the import map in dev/index.html swaps it in.

import { TIE_WINDOW_MS } from "../js/config.js";
import { multiplierAt } from "../js/rules.js";
import { applyClaim, applySettle, applyThrow } from "../js/engine.js";

const BOT = "bot_opponent";
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));

const world = new Map(); // code -> { meta, players, presence, state, claims, announced, subs }
let uid = 0;
const nextId = (p) => `${p}_${Date.now().toString(36)}_${++uid}`;

export const now = () => Date.now();

export async function init() {
  console.info("[demo] running with the in-memory mock store — no Firebase involved");
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
  game.players[player.id] = {
    name: player.name,
    discordId: player.discordId || "",
    joinedAt: now(),
  };
  emitAll(code);
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
  return { outcome: "claim", claim: { id: claimId, ...c } };
}

export async function submitThrow(code, duelId, playerId, choice) {
  const game = g(code);
  const next = applyThrow(game.state.duel, { duelId, playerId, choice });
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

  if (next.status !== "resolved") {
    emitAll(code);
    scheduleBotThrow(code, duelId);
    return { draw: true, duel: clone(next) };
  }

  game.claims[next.disputedClaimId].status = "void";
  game.claims[settleClaimId] = {
    by: next.winner,
    at,
    rawSeconds: next.potRawSeconds,
    multiplier: 1,
    seconds: next.potSeconds,
    status: "settled",
    viaDuel: next.id,
  };
  emitAll(code);
  return { draw: false, duel: clone(next) };
}

export async function claimAnnouncement(code, eventKey) {
  const game = g(code);
  if (game.announced[eventKey]) return false;
  game.announced[eventKey] = now();
  return true;
}

// --- Bot opponent -----------------------------------------------------------

function scheduleBotThrow(code, duelId) {
  setTimeout(() => {
    const game = g(code);
    if (game.state.duel?.id !== duelId || game.state.duel.status !== "open") return;
    if ((game.state.duel.picks || {})[BOT]) return;
    const opts = ["rock", "paper", "scissors"];
    submitThrow(code, duelId, BOT, opts[Math.floor(Math.random() * 3)]);
  }, 1200 + Math.random() * 1500);
}

/** Exposed on window so the demo page can poke the bot into claiming. */
export function botClaim(code) {
  return claim(code, BOT);
}
