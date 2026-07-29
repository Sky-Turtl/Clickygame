// Clicky — app shell, rendering, and the multi-game claim fan-out.

import {
  DUEL_TIMEOUT_MS,
  isConfigured,
  MIN_CLAIM_INTERVAL_MS,
  NOTIFY_CLAIM_MIN_SECONDS,
  TIE_WINDOW_MS,
} from "./config.js";
import * as discord from "./discord.js";
import {
  DUEL_META,
  PERIODS,
  THROW_EMOJI,
  THROWS,
  doubleHoursFor,
  maxClaimable,
  multiplierAt,
  summarize,
  unwinnableAt,
  windowStatus,
} from "./rules.js";
import {
  esc,
  fmtAgo,
  fmtDuration,
  fmtDurationShort,
  localPlayerId,
  makeGameCode,
  store,
  utcDayKey,
  utcHourToLocalRange,
} from "./util.js";
import { BUCKETS, bucketOHLC, claimRows, groupRuns, sortRows, suggestBucket } from "./series.js";
import { barChart, candleChart, leadArea, legend } from "./charts.js";
import { buildExport, countdownToClaims, parseImport } from "./importer.js";
import { mountGolf, mountGolfReplay } from "./golf.js";
import { setForcedGame } from "./engine.js";

const $ = (id) => document.getElementById(id);

// `?demo` runs the whole game against an in-memory store with a practice bot —
// no Firebase, and no risk of writing to a real game while testing.
//
// The store is picked here rather than in a separate demo page. dev/index.html
// used to be a copy of this app's HTML, which silently went stale every time
// index.html changed; a dynamic import keeps one page and one source of truth.
// Nothing under dev/ is fetched unless ?demo is present.
const IS_DEMO = new URLSearchParams(location.search).has("demo");
if (IS_DEMO) globalThis.CLICKY_DEMO = true;
// ?demo&game=golf forces every duel to that minigame, so it can be
// play-tested against the bot without racing for a random one.
if (IS_DEMO) setForcedGame(new URLSearchParams(location.search).get("game"));
const db = IS_DEMO ? await import("../dev/mock-store.js") : await import("./store.js");

// --- App state --------------------------------------------------------------

const me = {
  id: localPlayerId(),
  name: store.get("name", ""),
  discordId: store.get("discordId", ""),
};

/**
 * Local roster: which games this browser has joined, and which are synced.
 *
 * `playerId` is per game because the same person can play from several devices:
 * joining with a name already in the game adopts that game's existing id rather
 * than taking the second seat. `me.id` is only the fallback for a game this
 * device created or joined first.
 */
// Demo games get their own roster key so a browser's real games and its
// throwaway demo games never bleed into each other's "My games" list.
const ROSTER_KEY = IS_DEMO ? "demoRoster" : "roster";
let roster = store.get(ROSTER_KEY, []); // [{ code, synced, playerId }]

/** This device's player id in a given game. */
const myIdIn = (code) => roster.find((r) => r.code === code)?.playerId || me.id;
const myId = (g) => myIdIn(g?.code);

/** Live mirror of each game, keyed by code. */
const games = new Map(); // code -> { meta, players, presence, state, claims, unwatch }

let currentDetail = null; // code of the game open on the detail screen
let claiming = false;
/** Duels already announced/toasted locally, so we don't repeat on every render. */
const seenDuels = new Set();
const seenResults = new Set();
/** code -> id of the currently-open duel, so a void (duel node cleared with no
 * resolution) can be told apart from a normal resolved-then-dismissed duel. */
const openDuelIds = new Map();
/** Games whose first state snapshot has been processed — see onStateChange. */
const primedGames = new Set();
let lastWindowState = new Map(); // code -> boolean (was 2x active last tick)
let lastClaimIds = new Map(); // code -> last claim id we've already put in the feed

// Chart controls
let clickSort = store.get("clickSort", "time"); // "time" | "size"
let leadStyle = store.get("leadStyle", "area"); // "area" | "candle"
let bucketKey = store.get("bucketKey", "1h");
/** Click-to-zoom on the "who's winning" chart: {start, end} in ms, or null for the full view. */
let leadZoom = null;

// --- Boot -------------------------------------------------------------------

(async function boot() {
  wireSetup();
  wireHub();
  wireDetail();
  wireModals();
  wireAccount();

  if (!isConfigured()) {
    $("config-warning").classList.remove("hidden");
    document.querySelectorAll("#panel-new button, #panel-join button").forEach(
      (b) => (b.disabled = true)
    );
    return;
  }

  await db.init();
  db.onConnectionChange((online) => {
    const dot = $("conn-dot");
    dot.classList.toggle("online", online);
    dot.classList.toggle("offline", !online);
    dot.title = online ? "Connected" : "Reconnecting…";
  });
  db.onAuthChange(onAccountChange);

  // Deep link: ?g=ABC123 prefills the join form.
  const linked = new URLSearchParams(location.search).get("g");
  if (linked) {
    switchTab("join");
    $("join-code").value = linked.toUpperCase();
  }

  // The demo store is in-memory only, so it's wiped on every refresh — drop
  // any roster entries left pointing at games that no longer exist rather
  // than showing them as stuck/empty.
  if (IS_DEMO) {
    const alive = [];
    for (const entry of roster) {
      if (await db.gameExists(entry.code)) alive.push(entry);
    }
    if (alive.length !== roster.length) {
      roster = alive;
      store.set(ROSTER_KEY, roster);
    }
  }

  for (const entry of roster) watchGameCode(entry.code);

  if (roster.length) showScreen("hub");
  else showScreen("setup");

  setInterval(tick, 200);
  tick();
})();

// --- Screens ----------------------------------------------------------------

function showScreen(which) {
  for (const s of ["setup", "hub", "detail", "profile"]) {
    $("screen-" + s).classList.toggle("hidden", s !== which);
  }
  window.scrollTo(0, 0);
  if (which === "setup") renderRejoin();
  if (which === "profile") renderProfile();
}

/** The main screen: the hub once you're in a game, otherwise setup. */
function goHome() {
  currentDetail = null;
  showScreen(roster.length ? "hub" : "setup");
  render();
}

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.innerHTML = msg;
  $("toast-host").appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 320);
  }, 4200);
}

// --- Setup screen -----------------------------------------------------------

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $("panel-new").classList.toggle("active", name === "new");
  $("panel-join").classList.toggle("active", name === "join");
  $("panel-account").classList.toggle("active", name === "account");
}

function wireSetup() {
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => switchTab(t.dataset.tab))
  );

  // Default the deadline to 30 days out.
  const d = new Date(Date.now() + 30 * 86400e3);
  $("new-enddate").value =
    d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  $("new-enddate").min = new Date(Date.now() + 3600e3).toISOString().slice(0, 10);

  if (me.name) {
    $("new-name").value = me.name;
    $("join-name").value = me.name;
  }

  let previewTimer;
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updateImportPreview, 250);
  };
  $("new-import").addEventListener("input", schedulePreview);
  $("new-name").addEventListener("input", schedulePreview);
  $("new-enddate").addEventListener("change", schedulePreview);

  $("panel-new").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("new-error");
    err.classList.add("hidden");
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;

    try {
      const name = $("new-name").value.trim();
      if (!name) throw new Error("Pick a name first.");

      const dateStr = $("new-enddate").value;
      if (!dateStr) throw new Error("Choose an end date.");
      const [y, m, dd] = dateStr.split("-").map(Number);
      // 23:59:59 local time on the chosen day.
      const endsAt = new Date(y, m - 1, dd, 23, 59, 59, 999).getTime();
      if (endsAt <= db.now()) throw new Error("The end date has to be in the future.");

      saveProfile(name, $("new-discordid").value.trim());

      // Imported history, if any. Parsed here so a bad paste fails before we
      // create anything.
      const seed = buildSeed($("new-import").value, endsAt, name);
      if (seed?.error) throw new Error(seed.error);

      // Vanishingly unlikely, but don't stomp an existing game.
      let code = makeGameCode();
      for (let i = 0; i < 5 && (await db.gameExists(code)); i++) code = makeGameCode();

      await db.createGame({
        code,
        name: $("new-gamename").value.trim(),
        webhook: $("new-webhook").value.trim(),
        endsAt,
        player: me,
        seed: seed?.data,
      });

      addToRoster(code, me.id);
      watchGameCode(code);
      showScreen("hub");
      toast(`Game <strong>${code}</strong> created. Send that code to your opponent.`, "good");
    } catch (ex) {
      err.textContent = ex.message || "Something went wrong.";
      err.classList.remove("hidden");
    } finally {
      btn.disabled = false;
    }
  });

  $("panel-join").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("join-error");
    err.classList.add("hidden");
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;

    try {
      const code = $("join-code").value.trim().toUpperCase();
      const name = $("join-name").value.trim();
      if (!name) throw new Error("Pick a name first.");
      if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error("Game codes are 6 letters and numbers.");
      if (roster.some((r) => r.code === code)) throw new Error("You're already in that game.");
      if (!(await db.gameExists(code))) throw new Error("No game with that code.");

      saveProfile(name, $("join-discordid").value.trim());
      const playerId = await db.joinGame({ code, player: me });

      addToRoster(code, playerId);
      watchGameCode(code);
      showScreen("hub");
      toast(`Joined <strong>${code}</strong>. Your clicks now count here too.`, "good");
      $("join-code").value = "";
    } catch (ex) {
      err.textContent = ex.message || "Couldn't join that game.";
      err.classList.remove("hidden");
    } finally {
      btn.disabled = false;
    }
  });
}

/**
 * Parse the import textarea into the shape store.createGame wants.
 *
 * Slot 0 is always you. If the log names you second, the slots are swapped so
 * the history lands on the right player — matching on the name you typed.
 *
 * @returns null (nothing pasted) | {error} | {data, summary}
 */
function buildSeed(text, endsAt, myName) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const parsed = parseImport(raw);
  if (!parsed.ok) return { error: parsed.error };

  let players = parsed.players;
  let claims = parsed.claims;
  let firstUnknown = false;
  let total = null;

  if (parsed.kind === "countdown") {
    // The log counted down to some instant, which is not necessarily this
    // game's deadline — importing the same history into games with different
    // end dates has to keep the original anchor.
    const anchorRaw = $("new-anchor").value;
    const anchorMs = anchorRaw ? new Date(anchorRaw).getTime() : endsAt;
    if (anchorRaw && !Number.isFinite(anchorMs)) {
      return { error: "Couldn't read the 'counted down to' date." };
    }
    const totalRaw = $("new-total").value.trim().replace(/[, ]/g, "");
    const totalOverride = totalRaw ? Number(totalRaw) : undefined;
    if (totalRaw && !(Number.isFinite(totalOverride) && totalOverride > 0)) {
      return { error: "'Starting seconds' must be a positive number." };
    }

    const conv = countdownToClaims(parsed, anchorMs, totalOverride);
    players = conv.players;
    claims = conv.claims;
    firstUnknown = conv.firstUnknown;
    total = conv.total;
  }

  // Put whoever matches the creator's name in slot 0.
  const mineIdx = players.findIndex((p) => p.name.toLowerCase() === myName.trim().toLowerCase());
  if (mineIdx > 0) {
    players = [players[mineIdx], ...players.filter((_, i) => i !== mineIdx)];
    if (claims) claims = claims.map((c) => ({ ...c, slot: c.slot === mineIdx ? 0 : 1 }));
  }

  return {
    data: { players, claims },
    summary: {
      players,
      claimCount: claims?.length ?? 0,
      kind: parsed.kind,
      firstUnknown,
      total,
      matchedName: mineIdx >= 0,
      firstAt: claims?.length ? Math.min(...claims.map((c) => c.at)) : null,
      lastAt: claims?.length ? Math.max(...claims.map((c) => c.at)) : null,
    },
  };
}

