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

/**
 * Someone pressed CLAIM.
 *
 * @param state  { lastClaimAt, lastClaim, duel, endsAt }
 * @param ctx    { playerId, at, multiplier, claimId, duelId, tieWindowMs }
 * @returns new state, or undefined to abort
 */
export function applyClaim(state, ctx) {
  if (state === null || state === undefined) return undefined;

  // The deadline has passed — the clock is stopped for good.
  if (state.endsAt && ctx.at > state.endsAt) return undefined;

  // Hard freeze while a duel is unsettled.
  if (state.duel && state.duel.status === "open") return undefined;

  const last = state.lastClaim || null;
  const lastAt = state.lastClaimAt || ctx.at;
  const gapMs = Math.max(0, ctx.at - lastAt);

  // A different player claimed moments ago: they were racing for this same
  // block of time, so nobody banks it until rock-paper-scissors says so.
  if (last && last.by !== ctx.playerId && gapMs < ctx.tieWindowMs) {
    const gapSeconds = gapMs / 1000;
    return {
      ...state,
      duel: {
        id: ctx.duelId,
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
      },
      // The clock restarts now, so the duel's own duration is up for grabs by
      // whoever claims first once it's settled.
      lastClaimAt: ctx.at,
      lastClaim: null,
    };
  }

  const rawSeconds = gapMs / 1000;
  return {
    ...state,
    lastClaimAt: ctx.at,
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
 * Both throws are in — decide the duel.
 *
 * @param duel current duel node
 * @param ctx  { at, settleClaimId, duelId }
 * @returns new duel, or undefined to abort (wrong duel, already settled, or
 *          still waiting on a throw)
 */
export function applySettle(duel, ctx) {
  if (!duel || duel.id !== ctx.duelId || duel.status !== "open") return undefined;

  const picks = duel.picks || {};
  const a = picks[duel.challenger];
  const b = picks[duel.defender];
  if (!a || !b) return undefined;

  const verdict = rps(a, b);

  if (verdict === 0) {
    const drawnRound = duel.round || 1;
    return {
      ...duel,
      round: drawnRound + 1,
      lastDraw: { throw: a, round: drawnRound },
      picks: null,
    };
  }

  return {
    ...duel,
    status: "resolved",
    winner: verdict > 0 ? duel.challenger : duel.defender,
    loser: verdict > 0 ? duel.defender : duel.challenger,
    finalPicks: picks,
    resolvedAt: ctx.at,
    // Our fingerprint: whichever client's value survives the transaction is the
    // one responsible for writing the settlement to the claims log.
    settleClaimId: ctx.settleClaimId,
  };
}

/** Record a player's throw. */
export function applyThrow(duel, { duelId, playerId, choice }) {
  if (!duel || duel.id !== duelId || duel.status !== "open") return undefined;
  return { ...duel, picks: { ...(duel.picks || {}), [playerId]: choice } };
}
