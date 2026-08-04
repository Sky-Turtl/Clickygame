// The state machine, as pure functions.
//
// These are the bodies of the Firebase transactions. Keeping them free of I/O
// matters for more than tidiness: a transaction callback can be re-run any
// number of times against fresh server data, so it must be a pure function of
// the state it is handed. It also means the rules can be tested directly.
//
// Convention, matching Firebase's runTransaction: return `undefined` to abort,
// or the new state to commit.

import { rps } from "./rules.js";
import { hashString, mulberry32 } from "./util.js";

// --- Duel minigames -----------------------------------------------------
//
// A contested claim is settled by one of a few minigames, chosen at random
// when the duel opens. Anything that needs "randomness" (which game, a
// target number, dice rolls, a coin flip, a reaction delay, the golf course)
// is derived from a seeded PRNG rather than stored separately — same trick as
// the 2x windows in rules.js. Seeds mix in ctx.at (the settle transaction's
// timestamp) wherever the value must stay hidden from both players until
// after they've committed their picks, so nobody can reverse the formula to
// guarantee a win.

export const DUEL_GAMES = ["rps", "closest", "coin", "dice", "reaction", "golf", "crash"];

// Dev-only override so a specific minigame can be play-tested against the
// demo bot without racing for a random one. Set via setForcedGame (app.js
// wires this to ?game= under ?demo); left null in normal play.
let forcedGame = null;
export function setForcedGame(game) {
  forcedGame = DUEL_GAMES.includes(game) ? game : null;
}

export function getForcedGame() {
  return forcedGame;
}

function seededFloat(seed) {
  return mulberry32(hashString(seed))();
}

// `roomNextGame` is a synced, per-room override (state.nextGame in the DB —
// see store.setNextGame): both players in a room can see and set it, so
// forcing a game is a shared choice rather than one side quietly loading the
// dice against the other. `forcedGame` above stays local/dev-only.
function pickGame(duelId, roomNextGame) {
  if (roomNextGame && DUEL_GAMES.includes(roomNextGame)) return roomNextGame;
  if (forcedGame) return forcedGame;
  return DUEL_GAMES[Math.floor(seededFloat(`${duelId}|game`) * DUEL_GAMES.length)];
}

/**
 * The hidden multiplier at which a crash duel's rocket busts — one shared
 * bust point per (duel, round), drawn from a seed both players share, but
 * each side rides their own climb against it on their own clock (see
 * mountCrash in app.js): it plays out live in real time and either player
 * can cash out whenever they like. Riding it past this point (not clicking
 * in time) is what busts them. Drawn through
 * 1/(1-x), the standard crash-curve distribution — most bust points land low
 * (1-3x), with a long tail that's uncapped (P(hit X or higher) ~ 1/X) rather
 * than topping out at some fixed ceiling — a 1000x+ point is exponentially
 * rarer than a 100x one, not impossible. MAX_CRASH_POINT only guards the
 * float math at the extreme tail (the draw landing so close to 1 that
 * 1/(1-x) would overflow toward Infinity), not a real gameplay cap.
 */
const MAX_CRASH_POINT = 1e6;
export function generateCrashPoint(seed) {
  const u = seededFloat(seed);
  const INSTANT_BUST_CHANCE = 0.04;
  if (u < INSTANT_BUST_CHANCE) return 1;
  const remapped = (u - INSTANT_BUST_CHANCE) / (1 - INSTANT_BUST_CHANCE);
  const point = Math.min(MAX_CRASH_POINT, 1 / (1 - remapped));
  return Math.round(point * 100) / 100;
}

/**
 * Payout on top of the pot for a crash duel: grows with the log of the gap
 * between the two crash points, so a narrow win pays close to 1x while a
 * blowout (someone's run went to the moon while the other busted at 1.00x)
 * pays several times over — without the runaway scale a linear multiplier
 * on raw difference would give.
 */
function crashPayoutMultiplier(crashA, crashB) {
  const diff = Math.abs(crashA - crashB);
  return Math.round((1 + Math.log(1 + diff)) * 100) / 100;
}

/**
 * Random delay before a reaction round's "go" moment. Shaped as an Erlang(2)
 * draw on top of a 1.2s floor: rises then decays, so most delays land around
 * 2-3s while a long tail keeps rarer, longer waits possible (rather than a
 * flat cutoff that never goes past a fixed max).
 */
function reactionDelay(duelId, round) {
  const u1 = seededFloat(`${duelId}|${round}|delay1`);
  const u2 = seededFloat(`${duelId}|${round}|delay2`);
  return 1200 + Math.round(-750 * Math.log(u1 * u2));
}