/** Live feedback under the import box, so a bad paste is obvious before submit. */
function updateImportPreview() {
  const box = $("import-preview");
  const raw = $("new-import").value.trim();
  if (!raw) {
    box.classList.add("hidden");
    return;
  }

  const dateStr = $("new-enddate").value;
  let endsAt = db.now() + 30 * 86400e3;
  if (dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    endsAt = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
  }

  const seed = buildSeed(raw, endsAt, $("new-name").value || "");
  box.classList.remove("hidden");

  if (!seed || seed.error) {
    box.className = "import-preview bad";
    box.innerHTML = `⚠ ${esc(seed?.error || "Couldn't read that.")}`;
    return;
  }

  const s = seed.summary;
  const span =
    s.firstAt && s.lastAt
      ? `<div class="ip-note">Spans ${new Date(s.firstAt).toLocaleString()} → ` +
        `${new Date(s.lastAt).toLocaleString()}${
          s.total ? `, from a ${fmtDuration(s.total)} countdown` : ""
        }.</div>`
      : "";

  box.className = "import-preview good";
  box.innerHTML =
    `✓ Read ${s.claimCount ? `<strong>${s.claimCount}</strong> clicks` : "totals"} for ` +
    s.players.map((p) => `<strong>${esc(p.name)}</strong> ${fmtDuration(p.seconds)}`).join(" vs ") +
    span +
    (s.players.length > 1
      ? `<div class="ip-note">${esc(s.players[0].name)} is you; ` +
        `${esc(s.players[1].name)}'s history is applied when they join with the game code.</div>`
      : "") +
    (s.firstUnknown
      ? `<div class="ip-note">No percentages found, so the time before the first row ` +
        `couldn't be worked out — that first click counts as 0.</div>`
      : "") +
    (!s.matchedName && $("new-name").value.trim()
      ? `<div class="ip-note">Your name isn't in the log, so the first listed player is ` +
        `treated as you.</div>`
      : "");
}

function saveProfile(name, discordId) {
  me.name = name;
  me.discordId = discordId || "";
  store.set("name", me.name);
  store.set("discordId", me.discordId);
}

// --- Roster -----------------------------------------------------------------

/** Save the roster locally, and to the account (if logged in) for other devices. */
function persistRoster() {
  store.set(ROSTER_KEY, roster);
  if (account) db.setAccountRoster(account.uid, rosterToObj(roster));
}

function addToRoster(code, playerId) {
  if (!roster.some((r) => r.code === code)) {
    roster = [...roster, { code, synced: true, playerId }];
    persistRoster();
  }
}

function removeFromRoster(code) {
  roster = roster.filter((r) => r.code !== code);
  persistRoster();
  games.get(code)?.unwatch?.();
  games.delete(code);
  if (!roster.length) showScreen("setup");
}

function isSynced(code) {
  return roster.find((r) => r.code === code)?.synced !== false;
}

function toggleSync(code) {
  roster = roster.map((r) => (r.code === code ? { ...r, synced: !isSynced(code) } : r));
  persistRoster();
  render();
}

function watchGameCode(code) {
  if (games.has(code)) return;
  const g = { code, meta: null, players: {}, presence: {}, state: {}, claims: [] };
  games.set(code, g);
  g.unwatch = db.watchGame(code, (patch) => {
    Object.assign(g, patch);
    if (patch.state) onStateChange(g);
    if (patch.claims) onClaimsChange(g);
    render();
  });
  db.trackPresence(code, myIdIn(code));
}

// --- Account (optional cross-device login) -----------------------------------

let account = null; // { uid, username } | null
let unwatchAccountRoster = null;

function rosterToObj(list) {
  const obj = {};
  for (const r of list) obj[r.code] = { synced: r.synced !== false, playerId: r.playerId };
  return obj;
}

function objToRoster(obj) {
  return Object.entries(obj || {}).map(([code, v]) => ({
    code,
    synced: v?.synced !== false,
    playerId: v?.playerId,
  }));
}

/**
 * Fires on login/logout. Logging in merges whatever this device already had
 * (games joined as a guest) into the account's roster, then treats the
 * account as the source of truth going forward — the whole point being that
 * logging in on a second device picks up every game from the first.
 */
async function onAccountChange(acct) {
  account = acct;
  renderAccountUI();

  unwatchAccountRoster?.();
  unwatchAccountRoster = null;
  if (!acct) return;

  const serverObj = await db.getAccountRoster(acct.uid);
  const mine = rosterToObj(roster.filter((r) => !serverObj[r.code]));
  const merged = { ...serverObj, ...mine };
  await db.setAccountRoster(acct.uid, merged);

  roster = objToRoster(merged);
  store.set(ROSTER_KEY, roster);
  for (const r of roster) watchGameCode(r.code);

  // Land on the hub if logging in surfaced games and we're just sitting on
  // setup — but don't yank the screen out from under someone mid-game.
  const onSetup = !$("screen-setup").classList.contains("hidden");
  if (roster.length && onSetup) showScreen("hub");

  // Other devices on the same account joining/leaving games shows up here too.
  unwatchAccountRoster = db.watchAccountRoster(acct.uid, (obj) => {
    let changed = false;
    for (const code of Object.keys(obj)) {
      if (!roster.some((r) => r.code === code)) {
        roster = [...roster, { code, synced: obj[code].synced !== false, playerId: obj[code].playerId }];
        watchGameCode(code);
        changed = true;
      }
    }
    if (changed) {
      store.set(ROSTER_KEY, roster);
      render();
    }
  });

  render();
}

/** Reflect login state in the setup tab, hub topbar button, and profile screen. */
function renderAccountUI() {
  $("account-logged-out").classList.toggle("hidden", !!account);
  $("account-logged-in").classList.toggle("hidden", !account);
  if (account) $("account-username-display").textContent = account.username;

  const btn = $("btn-account");
  if (btn) btn.textContent = account ? "👤 " + account.username : "👤";

  if (!$("screen-profile").classList.contains("hidden")) renderProfile();
}

/** win / loss / tie / ongoing, from this device's point of view. */
function gameResult(g) {
  const ids = Object.keys(g.players || {});
  if (!isOver(g) || ids.length < 2) return "ongoing";
  const { rows } = totalsFor(g);
  const mine = rows[myId(g)]?.all.claimed || 0;
  const opp = opponentOf(g);
  const theirs = opp ? rows[opp.id]?.all.claimed || 0 : 0;
  if (mine === theirs) return "tie";
  return mine > theirs ? "win" : "loss";
}

function renderProfile() {
  if (!account) {
    showScreen(roster.length ? "hub" : "setup");
    return;
  }
  $("profile-username").textContent = account.username;

  const list = roster.map((r) => games.get(r.code)).filter((g) => g && g.meta);
  const results = list.map((g) => ({ g, result: gameResult(g) }));
  const count = (r) => results.filter((x) => x.result === r).length;
  const wins = count("win");
  const losses = count("loss");
  const ties = count("tie");
  const ongoing = count("ongoing");

  $("profile-record").innerHTML = [
    ["Wins", String(wins)],
    ["Losses", String(losses)],
    ["Ties", String(ties)],
    ["Ongoing", String(ongoing)],
  ]
    .map(
      ([l, v]) =>
        `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${v}</div></div>`
    )
    .join("");

  $("profile-games").innerHTML =
    results
      .map(({ g, result }) => {
        const { rows } = totalsFor(g);
        const opp = opponentOf(g);
        const mine = rows[myId(g)]?.all.claimed || 0;
        const theirs = opp ? rows[opp.id]?.all.claimed || 0 : 0;
        return `
        <div class="game-card" data-open="${esc(g.code)}">
          <div class="gc-main">
            <div class="gc-head">
              <span class="gc-name">${esc(gameLabel(g))}</span>
              <span class="gc-flag ${result}">${result.toUpperCase()}</span>
            </div>
            <div class="gc-scores">
              <span class="gc-me">You ${fmtDurationShort(mine)}</span>
              <span class="gc-them">${opp ? `${esc(opp.name)} ${fmtDurationShort(theirs)}` : "waiting for player 2"}</span>
            </div>
          </div>
        </div>`;
      })
      .join("") || `<p class="card-sub">No games yet.</p>`;

  $("profile-games").querySelectorAll("[data-open]").forEach((el) =>
    el.addEventListener("click", () => openDetail(el.dataset.open))
  );

  renderMinigameRecord(list);
}

const MINIGAME_PERIODS = [
  { key: "1d", label: "Today", ms: 24 * 3600e3 },
  { key: "1w", label: "This week", ms: 7 * 24 * 3600e3 },
  { key: "1mo", label: "This month", ms: 30 * 24 * 3600e3 },
  { key: "all", label: "All time", ms: Infinity },
];

/**
 * Wins/losses in contested-claim duels, from claims settled `viaDuel`.
 * The winner's claim carries `game` (which minigame decided it) and `by`
 * (the winner) — since every game is strictly 1v1, any such claim not by me
 * in a game I'm part of is a loss for me. Older duels settled before this
 * field existed have no `.game` at all, so they only count under "All
 * minigames" — picking a specific minigame can't include them, since there's
 * nothing recorded to match against.
 */
function renderMinigameRecord(list) {
  const minigameSel = $("profile-minigame-filter");
  if (minigameSel.dataset.sig !== "set") {
    minigameSel.dataset.sig = "set";
    minigameSel.innerHTML =
      `<option value="__all__">All minigames</option>` +
      Object.entries(DUEL_META)
        .map(([key, meta]) => `<option value="${key}">${meta.icon} ${esc(meta.label)}</option>`)
        .join("");
  }
  const minigameFilter = minigameSel.value || "__all__";

  // Rebuilt whenever the set of games actually changes, same pattern as the
  // hub's stats-scope selector — so it isn't yanked out from under a pick.
  const gameSel = $("profile-game-filter");
  const gameSig = list.map((g) => `${g.code}:${gameLabel(g)}`).join("|");
  if (gameSel.dataset.sig !== gameSig) {
    const keep = gameSel.value;
    gameSel.dataset.sig = gameSig;
    gameSel.innerHTML =
      `<option value="__all__">All games</option>` +
      list.map((g) => `<option value="${esc(g.code)}">${esc(gameLabel(g))}</option>`).join("");
    if (keep && [...gameSel.options].some((o) => o.value === keep)) gameSel.value = keep;
  }
  const gameFilter = gameSel.value || "__all__";

  const now = db.now();
  const grid = {}; // periodKey -> { wins, losses }
  for (const p of MINIGAME_PERIODS) grid[p.key] = { wins: 0, losses: 0 };
  let unknownCount = 0;

  for (const g of list) {
    if (gameFilter !== "__all__" && g.code !== gameFilter) continue;
    const meId = myId(g);
    const opp = opponentOf(g);
    if (!opp) continue;
    for (const c of g.claims || []) {
      if (!c.viaDuel || c.status !== "settled") continue;
      const gameType = c.game || null;
      if (!gameType) unknownCount++;
      if (minigameFilter !== "__all__" && gameType !== minigameFilter) continue;
      const won = c.by === meId;
      if (!won && c.by !== opp.id) continue; // shouldn't happen in a 1v1, but don't misattribute
      const age = now - c.at;
      for (const p of MINIGAME_PERIODS) {
        if (age > p.ms) continue;
        if (won) grid[p.key].wins++;
        else grid[p.key].losses++;
      }
    }
  }

  const head = `<thead><tr><th>Period</th><th>Wins</th><th>Losses</th><th>Win%</th></tr></thead>`;
  const body =
    `<tbody>` +
    MINIGAME_PERIODS.map((p) => {
      const { wins, losses } = grid[p.key];
      const total = wins + losses;
      const pct = total ? `${Math.round((wins / total) * 100)}%` : "—";
      return `<tr><td>${p.label}</td><td class="num">${wins}</td><td class="num">${losses}</td><td class="num">${pct}</td></tr>`;
    }).join("") +
    `</tbody>`;

  setHTML("profile-minigame-table", head + body);

  const noteEl = $("profile-minigame-unknown-note");
  const showNote = minigameFilter !== "__all__" && unknownCount > 0;
  noteEl.classList.toggle("hidden", !showNote);
  if (showNote) {
    setHTML(
      "profile-minigame-unknown-note",
      `${unknownCount} duel${unknownCount === 1 ? "" : "s"} in this scope ${
        unknownCount === 1 ? "doesn't" : "don't"
      } have a minigame type recorded (from before minigame variety shipped) and won't show up under a specific minigame — only under "All minigames".`
    );
  }
}

