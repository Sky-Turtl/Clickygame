// Small helpers with no dependencies on Firebase or the DOM shape.

/** Format a duration in seconds as "3h 12m 05s" / "12m 05s" / "5.2s". */
export function fmtDuration(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;

  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;

  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}

/** Compact form for tight spaces: "3h 12m". */
export function fmtDurationShort(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  if (s < 60) return `${Math.round(s)}s`;
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** "just now" / "42s ago" / "5m ago" / "2h ago" */
export function fmtAgo(ms) {
  const d = Math.max(0, ms);
  if (d < 5000) return "just now";
  if (d < 60000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3600000) return `${Math.round(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.round(d / 3600000)}h ago`;
  return `${Math.round(d / 86400000)}d ago`;
}

/** Deterministic 32-bit string hash (FNV-1a). */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Seeded PRNG. Same seed always yields the same sequence, on every device. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random game code: 6 chars, no ambiguous glyphs (no O/0, I/1). */
export function makeGameCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 6; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

/** Stable per-browser player id, persisted in localStorage. */
export function localPlayerId() {
  const KEY = "clicky.playerId";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = "p_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    localStorage.setItem(KEY, id);
  }
  return id;
}

export const store = {
  get: (k, fallback = null) => {
    try {
      const v = localStorage.getItem("clicky." + k);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem("clicky." + k, JSON.stringify(v));
    } catch {
      /* private browsing, quota — non-fatal */
    }
  },
  del: (k) => {
    try {
      localStorage.removeItem("clicky." + k);
    } catch {
      /* non-fatal */
    }
  },
};

/** UTC day key, e.g. "2026-07-27". Used so both players agree regardless of timezone. */
export function utcDayKey(ms) {
  const d = new Date(ms);
  return (
    d.getUTCFullYear() +
    "-" +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getUTCDate()).padStart(2, "0")
  );
}

/** Escape text destined for innerHTML. */
export function esc(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

/** Format a UTC hour number as a local-time range like "14:00–15:00". */
export function utcHourToLocalRange(dayKey, utcHour) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d, utcHour, 0, 0));
  const end = new Date(start.getTime() + 3600000);
  const t = (dt) =>
    String(dt.getHours()).padStart(2, "0") + ":" + String(dt.getMinutes()).padStart(2, "0");
  return `${t(start)}–${t(end)}`;
}