/**
 * Decide a settled round. `a`/`b` are the challenger's/defender's picks.
 * @returns { verdict, detail } — verdict is 1 (challenger), -1 (defender), or
 *          0 (draw, play again); detail is extra info for the result screen.
 */
function resolveGame(duel, a, b, ctx) {
  switch (duel.game) {
    case "closest": {
      const target = 1 + Math.floor(seededFloat(`${duel.id}|${ctx.at}|target`) * 10); // 1-10
      const da = Math.abs(Number(a) - target);
      const db = Math.abs(Number(b) - target);
      const verdict = da < db ? 1 : da > db ? -1 : 0;
      const exact = (verdict > 0 && da === 0) || (verdict < 0 && db === 0);
      return { verdict, detail: { target, exact } };
    }
    case "coin": {
      // Both sides call heads or tails before the flip. Calling it right wins;
      // calling the same side as your opponent (both right or both wrong
      // together) settles nothing, so it redraws.
      const heads = seededFloat(`${duel.id}|${ctx.at}|coin`) < 0.5;
      const result = heads ? "heads" : "tails";
      const aRight = a === result;
      const bRight = b === result;
      if (aRight === bRight) return { verdict: 0, detail: { result } };
      return { verdict: aRight ? 1 : -1, detail: { result } };
    }
    case "dice": {
      const rollA = 1 + Math.floor(seededFloat(`${duel.id}|${duel.challenger}|${ctx.at}`) * 6);
      const rollB = 1 + Math.floor(seededFloat(`${duel.id}|${duel.defender}|${ctx.at}`) * 6);
      return { verdict: rollA > rollB ? 1 : rollA < rollB ? -1 : 0, detail: { rollA, rollB } };
    }
    case "reaction": {
      const la = a - duel.goAt;
      const lb = b - duel.goAt;
      const aFalse = la < 0;
      const bFalse = lb < 0;
      let verdict;
      if (aFalse && bFalse) verdict = 0;
      else if (aFalse) verdict = -1;
      else if (bFalse) verdict = 1;
      else verdict = la < lb ? 1 : la > lb ? -1 : 0;
      return { verdict, detail: { latencyA: la, latencyB: lb, falseStartA: aFalse, falseStartB: bFalse } };
    }
    case "golf": {
      // Picks are each player's final distance from the hole (0 = sunk),
      // played out locally in the mini-putt widget — see golf.js. Closest wins.
      const da = Number(a);
      const db = Number(b);
      return { verdict: da < db ? 1 : da > db ? -1 : 0, detail: { distA: da, distB: db } };
    }
    case "crash": {
      // Picks are each player's own result from their own independent run
      // (see mountCrash in app.js): the multiplier they cashed out at, or 0
      // if they rode it past the shared hidden bust point instead of
      // stopping in time. Higher wins; busting means 0 goes straight into
      // the payout gap below, same as any other result. Both busting (or
      // both cashing out at the same multiplier) is a wash, same as any
      // other tie — so it redraws.
      const crashA = Number(a);
      const crashB = Number(b);
      if (crashA === crashB) return { verdict: 0, detail: { crashA, crashB } };
      return { verdict: crashA > crashB ? 1 : -1, detail: { crashA, crashB } };
    }
    case "rps":
    default:
      return { verdict: rps(a, b), detail: null };
  }
}

/**
 * Someone pressed CLAIM.
 *
 * @param state  { lastClaimAt, lastClaim, duel, endsAt, lastBy }
 * @param ctx    { playerId, at, multiplier, claimId, duelId, tieWindowMs,
 *                 minIntervalMs }
 * @returns new state, or undefined to abort
 */