// --- Derived helpers --------------------------------------------------------

const isOver = (g) => !!g.meta?.endsAt && db.now() > g.meta.endsAt;

/**
 * The name to show for "them" across a set of games.
 *
 * With one opponent across every game in scope — the usual case — that's just
 * their name. Only falls back to a generic label when the games genuinely have
 * different opponents, or nobody has joined yet.
 */
function opponentLabel(list) {
  const names = new Set();
  for (const g of list) {
    const opp = opponentOf(g);
    if (opp?.name) names.add(opp.name);
  }
  if (names.size === 1) return { name: [...names][0], real: true };
  return { name: list.length === 1 ? "Opponent" : "Opponents", real: false };
}

/** The other player, or null while a game is still waiting for one. */
function opponentOf(g) {
  const id = Object.keys(g.players || {}).find((p) => p !== myId(g));
  return id ? { id, ...g.players[id] } : null;
}

function totalsFor(g) {
  const ids = Object.keys(g.players || {});
  // While a duel is unresolved its disputed claim is still marked 'settled' in
  // the database (see store.claim). Nobody owns that time yet, so hide it.
  const escrowed = duelUnsettled(g.state?.duel) ? g.state.duel.disputedClaimId : null;
  const claims = escrowed ? (g.claims || []).filter((c) => c.id !== escrowed) : g.claims || [];
  const rows = summarize(claims, ids, db.now());
  return { ids, rows };
}

/** Seconds currently sitting on this game's clock, unclaimed. */
function onClock(g) {
  if (!g.state?.lastClaimAt) return 0;
  const end = isOver(g) ? g.meta.endsAt : db.now();
  return Math.max(0, (end - g.state.lastClaimAt) / 1000);
}

/**
 * How much real time is left before the current lead in `g` becomes
 * mathematically unwinnable — i.e. the trailing player could no longer close
 * the gap even by claiming every remaining second on the clock. `maxClaimable`
 * already weighs 2x windows between now and the deadline, so both the
 * deadline and the clinch numbers below account for upcoming double-time.
 *
 * The clinch numbers treat the clock as one shared pool: whatever either side
 * claims from now on is time the other side can no longer also claim. So if I
 * bank `youNeed` more (on top of my current lead), even the opponent taking
 * every remaining second still can't catch up — same idea as an elimination
 * number in sports standings.
 *
 * @returns null when there's no opponent/game-over/dead tie, otherwise
 *   { forMe, leftMs, final, youNeed, theyNeed }
 *   `forMe` is true when I'm the one who needs to catch up; `final` means the
 *   deficit is already unwinnable right now (leftMs is 0, youNeed/theyNeed
 *   are not meaningful and omitted). `youNeed`/`theyNeed` are extra claimed
 *   seconds — on top of the current totals — that clinch the game outright.
 */
function catchUpWindow(g) {
  if (isOver(g)) return null;
  const opp = opponentOf(g);
  if (!opp) return null;

  const { rows } = totalsFor(g);
  const mine = rows[myId(g)]?.all.claimed || 0;
  const theirs = rows[opp.id]?.all.claimed || 0;
  const lead = mine - theirs;
  if (lead === 0) return null;

  const now = db.now();
  const end = g.meta.endsAt;
  const budget = Math.abs(lead);
  const max = maxClaimable(g.code, now, end);

  if (max < budget) return { forMe: lead < 0, leftMs: 0, final: true };

  const t = unwinnableAt(g.code, budget, now, end);
  return {
    forMe: lead < 0,
    leftMs: Math.max(0, t - now),
    final: false,
    youNeed: Math.max(0, (max - lead) / 2),
    theyNeed: Math.max(0, (max + lead) / 2),
  };
}

/** A duel that still has an undecided outcome — including a coin's double-or-nothing offer. */
function duelUnsettled(d) {
  return !!d && (d.status === "open" || d.status === "double_offer");
}

function openDuelFor(g) {
  const d = g.state?.duel;
  if (!duelUnsettled(d)) return null;
  if (d.challenger !== myId(g) && d.defender !== myId(g)) return null;
  return d;
}

/** Duels I'm in that need an action from me — these block the claim button. */
function pendingThrows() {
  const out = [];
  for (const g of games.values()) {
    const d = openDuelFor(g);
    if (!d) continue;
    if (d.status === "open") {
      const mine = (d.picks || {})[myId(g)];
      if (mine === undefined) out.push({ g, duel: d });
    } else if (d.status === "double_offer" && d.winner === myId(g)) {
      out.push({ g, duel: d });
    }
  }
  return out;
}

/** Milliseconds left on my per-player cooldown in this game (0 if ready). */
function cooldownLeft(g) {
  const mine = g.state?.lastBy?.[myId(g)];
  if (!mine) return 0;
  return Math.max(0, MIN_CLAIM_INTERVAL_MS - (db.now() - mine));
}

/** Games a click would actually land in right now. */
function claimableGames() {
  return roster
    .filter((r) => r.synced !== false)
    .map((r) => games.get(r.code))
    .filter(
      (g) =>
        g &&
        g.meta &&
        !isOver(g) &&
        !duelUnsettled(g.state?.duel) &&
        cooldownLeft(g) === 0
    );
}

/** Synced games blocked purely by the cooldown — used for the countdown label. */
function coolingGames() {
  return roster
    .filter((r) => r.synced !== false)
    .map((r) => games.get(r.code))
    .filter(
      (g) => g && g.meta && !isOver(g) && !duelUnsettled(g.state?.duel) && cooldownLeft(g) > 0
    );
}

// --- The claim action -------------------------------------------------------

async function doClaim() {
  if (claiming) return;

  const blocked = pendingThrows();
  if (blocked.length) {
    openDuelModal();
    return;
  }

  const targets = claimableGames();
  if (!targets.length) return;

  claiming = true;
  $("btn-claim").disabled = true;

  // Fire every game in parallel so the timestamps stay as close together as
  // possible — a synced click should feel like one action, not a queue.
  const results = await Promise.allSettled(targets.map((g) => db.claim(g.code, myId(g))));

  let banked = 0;
  let duels = 0;
  const claimedIn = [];

  results.forEach((res, i) => {
    const g = targets[i];
    if (res.status !== "fulfilled") return;
    const r = res.value;

    if (r.outcome === "claim") {
      banked += r.claim.seconds;
      claimedIn.push({ g, claim: r.claim });
      // Small claims aren't worth a ping — a fast back-and-forth would spam the
      // channel with a message per click.
      if (r.claim.seconds >= NOTIFY_CLAIM_MIN_SECONDS) {
        discord.notifyClaim(g.meta?.webhook, {
          actor: { name: me.name, discordId: me.discordId },
          opponent: opponentOf(g),
          seconds: r.claim.seconds,
          multiplier: r.claim.multiplier,
          gameCode: g.code,
        });
      }
    } else if (r.outcome === "duel") {
      duels++;
    }
  });

  claiming = false;
  render();

  if (banked > 0) {
    const where =
      claimedIn.length === 1
        ? esc(gameLabel(claimedIn[0].g))
        : `${claimedIn.length} games`;
    toast(`Claimed <strong>${fmtDuration(banked)}</strong> across ${where}.`, "good");
  }
  if (duels > 0) {
    toast(`⚔️ Contested in ${duels} game${duels > 1 ? "s" : ""} — throw to settle.`, "warn");
    openDuelModal();
  }
  if (!banked && !duels) toast("Nothing landed — the clock had just been claimed.", "");
}

// --- Reacting to remote changes ---------------------------------------------

function onStateChange(g) {
  const d = g.state?.duel;

  // The first state snapshot for a game reflects whatever was already true
  // before this session started — an open or resolved duel from before the
  // page loaded, not a fresh event. Mark it seen (and dismissed, if already
  // resolved) without popping a modal, the same way onClaimsChange skips the
  // first claims batch.
  if (!primedGames.has(g.code)) {
    primedGames.add(g.code);
    if (d?.status === "open") {
      seenDuels.add(d.id);
      openDuelIds.set(g.code, d.id);
    }
    if (d?.status === "resolved") {
      seenResults.add(d.id);
      dismissedResults.add(d.id);
    }
    return;
  }

  if (!d) {
    // A duel that was open just vanished with no resolution — timed out with
    // nobody responding, so the disputed period was voided and the clock
    // rewound rather than settled. (A normal win keeps the duel node around,
    // resolved, until someone dismisses the modal.)
    const openId = openDuelIds.get(g.code);
    if (openId && !seenResults.has(openId)) {
      toast(`⚔️ A contested claim in ${esc(gameLabel(g))} went unanswered — voided, time returned to the clock.`, "warn");
    }
    openDuelIds.delete(g.code);
    return;
  }

  if (d.status === "open") openDuelIds.set(g.code, d.id);

  // A duel I'm in just opened.
  if (d.status === "open" && !seenDuels.has(d.id)) {
    seenDuels.add(d.id);
    // Deliberately no Discord post — duels are handled entirely in the app, so
    // neither player learns about a contested claim from a phone notification.
    if (d.challenger === myId(g) || d.defender === myId(g)) openDuelModal();
  }

  // Both picks are in — race to settle it. The transaction picks one winner.
  if (d.status === "open" && d.picks?.[d.challenger] !== undefined && d.picks?.[d.defender] !== undefined) {
    // Settle it, but say nothing to Discord — the result belongs in the app, so
    // neither of you learns who won from a phone notification.
    db.trySettleDuel(g.code, d.id);
  }

  if (d.status === "resolved" && !seenResults.has(d.id)) {
    seenResults.add(d.id);
    if (d.challenger === myId(g) || d.defender === myId(g)) renderDuelModal();
  }
}

function onClaimsChange(g) {
  const latest = (g.claims || []).filter((c) => c.status === "settled").at(-1);
  // Mark the game as seen even when it has no claims yet, so that the *first*
  // claim of a brand-new game still notifies rather than being mistaken for
  // pre-existing history.
  const seenBefore = lastClaimIds.has(g.code);
  const prev = lastClaimIds.get(g.code);
  lastClaimIds.set(g.code, latest?.id ?? null);
  if (!latest) return;

  // Only surface the *other* player's claims, and never replay history on load.
  if (seenBefore && latest.id !== prev && latest.by !== myId(g)) {
    const who = g.players?.[latest.by]?.name || "Someone";
    toast(
      `<strong>${esc(who)}</strong> claimed ${fmtDuration(latest.seconds)} in ` +
        `${esc(gameLabel(g))}.`,
      "warn"
    );
  }
}



/** Watch for 2x windows opening and closing, and announce the transition once. */
async function checkWindows(g) {
  if (isOver(g)) return;
  const active = multiplierAt(g.code, db.now()) > 1;
  const was = lastWindowState.get(g.code);
  lastWindowState.set(g.code, active);
  if (was === undefined || was === active) return;

  const dayKey = utcDayKey(db.now());
  const hour = new Date(db.now()).getUTCHours();
  const key = `2x-${dayKey}-${active ? hour : (hour + 23) % 24}-${active ? "open" : "close"}`;
  if (!(await db.claimAnnouncement(g.code, key))) return;

  discord.notifyWindow(g.meta?.webhook, {
    opening: active,
    gameCode: g.code,
    players: Object.values(g.players || {}),
    localRange: utcHourToLocalRange(dayKey, active ? hour : (hour + 23) % 24),
  });
  if (active) toast(`🔥 <strong>2x is live</strong> in ${esc(gameLabel(g))} for the next hour.`, "warn");
}

