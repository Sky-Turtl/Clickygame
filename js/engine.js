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
// target number, dice rolls, a coin flip, a reaction delay) is derived from a
// seeded PRNG rather than stored separately — same trick as the 2x windows in
// rules.js. Seeds mix in ctx.at (the settle transaction's timestamp) wherever
// the value must stay hidden from both players until after they've committed
// their picks, so nobody can reverse the formula to guarantee a win.

export const DUEL_GAMES = ["rps", "closest", "coin", "dice", "reaction"];

function seededFloat(seed) {
  return mulberry32(hashString(seed))();
}

function pickGame(duelId) {
  return DUEL_GAMES[Math.floor(seededFloat(`${duelId}|game`) * DUEL_GAMES.length)];
}

/** Random 1.2-3.8s delay before a reaction round's "go" moment. */
function reactionDelay(duelId, round) {
  return 1200 + Math.floor(seededFloat(`${duelId}|${round}|delay`) * 2600);
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
      return { verdict: da < db ? 1 : da > db ? -1 : 0, detail: { target } };
    }
    case "coin": {
      const heads = seededFloat(`${duel.id}|${ctx.at}|coin`) < 0.5;
      return { verdict: heads ? 1 : -1, detail: { flip: heads ? "heads" : "tails" } };
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

  // Hard freeze while a duel is unsettled.
  if (state.duel && state.duel.status === "open") return undefined;

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
    const game = pickGame(ctx.duelId);
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
    if (game === "reaction") duel.goAt = ctx.at + reactionDelay(ctx.duelId, 1);

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
    };
    if (duel.game === "reaction") next.goAt = ctx.at + reactionDelay(duel.id, next.round);
    return next;
  }

  return {
    ...duel,
    status: "resolved",
    winner: verdict > 0 ? duel.challenger : duel.defender,
    loser: verdict > 0 ? duel.defender : duel.challenger,
    finalPicks: picks,
    detail,
    resolvedAt: ctx.at,
    // Our fingerprint: whichever client's value survives the transaction is the
    // one responsible for writing the settlement to the claims log.
    settleClaimId: ctx.settleClaimId,
  };
}

/** Record a player's pick (a throw, a guess, a tap timestamp — whatever the game calls for). */
export function applyThrow(duel, { duelId, playerId, choice }) {
  if (!duel || duel.id !== duelId || duel.status !== "open") return undefined;
  return { ...duel, picks: { ...(duel.picks || {}), [playerId]: choice } };
}