export function applyClaim(state, ctx) {
  if (state === null || state === undefined) return undefined;

  // The deadline has passed — the clock is stopped for good.
  if (state.endsAt && ctx.at > state.endsAt) return undefined;

  // Hard freeze while a duel is unsettled — including a coin's double-or-
  // nothing offer, which is still an open question about who gets the pot.
  if (state.duel && (state.duel.status === "open" || state.duel.status === "double_offer")) {
    return undefined;
  }

  // Per-player cooldown. Checked here rather than only in the UI so it holds
  // even against a doctored client.
  const myLast = state.lastBy?.[ctx.playerId];
  if (myLast && ctx.at - myLast < (ctx.minIntervalMs || 0)) return undefined;

  const last = state.lastClaim || null;
  const lastAt = state.lastClaimAt || ctx.at;
  const gapMs = Math.max(0, ctx.at - lastAt);

  // A different player claimed moments ago: they were racing for this same
  // block of time, so nobody banks it until a minigame says so.
  if (last && last.by !== ctx.playerId && gapMs < ctx.tieWindowMs) {
    const gapSeconds = gapMs / 1000;
    const game = pickGame(ctx.duelId, state.nextGame);
    const duel = {
      id: ctx.duelId,
      game,
      status: "open",
      round: 1,
      challenger: ctx.playerId,
      defender: last.by,
      disputedClaimId: last.id,
      // The defender's banked time plus the sliver the challenger was
      // reaching for — one pot, winner takes all.
      potSeconds: (last.seconds || 0) + gapSeconds * ctx.multiplier,
      potRawSeconds: (last.rawSeconds || 0) + gapSeconds,
      gapMs,
      createdAt: ctx.at,
      picks: null,
    };
    // Reaction's goAt isn't set here: the clock shouldn't start until both
    // players have actually clicked "I'm ready" — see applyReactionClear/
    // applyStartReaction, driven by store.checkReactionStart.
    if (game === "reaction") duel.reactionClear = {};
    // Crash doesn't need the reaction-style ready handshake: each side rides
    // their own independent climb on their own clock, so a player can start
    // the instant they click "Ready" without waiting on the other side — see
    // applyCrashReady, driven by store.checkCrashStart. `crashStart` tracks,
    // per player, the timestamp their own run began.
    if (game === "crash") duel.crashStart = {};
    // Tracks the start of the *current* round for timeout purposes — reset on
    // every redraw so a long multi-round duel doesn't get cut off mid-stride.
    duel.roundStartAt = ctx.at;

    return {
      ...state,
      duel,
      // The clock restarts now, so the duel's own duration is up for grabs by
      // whoever claims first once it's settled.
      lastClaimAt: ctx.at,
      lastClaim: null,
      lastBy: { ...(state.lastBy || {}), [ctx.playerId]: ctx.at },
    };
  }

  const rawSeconds = gapMs / 1000;
  return {
    ...state,
    lastClaimAt: ctx.at,
    lastBy: { ...(state.lastBy || {}), [ctx.playerId]: ctx.at },
    lastClaim: {
      id: ctx.claimId,
      by: ctx.playerId,
      at: ctx.at,
      rawSeconds,
      multiplier: ctx.multiplier,
      seconds: rawSeconds * ctx.multiplier,
    },
  };
}

/**
 * Both picks are in — decide the duel via whichever minigame it rolled.
 *
 * A coin duel doesn't go straight to "resolved": the winner gets first offered
 * a double-or-nothing redo (see applyDoubleChoice), so it lands on
 * "double_offer" instead and waits on that decision before any claim is
 * credited.
 *
 * @param duel current duel node
 * @param ctx  { at, settleClaimId, duelId }
 * @returns new duel, or undefined to abort (wrong duel, already settled, or
 *          still waiting on a pick)
 */
export function applySettle(duel, ctx) {
  if (!duel || duel.id !== ctx.duelId || duel.status !== "open") return undefined;

  const picks = duel.picks || {};
  const a = picks[duel.challenger];
  const b = picks[duel.defender];
  if (a === undefined || a === null || b === undefined || b === null) return undefined;

  const { verdict, detail } = resolveGame(duel, a, b, ctx);

  if (verdict === 0) {
    const drawnRound = duel.round || 1;
    const next = {
      ...duel,
      round: drawnRound + 1,
      lastDraw: { round: drawnRound, detail },
      picks: null,
      golfPaths: null, // last round's recorded shots don't carry into the replay round
      roundStartAt: ctx.at,
    };
    if (duel.game === "reaction") {
      // Re-gate the next round too — either player may have picked up
      // another duel in the meantime.
      delete next.goAt;
      next.reactionClear = {};
    }
    if (duel.game === "crash") {
      // Same re-gate for crash's ready-up — a redraw shouldn't carry either
      // side's run from round 1 into round 2; both need to hit "Ready" again.
      next.crashStart = {};
    }
    return next;
  }

  const winner = verdict > 0 ? duel.challenger : duel.defender;
  const loser = verdict > 0 ? duel.defender : duel.challenger;

  if (duel.game === "coin") {
    return { ...duel, status: "double_offer", winner, loser, finalPicks: picks, detail, decidedAt: ctx.at };
  }

  const payoutMultiplier =
    duel.game === "crash"
      ? crashPayoutMultiplier(detail.crashA, detail.crashB)
      : duel.game === "closest" && detail?.exact
        ? 5
        : 1;

  return {
    ...duel,
    status: "resolved",
    winner,
    loser,
    finalPicks: picks,
    detail,
    payoutMultiplier,
    resolvedAt: ctx.at,
    // Our fingerprint: whichever client's value survives the transaction is the
    // one responsible for writing the settlement to the claims log.
    settleClaimId: ctx.settleClaimId,
  };
}