// --- Rendering --------------------------------------------------------------

function gameLabel(g) {
  return g.meta?.name?.trim() || g.code;
}

/** mm:ss countdown display — unlike fmtDurationShort, always shows seconds. */
function fmtCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function tick() {
  for (const g of games.values()) {
    checkWindows(g);
    checkDuelExpiry(g);
    checkReactionGate(g);
  }
  render();
}

/** code -> id of the last "am I clear to start reaction" value this client reported for a duel. */
const reactionClearReported = new Map();

/**
 * A reaction duel waits on both sides reporting they've got no other open
 * duel elsewhere before its goAt is set (see engine.applyStartReaction). Each
 * client can only speak for its own player, and only this device knows what
 * other games its own player is in — so it self-reports here.
 */
function checkReactionGate(g) {
  const d = g.state?.duel;
  if (!d || d.status !== "open" || d.game !== "reaction") return;
  if (d.goAt) {
    reactionClearReported.delete(d.id); // started — no longer relevant, keep the map from growing
    return;
  }
  const meId = myId(g);
  if (d.challenger !== meId && d.defender !== meId) return;

  const iAmClear = !hasOtherOpenDuel(g.code, d.id);
  if (reactionClearReported.get(d.id) === iAmClear) return;
  reactionClearReported.set(d.id, iAmClear);
  db.checkReactionStart(g.code, d.id, meId, iAmClear);
}

/** Is this device's own player still tied up in some other unsettled duel? */
function hasOtherOpenDuel(excludeCode, excludeDuelId) {
  for (const g2 of games.values()) {
    const d2 = g2.state?.duel;
    if (!d2 || d2.id === excludeDuelId) continue;
    if (!duelUnsettled(d2)) continue;
    const pid2 = myId(g2);
    if (d2.challenger === pid2 || d2.defender === pid2) return true;
  }
  return false;
}

/**
 * Every client with the game open races to notice a stale duel — the
 * transaction inside checkDuelTimeout guarantees only one of them actually
 * writes the result. Cheap local pre-check first so an unexpired duel doesn't
 * fire a transaction every 200ms.
 */
function checkDuelExpiry(g) {
  const d = g.state?.duel;
  if (!d) return;
  if (d.status !== "open" && d.status !== "double_offer") return;

  const startedAt = d.status === "double_offer" ? d.decidedAt : d.roundStartAt || d.createdAt;
  if (db.now() - startedAt < DUEL_TIMEOUT_MS) return;

  db.checkDuelTimeout(g.code, d.id);
}

function render() {
  if (!$("screen-setup").classList.contains("hidden")) renderRejoin();
  if (!$("screen-hub").classList.contains("hidden")) renderHub();
  if (!$("screen-detail").classList.contains("hidden")) renderDetail();
  if (!$("screen-profile").classList.contains("hidden")) renderProfile();
  $("brand-logo").classList.toggle("clickable", roster.length > 0);
  renderDuelModal();
}

function renderHub() {
  const targets = claimableGames();
  const cooling = coolingGames();
  const blocked = pendingThrows();
  // The clock keeps ticking during a cooldown, so keep those games in the total.
  const shown = targets.length ? targets : cooling;
  const totalOnClock = shown.reduce((sum, g) => sum + onClock(g), 0);
  const anyHot = shown.some((g) => multiplierAt(g.code, db.now()) > 1);

  $("clock").textContent = fmtDuration(totalOnClock);
  $("clock").classList.toggle("hot", anyHot);

  const syncedCount = roster.filter((r) => r.synced !== false).length;
  // With several games synced this is the SUM of their clocks, so it climbs by
  // one second per game per second. Say so — otherwise it just reads as time
  // running fast.
  $("clock-label").textContent =
    shown.length > 1
      ? `On the clock — ${shown.length} games combined (${shown.length}s per second)`
      : "On the clock";

  const hotGames = shown.filter((g) => multiplierAt(g.code, db.now()) > 1);
  $("clock-sub").innerHTML = hotGames.length
    ? `⚡ 2x active in ${hotGames.map((g) => esc(gameLabel(g))).join(", ")}`
    : targets.length
      ? "Claim it before they do."
      : "";

  const btn = $("btn-claim");
  const note = $("claim-note");
  btn.classList.toggle("hot", anyHot && !blocked.length);

  if (blocked.length) {
    btn.disabled = false;
    btn.querySelector(".btn-claim-text").textContent = "DUEL TO CONTINUE";
    $("btn-claim-sub").textContent = `${blocked.length} duel${blocked.length > 1 ? "s" : ""} waiting on you`;
    note.textContent = "Claiming is locked until you've made your move in the duel.";
  } else if (!targets.length && cooling.length) {
    // Nothing to claim into only because the cooldown is still running.
    const left = Math.max(...cooling.map(cooldownLeft));
    btn.disabled = true;
    btn.classList.remove("hot");
    btn.querySelector(".btn-claim-text").textContent = (left / 1000).toFixed(1) + "s";
    $("btn-claim-sub").textContent = "cooling down";
    note.textContent = `You have to wait ${MIN_CLAIM_INTERVAL_MS / 1000}s between your own claims. Your opponent doesn't.`;
  } else if (!targets.length) {
    btn.disabled = true;
    btn.querySelector(".btn-claim-text").textContent = "CLAIM";
    $("btn-claim-sub").textContent = syncedCount ? "" : "no games synced";
    note.textContent = syncedCount
      ? "Every synced game is finished or settling."
      : "Turn on sync for at least one game.";
  } else {
    btn.disabled = claiming;
    btn.querySelector(".btn-claim-text").textContent = "CLAIM";
    $("btn-claim-sub").textContent =
      targets.length > 1 ? `banks into ${targets.length} games` : "";
    note.textContent = "";
  }

  $("sync-hint").textContent = `${syncedCount} of ${roster.length} synced`;
  renderHubStats();

  // Banners
  const banners = [];
  for (const g of games.values()) {
    if (isOver(g)) {
      const { ids, rows } = totalsFor(g);
      const ranked = ids.sort((a, b) => rows[b].all.claimed - rows[a].all.claimed);
      const winner = ranked[0];
      const tie = ranked.length > 1 && rows[ranked[0]].all.claimed === rows[ranked[1]].all.claimed;
      banners.push(
        `<div class="banner banner-info">🏁 <strong>${esc(gameLabel(g))}</strong> has ended — ` +
          (tie
            ? "it's a dead tie."
            : `<strong>${esc(g.players?.[winner]?.name || "?")}</strong> wins with ${fmtDuration(rows[winner].all.claimed)}.`) +
          `</div>`
      );
    }
  }
  $("hub-banners").innerHTML = banners.join("");

  renderGameList();
}

function renderGameList() {
  const host = $("game-list");
  const html = roster
    .map((entry) => {
      const g = games.get(entry.code);
      if (!g || !g.meta) {
        return `<div class="game-card loading"><div class="gc-name">${esc(entry.code)}</div>
                <div class="gc-sub">loading…</div></div>`;
      }

      const { rows } = totalsFor(g);
      const opp = opponentOf(g);
      const mine = rows[myId(g)]?.all.claimed || 0;
      const theirs = opp ? rows[opp.id]?.all.claimed || 0 : 0;
      const lead = mine - theirs;
      const over = isOver(g);
      const hot = !over && multiplierAt(g.code, db.now()) > 1;
      const duel = openDuelFor(g);
      const synced = entry.synced !== false;
      const oppOnline = opp && g.presence?.[opp.id]?.online;

      const remain = g.meta.endsAt - db.now();
      const deadline = over
        ? "ended"
        : remain < 86400e3
          ? `${Math.max(0, Math.floor(remain / 3600e3))}h left`
          : `${Math.ceil(remain / 86400e3)}d left`;

      // One clear line per card: what this specific game is waiting on right
      // now. With several games synced at once, this is the thing that's hard
      // to tell apart otherwise — ready vs cooling vs blocked vs unsynced.
      const cdLeft = cooldownLeft(g);
      let status = null; // { cls, text }
      if (over) {
        status = null;
      } else if (duel) {
        status = { cls: "wait", text: "⚔ Your throw is needed" };
      } else if (!opp) {
        status = { cls: "wait", text: "Waiting for player 2 to join" };
      } else if (!synced) {
        status = { cls: "off", text: "Not synced — clicks skip this game" };
      } else if (cdLeft > 0) {
        status = { cls: "cooling", text: `Ready in ${(cdLeft / 1000).toFixed(1)}s` };
      } else {
        status = { cls: "ready", text: "Ready to claim" };
      }

      const catchUp = over ? null : catchUpWindow(g);
      let catchUpHtml = "";
      if (catchUp) {
        if (catchUp.final) {
          catchUpHtml = catchUp.forMe
            ? `<div class="gc-catchup lost">You can no longer catch up.</div>`
            : `<div class="gc-catchup safe">${esc(opp?.name || "They")} can no longer catch up.</div>`;
        } else if (catchUp.forMe) {
          const urgent = catchUp.leftMs < 3600e3;
          catchUpHtml = `<div class="gc-catchup ${urgent ? "urgent" : ""}">
            ${fmtDuration(catchUp.leftMs / 1000)} left to catch up before it's unwinnable</div>`;
        } else {
          catchUpHtml = `<div class="gc-catchup safe">
            ${esc(opp?.name || "They")} have ${fmtDuration(catchUp.leftMs / 1000)} left to catch up</div>`;
        }
        if (!catchUp.final) {
          // Only the leader has a meaningful clinch number — the trailing
          // side is by definition not yet in a position to lock it in.
          catchUpHtml += catchUp.forMe
            ? `<div class="gc-clinch">${esc(opp?.name || "They")} win outright with ${fmtDuration(catchUp.theyNeed)} more</div>`
            : `<div class="gc-clinch">You win outright with ${fmtDuration(catchUp.youNeed)} more</div>`;
        }
      }

      return `
      <div class="game-card ${over ? "over" : ""} ${duel ? "duel" : ""}" data-code="${esc(g.code)}">
        <div class="gc-main" data-open="${esc(g.code)}">
          <div class="gc-head">
            <span class="gc-name">${esc(gameLabel(g))}</span>
            ${hot ? '<span class="gc-flag hot">2x</span>' : ""}
            ${duel ? '<span class="gc-flag duel">DUEL</span>' : ""}
            ${over ? '<span class="gc-flag over">ENDED</span>' : ""}
          </div>
          <div class="gc-bar">
            <div class="gc-bar-mine" style="width:${
              mine + theirs > 0 ? Math.round((mine / (mine + theirs)) * 100) : 50
            }%"></div>
          </div>
          <div class="gc-scores">
            <span class="gc-me">You ${fmtDurationShort(mine)}</span>
            <span class="gc-lead ${lead >= 0 ? "up" : "down"}">
              ${opp ? (lead === 0 ? "level" : `${lead > 0 ? "+" : "−"}${fmtDurationShort(Math.abs(lead))}`) : "waiting for player 2"}
            </span>
            <span class="gc-them">${
              opp ? `${esc(opp.name)} ${fmtDurationShort(theirs)}` : `code ${esc(g.code)}`
            }<span class="dot ${oppOnline ? "online" : ""}"></span></span>
          </div>
          ${status ? `<div class="gc-status gc-status-${status.cls}">${status.text}</div>` : ""}
          <div class="gc-sub">
            ${over ? "" : `<span class="gc-clock">${fmtDuration(onClock(g))} on the clock</span> · `}${deadline}
          </div>
          ${catchUpHtml}
        </div>
        <button class="sync-toggle ${synced ? "on" : ""}" data-sync="${esc(g.code)}"
                title="${synced ? "Synced — clicks land here" : "Not synced"}"
                ${over ? "disabled" : ""}>
          <span class="knob"></span>
          <span class="sync-label">${synced ? "SYNC" : "OFF"}</span>
        </button>
      </div>`;
    })
    .join("");

  if (host.dataset.sig !== html) {
    host.dataset.sig = html;
    host.innerHTML = html;
    host.querySelectorAll("[data-sync]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSync(b.dataset.sync);
      })
    );
    host.querySelectorAll("[data-open]").forEach((b) =>
      b.addEventListener("click", () => openDetail(b.dataset.open))
    );
  }
}

