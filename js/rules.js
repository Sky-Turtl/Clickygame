// Pure game rules. No I/O — everything here is deterministic and testable.

import { DOUBLE_MULTIPLIER, DOUBLE_WINDOWS_PER_DAY } from "./config.js";
import { hashString, mulberry32, utcDayKey } from "./util.js";

// --- Double-time windows ----------------------------------------------------
//
// The two daily 2x hours are *derived*, not stored: both browsers run the same
// seeded PRNG over (gameCode + UTC date) and get the same answer. No writes, no
// races, and nobody can peek at tomorrow's windows without knowing the code.

/** @returns {number[]} sorted UTC hours (0-23) that are 2x on the given day. */
export function doubleHoursFor(gameCode, dayKey) {
  const rand = mulberry32(hashString(`${gameCode}|${dayKey}|2x`));
  const hours = new Set();
  // Rejection-sample distinct hours; the PRNG is seeded so this always terminates
  // identically on every device.
  let guard = 0;
  while (hours.size < DOUBLE_WINDOWS_PER_DAY && guard++ < 500) {
    hours.add(Math.floor(rand() * 24));
  }
  return [...hours].sort((a, b) => a - b);
}

/** Multiplier in effect at a given moment. */
export function multiplierAt(gameCode, atMs) {
  const dayKey = utcDayKey(atMs);
  const hour = new Date(atMs).getUTCHours();
  return doubleHoursFor(gameCode, dayKey).includes(hour) ? DOUBLE_MULTIPLIER : 1;
}

/** Details about the current/next 2x window, for the banner and countdown. */
export function windowStatus(gameCode, atMs) {
  const dayKey = utcDayKey(atMs);
  const hours = doubleHoursFor(gameCode, dayKey);
  const nowHour = new Date(atMs).getUTCHours();
  const active = hours.includes(nowHour);

  if (active) {
    const endsAt = Date.UTC(
      new Date(atMs).getUTCFullYear(),
      new Date(atMs).getUTCMonth(),
      new Date(atMs).getUTCDate(),
      nowHour + 1
    );
    return { active: true, multiplier: DOUBLE_MULTIPLIER, endsAt, dayKey, hours, hour: nowHour };
  }

  // Next window today, else the first one tomorrow.
  const base = new Date(atMs);
  const nextToday = hours.find((h) => h > nowHour);
  let startsAt, nextDayKey, nextHour;
  if (nextToday !== undefined) {
    nextHour = nextToday;
    nextDayKey = dayKey;
    startsAt = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), nextToday);
  } else {
    const tomorrow = new Date(atMs + 86400000);
    nextDayKey = utcDayKey(tomorrow.getTime());
    nextHour = doubleHoursFor(gameCode, nextDayKey)[0];
    startsAt = Date.UTC(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth(),
      tomorrow.getUTCDate(),
      nextHour
    );
  }
  return {
    active: false,
    multiplier: 1,
    startsAt,
    dayKey,
    hours,
    nextDayKey,
    nextHour,
  };
}

// --- Rock paper scissors ----------------------------------------------------

export const THROWS = ["rock", "paper", "scissors"];
export const THROW_EMOJI = { rock: "🪨", paper: "📄", scissors: "✂️" };

/** @returns 1 if a beats b, -1 if b beats a, 0 on a draw. */
export function rps(a, b) {
  if (a === b) return 0;
  const wins = { rock: "scissors", paper: "rock", scissors: "paper" };
  return wins[a] === b ? 1 : -1;
}

// --- Duel minigames (display only — see engine.js for the rules themselves) -

/** Keys match `engine.DUEL_GAMES`, kept separate to avoid a circular import. */
export const DUEL_META = {
  rps: {
    label: "Rock Paper Scissors",
    icon: "✊",
    rule: "Best of one. Rock beats scissors, scissors beats paper, paper beats rock.",
  },
  closest: {
    label: "Closest guess",
    icon: "🎯",
    rule: "Guess a number from 0–100. Whoever's closest to the secret target wins.",
  },
  coin: {
    label: "Coin flip",
    icon: "🪙",
    rule: "Pure chance — tap to flip. Winner takes the whole pot.",
  },
  dice: {
    label: "Dice roll",
    icon: "🎲",
    rule: "Roll a die each. Higher roll wins; a tie rolls again.",
  },
  reaction: {
    label: "Reaction test",
    icon: "⚡",
    rule: "Wait for GO, then tap as fast as you can. Jumping the gun loses outright.",
  },
};