/**
 * The coin winner takes their win, or gambles it on one more flip for double.
 * Losing the double-or-nothing flip doesn't hand the pot to anyone — it's
 * simply gone, the same as if neither player had ever claimed that time.
 * `winner`/`loser` are left as-is (the original flip's result), so the
 * hover/result UI can still say who won the flip that got doubled away.
 *
 * @param duel current duel node
 * @param ctx  { duelId, playerId, choice: "take"|"double", at, settleClaimId }
 */
export function applyDoubleChoice(duel, ctx) {
  if (!duel || duel.id !== ctx.duelId || duel.status !== "double_offer") return undefined;
  if (ctx.playerId !== duel.winner) return undefined;

  if (ctx.choice === "take") {
    return { ...duel, status: "resolved", payoutMultiplier: 1, resolvedAt: ctx.at, settleClaimId: ctx.settleClaimId };
  }
  if (ctx.choice !== "double") return undefined;

  const wonAgain = seededFloat(`${duel.id}|${ctx.at}|double`) < 0.5;
  if (wonAgain) {
    return {
      ...duel,
      status: "resolved",
      payoutMultiplier: 2,
      doubled: true,
      doubler: duel.winner, // who chose to go double — kept separate from `winner` since a lost double swaps that
      resolvedAt: ctx.at,
      settleClaimId: ctx.settleClaimId,
    };
  }
  return {
    ...duel,
    status: "resolved",
    payoutMultiplier: 0,
    doubled: true,
    doubleLost: true,
    potLost: true,
    doubler: duel.winner,
    resolvedAt: ctx.at,
    settleClaimId: ctx.settleClaimId,
  };
}

/**
 * Record a player's pick (a throw, a guess, a tap timestamp — whatever the game calls for).
 *
 * @param path golf-only: the recorded {x,y}[] frames of that shot, kept alongside
 *             the numeric distance (which is what `picks` — and resolveGame's
 *             comparison — actually uses) so both players can later watch each
 *             other's actual shot, not just their own.
 */
export function applyThrow(duel, { duelId, playerId, choice, path }) {
  if (!duel || duel.id !== duelId || duel.status !== "open") return undefined;
  // A stale client (loaded before the ready-up gate shipped, or otherwise
  // out of sync) has no "Ready" button to hold it back, so it could submit a
  // pick before the round has actually started for that player — crash's own
  // clock hasn't begun (no crashStart[playerId]) or reaction's "go" moment
  // hasn't fired (no goAt). Reject it here so a throw can't bypass the gate.
  if (duel.game === "crash" && !duel.crashStart?.[playerId]) return undefined;
  if (duel.game === "reaction" && !duel.goAt) return undefined;
  const next = { ...duel, picks: { ...(duel.picks || {}), [playerId]: choice } };
  if (duel.game === "golf" && path) {
    next.golfPaths = { ...(duel.golfPaths || {}), [playerId]: path };
  }
  return next;
}

/**
 * A duel (or a coin's double-or-nothing offer) has gone quiet too long.
 *
 * - Both sides already responded: nothing to do here — applySettle/
 *   applyDoubleChoice would have already moved the duel past "open"/
 *   "double_offer", so this aborts.
 * - Exactly one side responded (or, in a double_offer, the winner just
 *   hasn't chosen): that side wins the pot outright, same shape as a normal
 *   resolution so the caller's credit path is identical.
 * - Neither side responded: the disputed period never happened as far as
 *   the clock is concerned. The claim that started the duel is voided and
 *   the running clock rewinds to before it, instead of quietly discarding
 *   that time.
 *
 * @param state current game state
 * @param ctx   { duelId, at, settleClaimId, timeoutMs }
 * @returns new state, or undefined to abort (wrong/missing duel, not timed
 *          out yet, or already past the point of timing out)
 */