// --- Rejoin list (setup screen) ---------------------------------------------

/**
 * The setup screen doubles as home, so it lists the games this browser is
 * already in. Reachable via the logo or "+ Game", which is otherwise a one-way
 * trip into the join form.
 */
function renderRejoin() {
  const section = $("rejoin-section");
  section.classList.toggle("hidden", roster.length === 0);
  if (!roster.length) return;

  $("rejoin-hint").textContent = `${roster.length} game${roster.length > 1 ? "s" : ""}`;

  const html = roster
    .map((entry) => {
      const g = games.get(entry.code);
      if (!g || !g.meta) {
        return `<div class="game-card loading" data-rejoin="${esc(entry.code)}">
          <div class="gc-main"><div class="gc-name">${esc(entry.code)}</div>
          <div class="gc-sub">loading…</div></div></div>`;
      }
      const { rows } = totalsFor(g);
      const opp = opponentOf(g);
      const mine = rows[myId(g)]?.all.claimed || 0;
      const theirs = opp ? rows[opp.id]?.all.claimed || 0 : 0;
      const over = isOver(g);
      const remain = g.meta.endsAt - db.now();

      return `<div class="game-card ${over ? "over" : ""}" data-rejoin="${esc(g.code)}">
        <div class="gc-main">
          <div class="gc-head">
            <span class="gc-name">${esc(gameLabel(g))}</span>
            ${over ? '<span class="gc-flag over">ENDED</span>' : ""}
            <span class="gc-code">${esc(g.code)}</span>
          </div>
          <div class="gc-scores">
            <span class="gc-me">You ${fmtDurationShort(mine)}</span>
            <span class="gc-them">${
              opp ? `${esc(opp.name)} ${fmtDurationShort(theirs)}` : "waiting for player 2"
            }</span>
          </div>
          <div class="gc-sub">${
            over
              ? "ended"
              : remain < 86400e3
                ? `${Math.max(0, Math.floor(remain / 3600e3))}h left`
                : `${Math.ceil(remain / 86400e3)}d left`
          }</div>
        </div>
        <span class="rejoin-arrow">→</span>
      </div>`;
    })
    .join("");

  const host = $("rejoin-list");
  if (host.dataset.sig === html) return;
  host.dataset.sig = html;
  host.innerHTML = html;
  host.querySelectorAll("[data-rejoin]").forEach((el) =>
    el.addEventListener("click", () => {
      showScreen("hub");
      render();
    })
  );
}

// --- Hub stats --------------------------------------------------------------

/**
 * Summary on the main screen, scoped to one game or aggregated across all of
 * them. In the aggregate view opponents are pooled — each game is its own 1v1,
 * so a single "them" column is the only thing that reads sensibly.
 */
function renderHubStats() {
  const sel = $("stats-scope");

  // Rebuild the dropdown only when the set of games actually changes, so it
  // isn't yanked out from under the user mid-interaction.
  const optSig = roster.map((r) => `${r.code}:${gameLabel(games.get(r.code) || { code: r.code })}`).join("|");
  if (sel.dataset.sig !== optSig) {
    const keep = sel.value;
    sel.dataset.sig = optSig;
    sel.innerHTML =
      `<option value="__all__">All games</option>` +
      roster
        .map((r) => {
          const g = games.get(r.code);
          return `<option value="${esc(r.code)}">${esc(g ? gameLabel(g) : r.code)}</option>`;
        })
        .join("");
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }

  const scope = sel.value || "__all__";
  const single = scope !== "__all__" ? games.get(scope) : null;

  $("hub-feed-card").classList.toggle("hidden", !(single && single.meta));
  if (single && single.meta) {
    renderStatsFor([single], single, "hub-summary-table", "hub-stat-grid");
    renderCharts([single], single);
    renderFeed("hub-feed", single, 50);
  } else {
    const all = roster.map((r) => games.get(r.code)).filter((g) => g && g.meta);
    renderStatsFor(all, null, "hub-summary-table", "hub-stat-grid");
    renderCharts(all, null);
  }
}

// --- Charts -----------------------------------------------------------------

/**
 * Both charts follow the stats scope selector.
 *
 * Across several games the claim streams are merged: each game is its own 1v1
 * against you, so "you vs them" still reads correctly in aggregate even though
 * the opponents differ. When exactly one game is in scope we can use the real
 * opponent's name.
 */
function renderCharts(list, single) {
  const width = Math.max(280, Math.min(680, ($("chart-clicks").clientWidth || 620)));

  // Merge every in-scope game's claims into one stream keyed to me-vs-them.
  const merged = [];
  for (const g of list) {
    const escrowed = duelUnsettled(g.state?.duel) ? g.state.duel.disputedClaimId : null;
    for (const c of g.claims || []) {
      if (c.status !== "settled" || c.id === escrowed) continue;
      merged.push({ ...c, by: c.by === myId(g) ? "__me__" : "__them__" });
    }
  }

  const opp = opponentLabel(single ? [single] : list);
  const oppName = opp.name;
  const meName = me.name || "You";

  // --- per-click bars ---
  const rows = sortRows(claimRows(merged, "__me__"), clickSort);
  setHTML("chart-clicks-legend", rows.length ? legend(meName, oppName) : "");
  setHTML("chart-clicks", barChart(rows, { width, meName, oppName }));

  // --- who's winning ---
  let buckets;
  let bucketLabel;
  if (leadZoom) {
    const zb = suggestBucket(leadZoom.end - leadZoom.start);
    buckets = bucketOHLC(merged, "__me__", zb.ms, leadZoom.end, 200).filter((b) => b.t1 > leadZoom.start);
    bucketLabel = zb.label;
  } else {
    const bucket = BUCKETS.find((b) => b.key === bucketKey) || BUCKETS[2];
    buckets = bucketOHLC(merged, "__me__", bucket.ms, db.now());
    bucketLabel = bucket.label;
  }

  $("btn-lead-zoom-reset").classList.toggle("hidden", !leadZoom);
  $("bucket-size").disabled = !!leadZoom;
  $("chart-lead-zoom-note").classList.toggle("hidden", !leadZoom);
  if (leadZoom) {
    setHTML(
      "chart-lead-zoom-note",
      `🔍 Zoomed into ${new Date(leadZoom.start).toLocaleString()} → ${new Date(leadZoom.end).toLocaleString()}.`
    );
  }

  setHTML("chart-lead-legend", buckets.length ? legend(meName, oppName) : "");
  setHTML(
    "chart-lead",
    leadStyle === "candle"
      ? candleChart(buckets, { width, meName, oppName })
      : leadArea(buckets, { width, meName, oppName })
  );

  const last = buckets[buckets.length - 1];
  const note = !last
    ? ""
    : leadStyle === "candle"
      ? `Each candle is one ${bucketLabel.toLowerCase()}: body spans the lead at the ` +
        `start and end, wick spans its high and low within that ${bucketLabel.toLowerCase()}. ` +
        `Blue means your lead grew. Tap a candle to zoom in.`
      : `Above the dashed line ${esc(meName)} is ahead; below it ${esc(oppName)} ${
          opp.real ? "is" : "are"
        }. Tap a point to zoom in.`;
  setHTML("chart-lead-note", note);
}

/**
 * @param list   games to aggregate over
 * @param single non-null when showing exactly one game, which lets us use the
 *               players' real names instead of "You" / "Them"
 */
function renderStatsFor(list, single, tableId, gridId) {
  const nowMs = db.now();

  let cols; // [{ key, label, get(rows, periodKey) -> {claimed, actual} }]
  if (single) {
    const ids = Object.keys(single.players || {});
    cols = ids.map((id) => ({
      key: id,
      label: single.players[id].name + (id === myId(single) ? " (you)" : ""),
    }));
  } else {
    cols = [
      { key: "__me__", label: me.name || "You" },
      { key: "__them__", label: opponentLabel(list).name },
    ];
  }

  // period -> col -> {claimed, actual}
  const grid = {};
  for (const p of PERIODS) {
    grid[p.key] = {};
    for (const c of cols) grid[p.key][c.key] = { claimed: 0, actual: 0 };
  }

  for (const g of list) {
    const { ids, rows } = totalsFor(g);
    for (const p of PERIODS) {
      for (const id of ids) {
        const cell = rows[id][p.key];
        const colKey = single ? id : id === myId(g) ? "__me__" : "__them__";
        if (!grid[p.key][colKey]) continue;
        grid[p.key][colKey].claimed += cell.claimed;
        grid[p.key][colKey].actual += cell.actual;
      }
    }
  }

  const head =
    `<thead><tr><th>Period</th>` +
    cols.map((c) => `<th>${esc(c.label)}</th>`).join("") +
    `</tr></thead>`;

  const body =
    `<tbody>` +
    PERIODS.map((p) => {
      const best = Math.max(...cols.map((c) => grid[p.key][c.key].claimed));
      return (
        `<tr><td>${p.label}</td>` +
        cols
          .map((c) => {
            const cell = grid[p.key][c.key];
            const win = cols.length > 1 && cell.claimed === best && best > 0;
            return `<td class="num ${win ? "win" : ""}">${fmtDurationShort(cell.claimed)}
              <div class="sub">${fmtDurationShort(cell.actual)} actual</div></td>`;
          })
          .join("") +
        `</tr>`
      );
    }).join("") +
    `</tbody>`;

  setHTML(tableId, head + body);

  // Totals row
  let claimedAll = 0;
  let actualAll = 0;
  let claimCount = 0;
  let duelCount = 0;
  let clock = 0;
  for (const g of list) {
    const { ids, rows } = totalsFor(g);
    for (const id of ids) {
      claimedAll += rows[id].all.claimed;
      actualAll += rows[id].all.actual;
    }
    claimCount += (g.claims || []).filter((c) => c.status === "settled").length;
    duelCount += (g.claims || []).filter((c) => c.viaDuel).length;
    if (!isOver(g)) clock += onClock(g);
  }

  setHTML(
    gridId,
    [
      ["Actual time clicked", fmtDuration(actualAll)],
      ["Total claimed", fmtDuration(claimedAll)],
      ["Bonus from 2x", fmtDuration(claimedAll - actualAll)],
      ["Claims", String(claimCount)],
      ["Duels", String(duelCount)],
      [list.length > 1 ? "On the clock (all)" : "On the clock", fmtDuration(clock)],
    ]
      .map(
        ([l, v]) =>
          `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${v}</div></div>`
      )
      .join("")
  );
}

/** Skip the DOM write when nothing changed — this runs on a 200ms tick. */
function setHTML(id, html) {
  const el = $(id);
  if (el.dataset.sig === html) return;
  el.dataset.sig = html;
  el.innerHTML = html;
}

// --- Detail screen ----------------------------------------------------------

function openDetail(code) {
  currentDetail = code;
  const g = games.get(code);
  $("detail-webhook").value = g?.meta?.webhook || "";
  showScreen("detail");
  renderDetail();
}

