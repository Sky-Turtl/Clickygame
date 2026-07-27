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