// --- Catch-up math -----------------------------------------------------------

/**
 * Max claimed-seconds obtainable between two instants if one player claimed
 * every second on the clock, honoring whatever 2x windows fall in between.
 */
export function maxClaimable(gameCode, fromMs, toMs) {
  if (toMs <= fromMs) return 0;
  let total = 0;
  let cur = fromMs;
  while (cur < toMs) {
    const h = new Date(cur);
    const nextHourMs = Date.UTC(h.getUTCFullYear(), h.getUTCMonth(), h.getUTCDate(), h.getUTCHours() + 1);
    const segEnd = Math.min(nextHourMs, toMs);
    total += ((segEnd - cur) / 1000) * multiplierAt(gameCode, cur);
    cur = segEnd;
  }
  return total;
}

/**
 * The latest instant T (fromMs <= T <= toMs) at which a trailing player could
 * still theoretically close a gap of `budget` claimed-seconds by claiming
 * every remaining second between T and toMs.
 *
 * Past this instant the deficit is mathematically unwinnable even in the best
 * case, regardless of what either player actually does. Returns `fromMs` when
 * even claiming the whole remaining window isn't enough (already unwinnable),
 * or `null` when there's nothing to catch up (`budget <= 0`).
 */
export function unwinnableAt(gameCode, budget, fromMs, toMs) {
  if (budget <= 0) return null;
  if (maxClaimable(gameCode, fromMs, toMs) < budget) return fromMs;

  let acc = 0;
  let cur = toMs;
  while (cur > fromMs) {
    const h = new Date(cur - 1); // hour containing the instant just before cur
    const hourStartMs = Date.UTC(h.getUTCFullYear(), h.getUTCMonth(), h.getUTCDate(), h.getUTCHours());
    const segStart = Math.max(hourStartMs, fromMs);
    const rate = multiplierAt(gameCode, segStart);
    const segClaim = ((cur - segStart) / 1000) * rate;
    if (acc + segClaim >= budget) {
      const neededSeconds = (budget - acc) / rate;
      return cur - neededSeconds * 1000;
    }
    acc += segClaim;
    cur = segStart;
  }
  return fromMs;
}

// --- Summary aggregation ----------------------------------------------------

export const PERIODS = [
  { key: "1h", label: "Last hour", ms: 3600e3 },
  { key: "6h", label: "Last 6 hours", ms: 6 * 3600e3 },
  { key: "1d", label: "Last day", ms: 24 * 3600e3 },
  { key: "1w", label: "Last week", ms: 7 * 24 * 3600e3 },
  { key: "1mo", label: "Last month", ms: 30 * 24 * 3600e3 },
  { key: "all", label: "All time", ms: Infinity },
];

/**
 * Roll the claim log up per player, per period.
 *
 * `claimed` counts the 2x multiplier; `actual` is the real wall-clock time that
 * was on the board when the button was hit. They differ only inside 2x windows.
 *
 * @returns {Object} { [playerId]: { [periodKey]: {claimed, actual, count} } }
 */
export function summarize(claims, playerIds, nowMs) {
  const out = {};
  for (const pid of playerIds) {
    out[pid] = {};
    for (const p of PERIODS) out[pid][p.key] = { claimed: 0, actual: 0, count: 0 };
  }

  for (const c of claims) {
    if (c.status !== "settled") continue;
    if (!out[c.by]) continue;
    const age = nowMs - c.at;
    for (const p of PERIODS) {
      if (age <= p.ms) {
        const bucket = out[c.by][p.key];
        bucket.claimed += c.seconds || 0;
        bucket.actual += c.rawSeconds || 0;
        bucket.count += 1;
      }
    }
  }
  return out;
}