function renderDetail() {
  const g = games.get(currentDetail);
  if (!g || !g.meta) return;

  $("detail-title").textContent = gameLabel(g);
  $("code-text").textContent = g.code;

  const { ids, rows } = totalsFor(g);
  const opp = opponentOf(g);
  const over = isOver(g);

  // Deadline line
  const remain = g.meta.endsAt - db.now();
  $("detail-deadline").innerHTML = over
    ? `Ended ${new Date(g.meta.endsAt).toLocaleString()}.`
    : `Ends ${new Date(g.meta.endsAt).toLocaleString()} — ` +
      `<strong>${remain > 86400e3 ? Math.ceil(remain / 86400e3) + " days" : Math.floor(remain / 3600e3) + " hours"}</strong> left. ` +
      `Most claimed time wins.`;

  // Banners
  const wnd = windowStatus(g.code, db.now());
  const bn = [];
  if (over) {
    const ranked = [...ids].sort((a, b) => rows[b].all.claimed - rows[a].all.claimed);
    const tie = ranked.length > 1 && rows[ranked[0]].all.claimed === rows[ranked[1]].all.claimed;
    bn.push(
      `<div class="banner banner-info">🏁 ${
        tie ? "Dead tie." : `<strong>${esc(g.players?.[ranked[0]]?.name || "?")}</strong> won.`
      }</div>`
    );
  } else if (wnd.active) {
    bn.push(
      `<div class="banner banner-2x">⚡ 2x ACTIVE — ends in ${fmtDuration((wnd.endsAt - db.now()) / 1000)}</div>`
    );
  }
  if (!opp) {
    bn.push(
      `<div class="banner banner-info">Waiting for a second player. Share code <strong>${esc(g.code)}</strong>.</div>`
    );
  }
  $("detail-banners").innerHTML = bn.join("");

  // Standings
  $("detail-scores").innerHTML = ids
    .map((id) => {
      const p = g.players[id];
      const isMe = id === myId(g);
      const lead = ids.every((o) => rows[id].all.claimed >= rows[o].all.claimed);
      return `<div class="score ${isMe ? "me" : ""} ${lead && ids.length > 1 ? "leader" : ""}">
        <div class="score-name">
          <span class="dot ${g.presence?.[id]?.online ? "online" : ""}"></span>
          <span class="who">${esc(p.name)}${isMe ? " (you)" : ""}</span>
        </div>
        <div class="score-total">${fmtDuration(rows[id].all.claimed)}</div>
        <div class="score-meta">${fmtDuration(rows[id].all.actual)} actual · ${rows[id].all.count} claims</div>
      </div>`;
    })
    .concat(ids.length < 2 ? [`<div class="score empty">Empty seat</div>`] : [])
    .join("");

  // Period table
  const head =
    `<thead><tr><th>Period</th>` +
    ids.map((id) => `<th>${esc(g.players[id].name)}</th>`).join("") +
    `</tr></thead>`;
  const body =
    `<tbody>` +
    PERIODS.map((p) => {
      const best = Math.max(...ids.map((id) => rows[id][p.key].claimed));
      return (
        `<tr><td>${p.label}</td>` +
        ids
          .map((id) => {
            const cell = rows[id][p.key];
            const win = ids.length > 1 && cell.claimed === best && best > 0;
            return `<td class="num ${win ? "win" : ""}">${fmtDurationShort(cell.claimed)}
              <div class="sub">${fmtDurationShort(cell.actual)} actual</div></td>`;
          })
          .join("") +
        `</tr>`
      );
    }).join("") +
    `</tbody>`;
  $("summary-table").innerHTML = head + body;

  // Totals
  const allClaimed = ids.reduce((s, id) => s + rows[id].all.claimed, 0);
  const allActual = ids.reduce((s, id) => s + rows[id].all.actual, 0);
  const duelsPlayed = (g.claims || []).filter((c) => c.viaDuel).length;
  $("stat-grid").innerHTML = [
    ["Actual time clicked", fmtDuration(allActual)],
    ["Total claimed", fmtDuration(allClaimed)],
    ["Bonus from 2x", fmtDuration(allClaimed - allActual)],
    ["Claims", String((g.claims || []).filter((c) => c.status === "settled").length)],
    ["Duels", String(duelsPlayed)],
    ["On the clock", fmtDuration(onClock(g))],
  ]
    .map(
      ([l, v]) =>
        `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${v}</div></div>`
    )
    .join("");

  // 2x windows today
  const dayKey = utcDayKey(db.now());
  const nowHour = new Date(db.now()).getUTCHours();
  $("windows-list").innerHTML = doubleHoursFor(g.code, dayKey)
    .map((h) => {
      const live = h === nowHour;
      const state = live ? "live now" : h < nowHour ? "done" : "upcoming";
      return `<div class="win-row ${live ? "live" : ""}">
        <span>${live ? "⚡" : "🕐"}</span>
        <span class="win-when">${utcHourToLocalRange(dayKey, h)}</span>
        <span class="win-state">${state}</span>
      </div>`;
    })
    .join("");

  renderFeed("feed", g, 15);
}

/**
 * Consecutive claims by the same player collapse into one row carrying the
 * combined total; the individual splits stay available behind a toggle.
 *
 * @param hostId id of the <ul> to render into
 * @param g      game to pull claims from
 * @param limit  most recent runs to show
 */
/**
 * Which run's <details> is expanded in each feed, keyed by the id of the
 * run's first claim (stable across re-renders). The feed re-renders every
 * tick because the "…ago" labels keep changing, which would otherwise blow
 * away an open <details> the instant you tapped it — so open/closed state is
 * tracked here and baked back into the markup on every render instead.
 */
const openFeedRuns = new Map(); // hostId -> Set<runKey>

function renderFeed(hostId, g, limit) {
  const host = $(hostId);
  let openSet = openFeedRuns.get(hostId);
  if (!openSet) {
    openSet = new Set();
    openFeedRuns.set(hostId, openSet);
    // `toggle` doesn't bubble, but a capturing listener on an ancestor still
    // sees it on the way down, so delegation still works without rewiring
    // every <details> on every render.
    host.addEventListener(
      "toggle",
      (e) => {
        const li = e.target.closest?.("[data-key]");
        if (!li || e.target.tagName !== "DETAILS") return;
        if (e.target.open) openSet.add(li.dataset.key);
        else openSet.delete(li.dataset.key);
      },
      true
    );
  }

  const escrowedId = duelUnsettled(g.state?.duel) ? g.state.duel.disputedClaimId : null;
  const feedRows = claimRows(g.claims || [], myId(g));
  const runs = groupRuns(feedRows).reverse().slice(0, limit);

  setHTML(
    hostId,
    runs.length
      ? runs
          .map((run) => {
            const who = g.players?.[run.by]?.name || "?";
            const tags =
              (run.anyDoubled ? '<span class="f-tag x2">2x</span>' : "") +
              (run.anyDuel ? '<span class="f-tag duel">DUEL</span>' : "") +
              (run.items.some((i) => i.id === escrowedId)
                ? '<span class="f-tag duel">ESCROW</span>'
                : "");

            if (run.count === 1) {
              return `<li>
                <span class="f-who">${esc(who)}</span>
                <span class="f-amt">${fmtDuration(run.seconds)}</span>
                ${tags}
                <span class="f-when">${fmtAgo(db.now() - run.to)}</span>
              </li>`;
            }

            const splits = run.items
              .slice()
              .reverse()
              .map(
                (i) => `<li class="split">
                  <span class="split-n">#${i.order}</span>
                  <span class="f-amt">${fmtDuration(i.seconds)}</span>
                  ${i.multiplier > 1 ? '<span class="f-tag x2">2x</span>' : ""}
                  ${i.viaDuel ? '<span class="f-tag duel">DUEL</span>' : ""}
                  <span class="f-when">${fmtAgo(db.now() - i.at)}</span>
                </li>`
              )
              .join("");

            const key = esc(String(run.items[0].id));
            return `<li class="run" data-key="${key}">
              <details ${openSet.has(key) ? "open" : ""}>
                <summary>
                  <span class="f-who">${esc(who)}</span>
                  <span class="f-amt">${fmtDuration(run.seconds)}</span>
                  <span class="f-count">${run.count} clicks</span>
                  ${tags}
                  <span class="f-when">${fmtAgo(db.now() - run.to)}</span>
                </summary>
                <ul class="splits">${splits}</ul>
              </details>
            </li>`;
          })
          .join("")
      : `<li class="feed-empty">No claims yet.</li>`
  );
}