export function applyDuelTimeout(state, ctx) {
  if (!state || !state.duel || state.duel.id !== ctx.duelId) return undefined;
  const duel = state.duel;

  if (duel.status === "double_offer") {
    const startedAt = Math.max(duel.decidedAt || 0, duel.lastActivityAt || 0);
    const elapsed = ctx.at - startedAt;
    if (elapsed < ctx.timeoutMs) return undefined;
    return {
      ...state,
      duel: {
        ...duel,
        status: "resolved",
        payoutMultiplier: 1,
        resolvedAt: ctx.at,
        settleClaimId: ctx.settleClaimId,
        timedOut: true,
      },
    };
  }

  if (duel.status !== "open") return undefined;

  // A reaction round that hasn't been given its goAt yet isn't running —
  // it's still waiting on both sides to clear their other duels (see
  // applyStartReaction) — so it can't time out.
  if (duel.game === "reaction" && !duel.goAt) return undefined;

  const startedAt = Math.max(duel.roundStartAt || duel.createdAt, duel.lastActivityAt || 0);
  const elapsed = ctx.at - startedAt;
  if (elapsed < ctx.timeoutMs) return undefined;

  const picks = duel.picks || {};
  const aResponded = picks[duel.challenger] !== undefined && picks[duel.challenger] !== null;
  const bResponded = picks[duel.defender] !== undefined && picks[duel.defender] !== null;

  if (aResponded && bResponded) return undefined; // already settleable — let applySettle handle it

  if (aResponded || bResponded) {
    const winner = aResponded ? duel.challenger : duel.defender;
    const loser = aResponded ? duel.defender : duel.challenger;
    return {
      ...state,
      duel: {
        ...duel,
        status: "resolved",
        winner,
        loser,
        finalPicks: picks,
        detail: null,
        payoutMultiplier: 1,
        resolvedAt: ctx.at,
        settleClaimId: ctx.settleClaimId,
        timedOut: true,
      },
    };
  }

  // Neither side responded: void the disputed claim and hand the contested
  // gap back to the running clock, as if the race never happened.
  return {
    ...state,
    lastClaimAt: duel.createdAt - duel.gapMs,
    lastClaim: null,
    duel: null,
    voidedClaimId: duel.disputedClaimId,
  };
}

/**
 * A player clicked "I'm ready" for a reaction round. One flag per player,
 * self-reported since only that player's own client can know they've hit the
 * button.
 *
 * @param duel current duel node
 * @param ctx  { duelId, playerId, clear }
 */
export function applyReactionClear(duel, ctx) {
  if (!duel || duel.id !== ctx.duelId || duel.status !== "open") return undefined;
  if (duel.game !== "reaction" || duel.goAt) return undefined;
  if (ctx.playerId !== duel.challenger && ctx.playerId !== duel.defender) return undefined;
  return { ...duel, reactionClear: { ...(duel.reactionClear || {}), [ctx.playerId]: !!ctx.clear } };
}

/** Once both sides have reported clear, actually start the reaction round's clock. */
export function applyStartReaction(duel, ctx) {
  if (!duel || duel.id !== ctx.duelId || duel.status !== "open") return undefined;
  if (duel.game !== "reaction" || duel.goAt) return undefined;
  const clear = duel.reactionClear || {};
  if (!clear[duel.challenger] || !clear[duel.defender]) return undefined;
  return { ...duel, goAt: ctx.at + reactionDelay(duel.id, duel.round || 1) };
}

/**
 * A player clicked "Ready" for a crash round. Unlike reaction's synchronized
 * countdown, crash doesn't need both players watching the same instant — each
 * side rides their own independent climb against the shared hidden bust
 * point, so a player's own "Ready" click starts *their* clock immediately,
 * with no need to wait on the other side.
 *
 * @param duel current duel node
 * @param ctx  { duelId, playerId, at }
 */
export function applyCrashReady(duel, ctx) {
  if (!duel || duel.id !== ctx.duelId || duel.status !== "open") return undefined;
  if (duel.game !== "crash" || duel.crashStart?.[ctx.playerId]) return undefined;
  if (ctx.playerId !== duel.challenger && ctx.playerId !== duel.defender) return undefined;
  return { ...duel, crashStart: { ...(duel.crashStart || {}), [ctx.playerId]: ctx.at } };
}

/** A player interacted with the duel UI (typed, dragged, tapped) — pushes the timeout back out. */
export function applyDuelActivity(duel, ctx) {
  if (!duel || duel.id !== ctx.duelId) return undefined;
  if (duel.status !== "open" && duel.status !== "double_offer") return undefined;
  return { ...duel, lastActivityAt: ctx.at };
}