function wireDetail() {
  $("btn-back").addEventListener("click", () => {
    currentDetail = null;
    showScreen("hub");
  });

  $("code-chip").addEventListener("click", async () => {
    const g = games.get(currentDetail);
    if (!g) return;
    const link = `${location.origin}${location.pathname}?g=${g.code}`;
    try {
      await navigator.clipboard.writeText(link);
      toast("Invite link copied.", "good");
    } catch {
      toast(`Game code: <strong>${g.code}</strong>`, "");
    }
  });

  $("btn-export").addEventListener("click", async () => {
    const g = games.get(currentDetail);
    if (!g) return;
    const json = JSON.stringify(buildExport(g), null, 2);
    try {
      await navigator.clipboard.writeText(json);
      toast(`Copied ${g.claims?.length || 0} claims to the clipboard.`, "good");
    } catch {
      // Clipboard blocked (needs a secure context) — fall back to a download.
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `clicky-${g.code}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast("Downloaded the game data.", "good");
    }
  });

  $("webhook-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await db.setWebhook(currentDetail, $("detail-webhook").value.trim());
    toast("Webhook saved.", "good");
  });

  $("btn-leave").addEventListener("click", () => {
    const g = games.get(currentDetail);
    if (!confirm(`Leave ${gameLabel(g)}? Your claims stay in the game — you just stop tracking it here.`)) {
      return;
    }
    removeFromRoster(currentDetail);
    currentDetail = null;
    if (roster.length) showScreen("hub");
  });
}

// --- Hub wiring -------------------------------------------------------------

function wireHub() {
  $("btn-claim").addEventListener("click", doClaim);
  $("btn-add").addEventListener("click", () => {
    switchTab("join");
    showScreen("setup");
  });
  $("btn-account").addEventListener("click", () => {
    if (account) showScreen("profile");
    else {
      switchTab("account");
      showScreen("setup");
    }
  });
  $("hub-logo").addEventListener("click", goHome);
  $("detail-logo").addEventListener("click", goHome);
  $("brand-logo").addEventListener("click", () => {
    if (roster.length) goHome();
  });
  $("stats-scope").addEventListener("change", () => {
    leadZoom = null; // a different game/scope is a different dataset — start unzoomed
    renderHubStats();
  });

  // Chart controls. Each persists, so the view you left is the view you return to.
  document.querySelectorAll("[data-clicksort]").forEach((b) =>
    b.addEventListener("click", () => {
      clickSort = b.dataset.clicksort;
      store.set("clickSort", clickSort);
      document
        .querySelectorAll("[data-clicksort]")
        .forEach((x) => x.classList.toggle("active", x === b));
      renderHubStats();
    })
  );
  document.querySelectorAll("[data-leadstyle]").forEach((b) =>
    b.addEventListener("click", () => {
      leadStyle = b.dataset.leadstyle;
      store.set("leadStyle", leadStyle);
      document
        .querySelectorAll("[data-leadstyle]")
        .forEach((x) => x.classList.toggle("active", x === b));
      renderHubStats();
    })
  );
  $("bucket-size").addEventListener("change", (e) => {
    bucketKey = e.target.value;
    store.set("bucketKey", bucketKey);
    renderHubStats();
  });

  // Click/tap a candle or point on the "who's winning" chart to zoom into it.
  $("chart-lead").addEventListener("click", (e) => {
    const target = e.target.closest(".chart-zoom-target");
    if (!target) return;
    const start = Number(target.dataset.t0);
    const end = Number(target.dataset.t1);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    leadZoom = { start, end };
    renderHubStats();
  });
  $("btn-lead-zoom-reset").addEventListener("click", () => {
    leadZoom = null;
    renderHubStats();
  });

  // Restore persisted chart controls.
  $("bucket-size").value = bucketKey;
  document
    .querySelectorAll("[data-clicksort]")
    .forEach((x) => x.classList.toggle("active", x.dataset.clicksort === clickSort));
  document
    .querySelectorAll("[data-leadstyle]")
    .forEach((x) => x.classList.toggle("active", x.dataset.leadstyle === leadStyle));
  $("btn-settings").addEventListener("click", () => {
    $("set-name").value = me.name;
    $("set-discordid").value = me.discordId;
    $("settings-modal").classList.remove("hidden");
  });

  // Spacebar claims, because of course it does.
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    if (/^(INPUT|TEXTAREA|BUTTON)$/.test(document.activeElement?.tagName)) return;
    if ($("screen-hub").classList.contains("hidden")) return;
    e.preventDefault();
    doClaim();
  });
}

// --- Duel modals (one per active duel) --------------------------------------

const dismissedResults = new Set();

/** All duels I'm involved in that should have a visible modal. */
function allActiveDuels() {
  const out = [];
  for (const g of games.values()) {
    const d = g.state?.duel;
    if (!d || (d.challenger !== myId(g) && d.defender !== myId(g))) continue;
    if (d.status === "open" || d.status === "double_offer") out.push({ g, duel: d });
    else if (d.status === "resolved" && !dismissedResults.has(d.id)) out.push({ g, duel: d });
  }
  return out;
}

function openDuelModal() {
  renderDuelModal();
}

/** So the 2-min duel timeout doesn't fire while someone's visibly mid-action. */
const lastActivityPing = new Map();
function pingDuelActivity(code, duelId) {
  const last = lastActivityPing.get(duelId) || 0;
  const t = Date.now();
  if (t - last < 15000) return;
  lastActivityPing.set(duelId, t);
  db.pingDuelActivity(code, duelId);
}

/**
 * All active duels share one overlay so multiple at once don't stack
 * full-screen on top of each other — a scroll-snapping track of cards, side
 * by side on wide screens, swipe/arrow-through on narrow ones.
 */
function duelOverlay() {
  let overlay = $("duel-overlay");
  if (overlay) return overlay;

  const host = $("rps-host");
  overlay = document.createElement("div");
  overlay.id = "duel-overlay";
  overlay.className = "modal-backdrop duel-overlay hidden";
  overlay.innerHTML = `
    <div class="duel-carousel">
      <button type="button" class="duel-nav prev hidden" aria-label="Previous duel">‹</button>
      <div class="duel-track" data-el="track"></div>
      <button type="button" class="duel-nav next hidden" aria-label="Next duel">›</button>
    </div>
    <p class="duel-counter hidden" data-el="counter"></p>`;
  host.appendChild(overlay);

  const track = overlay.querySelector('[data-el="track"]');
  overlay.querySelector(".prev").addEventListener("click", () => scrollDuelTrack(track, -1));
  overlay.querySelector(".next").addEventListener("click", () => scrollDuelTrack(track, 1));
  track.addEventListener("scroll", () => updateDuelCounter(overlay), { passive: true });
  return overlay;
}

function scrollDuelTrack(track, dir) {
  const width = track.firstElementChild ? track.firstElementChild.getBoundingClientRect().width + 14 : track.clientWidth;
  track.scrollBy({ left: dir * width, behavior: "smooth" });
}

function updateDuelCounter(overlay) {
  const track = overlay.querySelector('[data-el="track"]');
  const counterEl = overlay.querySelector('[data-el="counter"]');
  const navEls = overlay.querySelectorAll(".duel-nav");
  const cards = [...track.children];

  navEls.forEach((btn) => btn.classList.toggle("hidden", cards.length <= 1));
  if (cards.length <= 1) {
    counterEl.classList.add("hidden");
    return;
  }

  const trackMid = track.getBoundingClientRect().left + track.clientWidth / 2;
  let idx = 0;
  let best = Infinity;
  cards.forEach((c, i) => {
    const r = c.getBoundingClientRect();
    const dist = Math.abs(r.left + r.width / 2 - trackMid);
    if (dist < best) {
      best = dist;
      idx = i;
    }
  });
  counterEl.classList.remove("hidden");
  counterEl.textContent = `Duel ${idx + 1} of ${cards.length}`;
}

function renderDuelModal() {
  const overlay = duelOverlay();
  const track = overlay.querySelector('[data-el="track"]');
  const entries = allActiveDuels();

  overlay.classList.toggle("hidden", entries.length === 0);

  // Remove cards for duels that are no longer active.
  const activeKeys = new Set(entries.map((e) => `duel-${e.g.code}-${e.duel.id}`));
  for (const el of [...track.children]) {
    if (!activeKeys.has(el.id)) el.remove();
  }

  const newlyOpened = [];

  for (const entry of entries) {
    const { g, duel: d } = entry;
    const key = `duel-${g.code}-${d.id}`;
    const resolved = d.status === "resolved";
    const myPick = (d.picks || {})[myId(g)];
    const oppId = d.challenger === myId(g) ? d.defender : d.challenger;
    const oppPick = (d.picks || {})[oppId];
    const oppName = g.players?.[oppId]?.name || "They";

    let card = $(key);
    if (!card) {
      card = document.createElement("div");
      card.className = "modal duel-card";
      card.id = key;
      card.setAttribute("role", "dialog");
      card.setAttribute("aria-modal", "true");
      card.innerHTML = `
        <h2>⚔️ Contested claim</h2>
        <p class="duel-game" data-el="game"></p>
        <p class="duel-minigame" data-el="minigame"></p>
        <p class="modal-sub" data-el="sub"></p>
        <div class="pot" data-el="pot"></div>
        <div class="duel-picker" data-el="picker"></div>
        <p class="modal-status" data-el="status"></p>
        <p class="modal-timeout hidden" data-el="countdown"></p>
        <div class="rps-result hidden" data-el="result"></div>
        <div class="modal-actions">
          <div class="spacer"></div>
          <button type="button" class="btn btn-ghost hidden" data-el="dismiss">Close</button>
        </div>
        <p class="modal-lock" data-el="lock">You can't claim again until you've made your move.</p>`;
      track.appendChild(card);
      newlyOpened.push(card);

      // Wire the picker once and read live duel state at click time — the
      // markup inside gets rebuilt on every render, but delegation means the
      // listener itself never needs rewiring.
      const pickerEl = card.querySelector('[data-el="picker"]');
      const submitPick = async (value, path) => {
        const cur = games.get(g.code);
        const curDuel = cur?.state?.duel;
        if (!curDuel || curDuel.id !== d.id) return;
        pickerEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
        await db.submitThrow(g.code, curDuel.id, myId(g), value, path);
        render();
      };
      // Exposed so the golf mount (outside this closure, in the main render
      // loop) can submit the shot's distance the same way a button pick does.
      card._submitPick = submitPick;
      pickerEl.addEventListener("click", (e) => {
        const doubleBtn = e.target.closest("[data-double]");
        if (doubleBtn) {
          const cur = games.get(g.code);
          const curDuel = cur?.state?.duel;
          if (!curDuel || curDuel.id !== d.id) return;
          pickerEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
          db.submitDoubleChoice(g.code, curDuel.id, myId(g), doubleBtn.dataset.double).then(render);
          return;
        }
        const numBtn = e.target.closest('[data-pick-btn="closest"]');
        if (numBtn) {
          const input = pickerEl.querySelector(".duel-number-input");
          const val = Math.round(Number(input?.value));
          if (!Number.isFinite(val) || val < 1 || val > 10) {
            input?.classList.add("bad");
            return;
          }
          submitPick(val);
          return;
        }
        const btn = e.target.closest("[data-pick]");
        if (!btn || btn.disabled) return;
        const kind = btn.dataset.pick;
        submitPick(kind === "tap" ? db.now() : kind === "roll" ? true : kind);
      });
      pickerEl.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || !e.target.classList?.contains("duel-number-input")) return;
        e.preventDefault();
        pickerEl.querySelector('[data-pick-btn="closest"]')?.click();
      });

      // Any sign of life in the picker — a tap, a typed digit, a golf drag,
      // focusing the number field — pushes the timeout back out.
      const ping = () => pingDuelActivity(g.code, d.id);
      pickerEl.addEventListener("pointerdown", ping);
      pickerEl.addEventListener("input", ping);
      pickerEl.addEventListener("focusin", ping);

      // Wire dismiss button.
      card.querySelector('[data-el="dismiss"]').addEventListener("click", () => {
        const cur = games.get(g.code);
        const curDuel = cur?.state?.duel;
        if (curDuel?.status === "resolved") dismissedResults.add(curDuel.id);
        card.remove();
        updateDuelCounter(overlay);
        render();
      });
    }

    const el = (name) => card.querySelector(`[data-el="${name}"]`);
    const meId = myId(g);
    const iPicked = myPick !== undefined && myPick !== null;
    const theyPicked = oppPick !== undefined && oppPick !== null;
    const meta = DUEL_META[d.game] || DUEL_META.rps;

    el("game").textContent = gameLabel(g);
    el("minigame").textContent = `${meta.icon} ${meta.label}`;
    el("sub").innerHTML = resolved
      ? ""
      : `<strong>${esc(oppName)}</strong> and you claimed within ` +
        `${(d.gapMs / 1000).toFixed(1)}s of each other. ${esc(meta.rule)}`;

    const potMultiplier = d.payoutMultiplier || 1;
    const potLabel = resolved
      ? d.doubled && !d.doubleLost
        ? "Doubled!"
        : "Settled"
      : `In escrow${d.round > 1 ? ` · round ${d.round}` : ""}`;
    el("pot").innerHTML = `<div class="pot-label">${potLabel}</div>
      <div class="pot-value">${fmtDuration(d.potSeconds * potMultiplier)}</div>`;

    // Picker (also hosts the coin's double-or-nothing choice, once decided)
    const pickerEl = el("picker");
    pickerEl.classList.toggle("hidden", resolved);
    if (!resolved) {
      const sig = `${d.status}|${d.game}|${d.round}|${iPicked}|${d.game === "reaction" ? db.now() >= d.goAt : ""}`;
      if (pickerEl.dataset.sig !== sig) {
        pickerEl.dataset.sig = sig;
        pickerEl.innerHTML = pickerHtml(d, iPicked, meId);
        if (d.game === "golf" && d.status === "open" && !iPicked) {
          const mount = pickerEl.querySelector(".golf-mount");
          if (mount)
            mountGolf(mount, d.id, d.round || 1, (distance, path) => {
              card._submitPick(distance, path);
            });
        }
      }
    }

    // Status + result
    const statusEl = el("status");
    const resultEl = el("result");
    const dismissEl = el("dismiss");
    const lockEl = el("lock");
    const countdownEl = el("countdown");

    if (resolved) {
      const iWon = d.winner === meId;
      statusEl.textContent = "";
      resultEl.classList.remove("hidden");

      // Rebuild (and re-trigger the coin's flip animation) only the moment
      // this particular resolution appears — not on every 200ms tick while
      // the result stays on screen waiting to be dismissed.
      const resultSig = `${d.id}|${d.status}|${d.doubled}|${d.doubleLost}|${d.timedOut}`;
      if (resultEl.dataset.sig !== resultSig) {
        resultEl.dataset.sig = resultSig;

        const doubleNote = d.doubled
          ? d.doubleLost
            ? `<div class="rr-detail">Double-or-nothing gone wrong — the win flipped sides on the extra flip.</div>`
            : `<div class="rr-detail">Doubled it! 🔥</div>`
          : "";
        const timeoutNote = d.timedOut
          ? `<div class="rr-detail">${esc(iWon ? "You" : oppName)} made a move before time ran out — ${
              iWon ? "the win goes to you." : "they get it."
            }</div>`
          : "";
        const golfPaths = d.game === "golf" ? d.golfPaths || {} : null;
        const myGolfPath = golfPaths?.[meId];
        const oppGolfPath = golfPaths?.[oppId];
        const golfReplayHtml =
          myGolfPath || oppGolfPath ? `<div class="golf-replay" data-el="golf-replay"></div>` : "";
        const restHtml = `
          <div class="rr-throws">${resultDetailHtml(d, meId, oppId, oppName)}</div>
          <div class="rr-verdict ${iWon ? "won" : "lost"}">${iWon ? "You take it" : "You lose it"}</div>
          <div class="rr-detail">${
            iWon
              ? `${fmtDuration(d.potSeconds * (d.payoutMultiplier || 1))} banked. ${esc(oppName)} gets nothing.`
              : `${esc(oppName)} takes ${fmtDuration(d.potSeconds * (d.payoutMultiplier || 1))}.`
          }</div>
          ${timeoutNote}
          ${doubleNote}
          ${golfReplayHtml}`;

        // The initial coin flip already played during the "double_offer" stage
        // (before the winner was offered take/double). Taking it (or timing
        // out) finishes the duel right there with no replay — only a genuine
        // double-or-nothing gamble is a new flip that needs its own animation.
        const initialFace = d.game === "coin" ? d.detail?.result : null;
        if (initialFace && d.doubled) {
          const secondFace = d.doubleLost ? (initialFace === "heads" ? "tails" : "heads") : initialFace;
          playCoinFlip(resultEl, secondFace, restHtml);
        } else if (initialFace) {
          resultEl.innerHTML = `<div class="coin-flip-stage"><div class="coin-face settle ${initialFace}">${COIN_FACE[initialFace]}</div></div>
            <div class="coin-outcome ${initialFace}">${initialFace === "heads" ? "Heads" : "Tails"}</div>
            ${restHtml}`;
        } else {
          resultEl.innerHTML = restHtml;
        }

        if (myGolfPath || oppGolfPath) {
          const mount = resultEl.querySelector('[data-el="golf-replay"]');
          if (mount)
            mountGolfReplay(mount, d.id, d.round || 1, { mine: myGolfPath, opponent: oppGolfPath }, oppName);
        }
      }

      dismissEl.classList.remove("hidden");
      lockEl.classList.add("hidden");
      countdownEl.classList.add("hidden");
    } else {
      dismissEl.classList.add("hidden");
      lockEl.classList.remove("hidden"); // still locked either way — waiting on a pick or a double-or-nothing choice

      if (d.status === "double_offer") {
        // Play the flip once, then hold the take/double choice back until it
        // settles — the winner shouldn't see (or be able to click) the offer
        // while the coin is still spinning.
        resultEl.classList.remove("hidden");
        const resultSig = `${d.id}|${d.status}`;
        if (resultEl.dataset.sig !== resultSig) {
          resultEl.dataset.sig = resultSig;
          const coinResult = d.detail?.result;
          if (coinResult) {
            card.dataset.coinRevealAt = String(db.now() + COIN_FLIP_MS);
            playCoinFlip(resultEl, coinResult, "");
          } else {
            resultEl.innerHTML = "";
            delete card.dataset.coinRevealAt;
          }
        }
        const revealed = !card.dataset.coinRevealAt || db.now() >= Number(card.dataset.coinRevealAt);
        pickerEl.classList.toggle("hidden", !revealed);
        statusEl.textContent = !revealed
          ? ""
          : d.winner === meId
            ? "You called it. Bank it, or push your luck?"
            : `${oppName} called it right — deciding whether to take it or go double or nothing.`;
      } else if (!iPicked) {
        resultEl.classList.add("hidden");
        statusEl.textContent = theyPicked ? `${oppName} has moved. Your turn.` : "Make your move.";
      } else {
        resultEl.classList.add("hidden");
        statusEl.textContent = `Locked in. Waiting for ${oppName}…`;
      }

      const startedAt = Math.max(
        (d.status === "double_offer" ? d.decidedAt : d.roundStartAt || d.createdAt) || 0,
        d.lastActivityAt || 0
      );
      const remaining = startedAt ? DUEL_TIMEOUT_MS - (db.now() - startedAt) : DUEL_TIMEOUT_MS;
      countdownEl.classList.remove("hidden");
      countdownEl.textContent =
        remaining > 0 ? `Auto-resolves in ${fmtCountdown(remaining)} if unanswered.` : "Resolving…";
    }
  }

  updateDuelCounter(overlay);
  if (newlyOpened.length) {
    newlyOpened[newlyOpened.length - 1].scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }
}

/** Markup for whatever's needed to make a pick — or a double-or-nothing choice — in this duel. */
function pickerHtml(d, iPicked, meId) {
  if (d.status === "double_offer") {
    if (d.winner !== meId) {
      return `<div class="duel-locked">Waiting on their call…</div>`;
    }
    return `<div class="duel-double">
      <button type="button" class="btn btn-primary" data-double="take">Take it</button>
      <button type="button" class="btn btn-ghost" data-double="double">Double or nothing</button>
    </div>`;
  }

  if (iPicked) return `<div class="duel-locked">Locked in. Waiting for the other side…</div>`;

  switch (d.game) {
    case "closest":
      return `<div class="duel-number">
        <input type="number" min="1" max="10" step="1" class="duel-number-input" placeholder="1-10" inputmode="numeric">
        <button type="button" class="btn btn-primary" data-pick-btn="closest">Guess</button>
      </div>`;
    case "coin":
      return `<div class="throws">
        <button class="throw" data-pick="heads"><span>🪙</span>Heads</button>
        <button class="throw" data-pick="tails"><span>🪙</span>Tails</button>
      </div>`;
    case "dice":
      return `<button type="button" class="btn btn-primary duel-tap" data-pick="roll">🎲 Roll the die</button>`;
    case "reaction": {
      const ready = db.now() >= d.goAt;
      return ready
        ? `<button type="button" class="btn btn-primary duel-tap go" data-pick="tap">TAP NOW!</button>`
        : `<button type="button" class="btn btn-ghost duel-tap wait" data-pick="tap">Wait for it…</button>`;
    }
    case "golf":
      return `<div class="golf-mount"></div>`;
    case "rps":
    default:
      return `<div class="throws">${THROWS.map(
        (t) => `<button class="throw" data-pick="${t}"><span>${THROW_EMOJI[t]}</span>${t[0].toUpperCase()}${t.slice(1)}</button>`
      ).join("")}</div>`;
  }
}

const COIN_FLIP_MS = 1000;
const COIN_FLIP_TICK_MS = 110;
let coinFlipSeq = 0;
const COIN_FACE = { heads: "👑", tails: "⭐" };

/**
 * Animate a coin flip into `el`: alternates the shown face between heads and
 * tails for COIN_FLIP_MS, then settles on `finalResult` and appends
 * `trailingHtml`. The outcome is already decided server-side — this is purely
 * a client-side reveal delay for suspense.
 */
function playCoinFlip(el, finalResult, trailingHtml) {
  const token = String(++coinFlipSeq);
  el.dataset.flipToken = token;

  el.innerHTML = `<div class="coin-flip-stage"><div class="coin-face spin-loop heads">${COIN_FACE.heads}</div></div>
    <div class="coin-outcome flipping heads">Heads</div>`;
  const outcomeEl = el.querySelector(".coin-outcome");
  const faceEl = el.querySelector(".coin-face");

  let tick = 0;
  const interval = setInterval(() => {
    if (el.dataset.flipToken !== token) return clearInterval(interval);
    tick++;
    const face = tick % 2 === 0 ? "heads" : "tails";
    faceEl.textContent = COIN_FACE[face];
    faceEl.className = `coin-face spin-loop ${face}`;
    outcomeEl.textContent = face === "heads" ? "Heads" : "Tails";
    outcomeEl.className = `coin-outcome flipping ${face}`;
  }, COIN_FLIP_TICK_MS);

  setTimeout(() => {
    clearInterval(interval);
    if (el.dataset.flipToken !== token) return;
    el.innerHTML = `<div class="coin-flip-stage"><div class="coin-face settle ${finalResult}">${COIN_FACE[finalResult]}</div></div>
      <div class="coin-outcome ${finalResult}">${finalResult === "heads" ? "Heads" : "Tails"}</div>
      ${trailingHtml}`;
  }, COIN_FLIP_MS);
}

/** The "X vs Y" line on the result screen, tailored to whichever minigame decided it. */
function resultDetailHtml(d, meId, oppId, oppName) {
  const picks = d.finalPicks || {};
  const detail = d.detail || {};
  const mineIsChallenger = d.challenger === meId;

  switch (d.game) {
    case "closest":
      return `You guessed ${esc(String(picks[meId]))} · ${esc(oppName)} guessed ${esc(
        String(picks[oppId])
      )} · target was ${detail.target}`;
    case "coin": {
      const mineCall = picks[meId] === "heads" ? "heads" : "tails";
      const oppCall = picks[oppId] === "heads" ? "heads" : "tails";
      return `You called ${mineCall}, ${esc(oppName)} called ${oppCall} · 🪙 landed on ${
        detail.result === "heads" ? "heads" : "tails"
      }`;
    }
    case "dice": {
      const mine = mineIsChallenger ? detail.rollA : detail.rollB;
      const theirs = mineIsChallenger ? detail.rollB : detail.rollA;
      return `🎲 You rolled ${mine} · ${esc(oppName)} rolled ${theirs}`;
    }
    case "golf": {
      const mine = mineIsChallenger ? detail.distA : detail.distB;
      const theirs = mineIsChallenger ? detail.distB : detail.distA;
      const fmtD = (x) => (x === 0 ? "sunk it!" : `${Math.round(x)} from the hole`);
      return `⛳ You ${fmtD(mine)} · ${esc(oppName)} ${fmtD(theirs)}`;
    }
    case "reaction": {
      const mineFalse = mineIsChallenger ? detail.falseStartA : detail.falseStartB;
      const mineLatency = mineIsChallenger ? detail.latencyA : detail.latencyB;
      const theirsFalse = mineIsChallenger ? detail.falseStartB : detail.falseStartA;
      const theirsLatency = mineIsChallenger ? detail.latencyB : detail.latencyA;
      const fmtL = (falseStart, ms) => (falseStart ? "false start" : `${Math.max(0, Math.round(ms))}ms`);
      return `You: ${fmtL(mineFalse, mineLatency)} · ${esc(oppName)}: ${fmtL(theirsFalse, theirsLatency)}`;
    }
    case "rps":
    default:
      return `${THROW_EMOJI[picks[meId]] || "?"} vs ${THROW_EMOJI[picks[oppId]] || "?"}`;
  }
}

function wireModals() {
  $("settings-cancel").addEventListener("click", () => $("settings-modal").classList.add("hidden"));
  $("settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    saveProfile($("set-name").value.trim() || me.name, $("set-discordid").value.trim());
    await Promise.all(
      [...games.keys()].map((code) =>
        db.updatePlayer(code, myIdIn(code), { name: me.name, discordId: me.discordId })
      )
    );
    $("settings-modal").classList.add("hidden");
    toast("Saved.", "good");
  });
}

function wireAccount() {
  const err = $("account-error");
  const busy = (b) => {
    $("btn-signin").disabled = b;
    $("btn-signup").disabled = b;
  };

  const run = async (fn) => {
    err.classList.add("hidden");
    const username = $("acct-username").value;
    const password = $("acct-password").value;
    busy(true);
    try {
      await fn(username, password);
      $("acct-password").value = "";
      toast(`Logged in as <strong>${esc(db.normalizeUsername(username))}</strong>.`, "good");
    } catch (ex) {
      err.textContent = db.authErrorMessage(ex);
      err.classList.remove("hidden");
    } finally {
      busy(false);
    }
  };

  $("btn-signin").addEventListener("click", () => run(db.signIn));
  $("btn-signup").addEventListener("click", () => run(db.signUp));

  $("btn-signout").addEventListener("click", () => db.signOutUser());
  $("btn-profile-signout").addEventListener("click", () => {
    db.signOutUser();
    goHome();
  });
  $("btn-view-profile").addEventListener("click", () => showScreen("profile"));
  $("btn-profile-back").addEventListener("click", goHome);
  $("profile-minigame-filter").addEventListener("change", () => renderProfile());
  $("profile-game-filter").addEventListener("change", () => renderProfile());
}
