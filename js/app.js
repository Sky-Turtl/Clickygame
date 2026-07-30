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
let mergeClicks = store.get("mergeClicks", false); // collapse same-player streaks into one bar
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
    document.body.classList.toggle("screen-" + s, s === which);
  }
  window.scrollTo(0, 0);
  if (which === "setup") renderRejoin();
  if (which === "hub") initHubDashboard();
  if (which === "profile") { renderProfile(); initProfileDashboard(); }
  if (which === "detail") initDetailDashboard();
}

// --- Box dashboards (desktop drag-to-rearrange + resize, synced to the account) --
//
// A dashboard (.box-dashboard) has two zones, stacked vertically:
//   - a .dash-cols row of 1-3 "columns" (.dash-col), each a vertical stack of
//     boxes. Dragging a box over a column live-reorders it into that
//     column's stack (pushing the rest of that column down); dragging past
//     the outer edge of the first/last column spins up a new one (capped at
//     DASH_MAX_COLS); a column left empty by a move is pruned back out
//     (floor of DASH_MIN_COLS).
//   - a "wide" row below .dash-cols: boxes dragged there (or resized far
//     enough to the right) go full dashboard width instead of living in a
//     column.
// A draggable splitter (.dash-col-split) sits between adjacent columns for
// horizontal resizing; a "Reset layout" button (.dash-reset) clears the
// saved layout back to the default.
// Layout — column contents, widths, which boxes are wide, and any explicit
// height — is saved locally and, if signed in, to the account.

const DASH_LAYOUT_KEY = "clicky-dashboard-layout-v2";
const DASH_MIN_COLS = 1;
const DASH_MAX_COLS = 3;
const DASH_DEFAULT_COLS = 2;
const DASH_EDGE_PX = 60; // how far past the outer column edge triggers a new column
const DASH_MIN_BOX_HEIGHT = 40;
const DASH_WIDE_DRAG_PX = 0.6; // resize-handle dx, as a fraction of box width, that promotes a box to wide

const dashInited = new Set(); // dash element ids already wired up

/** { profile: {cols:[[boxId,...],...], wide:[boxId,...], heights:{boxId:"123px"}}, detail: {...}, hub: {...} } */
let dashboardLayout = loadLocalDashboardLayout();

function loadLocalDashboardLayout() {
  try {
    const raw = JSON.parse(localStorage.getItem(DASH_LAYOUT_KEY) || "null");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function saveDashboardLayout() {
  try { localStorage.setItem(DASH_LAYOUT_KEY, JSON.stringify(dashboardLayout)); } catch {}
  if (account) db.setAccountDashboardLayout(account.uid, dashboardLayout).catch(() => {});
}

/** Normalizes a saved entry to {cols, wide, heights, colWidths}, migrating the old flat-array shape from before columns existed. */
function normalizeDashEntry(entry) {
  if (entry && Array.isArray(entry.cols)) {
    return {
      cols: entry.cols.map((c) => [...c]),
      wide: [...(entry.wide || [])],
      heights: { ...(entry.heights || {}) },
      colWidths: [...(entry.colWidths || [])],
    };
  }
  if (Array.isArray(entry)) {
    const cols = Array.from({ length: DASH_DEFAULT_COLS }, () => []);
    const heights = {};
    entry.forEach((e, i) => {
      cols[i % DASH_DEFAULT_COLS].push(e.id);
      if (e.height) heights[e.id] = e.height;
    });
    return { cols, wide: [], heights, colWidths: [] };
  }
  return null;
}

function captureDashLayout(dash, screenKey) {
  const colsWrap = dash.querySelector(":scope > .dash-cols");
  const colEls = colsWrap ? [...colsWrap.querySelectorAll(":scope > .dash-col")] : [];
  const cols = [];
  const colWidths = [];
  for (const col of colEls) {
    const ids = [...col.querySelectorAll(":scope > .dash-box")].map((b) => b.dataset.box);
    if (!ids.length) continue;
    cols.push(ids);
    colWidths.push(col.dataset.customWidth ? Math.round(col.getBoundingClientRect().width) : null);
  }
  const wide = [...dash.querySelectorAll(":scope > .dash-box")].map((b) => b.dataset.box);
  const heights = {};
  for (const box of dash.querySelectorAll(".dash-box")) {
    if (box.style.height) heights[box.dataset.box] = box.style.height;
  }
  dashboardLayout[screenKey] = {
    cols: cols.length || wide.length ? cols : [[...dash.querySelectorAll(".dash-box")].map((b) => b.dataset.box)],
    wide,
    heights,
    colWidths,
  };
  saveDashboardLayout();
}

/** Rebuilds a dashboard's .dash-cols/.dash-col wrappers and wide-row placement from saved layout (or a sane default). */
function applyDashLayout(dash, screenKey) {
  const allBoxes = [...dash.querySelectorAll(".dash-box")];
  const boxIds = allBoxes.map((b) => b.dataset.box);
  const boxMap = new Map(allBoxes.map((b) => [b.dataset.box, b]));

  let layout = normalizeDashEntry(dashboardLayout[screenKey]);
  if (!layout) {
    const cols = Array.from({ length: DASH_DEFAULT_COLS }, () => []);
    boxIds.forEach((id, i) => cols[i % DASH_DEFAULT_COLS].push(id));
    layout = { cols, wide: [], heights: {}, colWidths: [] };
  }

  // Drop stale/duplicate ids, then place any box the layout doesn't know
  // about yet (a box added in code since the layout was saved) into column 0.
  const known = new Set(layout.wide.filter((id) => boxMap.has(id)));
  layout.wide = layout.wide.filter((id) => boxMap.has(id));
  layout.cols = layout.cols.map((col) =>
    col.filter((id) => {
      if (!boxMap.has(id) || known.has(id)) return false;
      known.add(id);
      return true;
    })
  );
  for (const id of boxIds) {
    if (!known.has(id)) { layout.cols[0].push(id); known.add(id); }
  }
  layout.cols = layout.cols.filter((c) => c.length);
  if (!layout.cols.length && !layout.wide.length) layout.cols = [boxIds.slice()];
  while (layout.cols.length > DASH_MAX_COLS) layout.cols[DASH_MAX_COLS - 1].push(...layout.cols.pop());

  dashboardLayout[screenKey] = layout;

  let colsWrap = dash.querySelector(":scope > .dash-cols");
  if (!colsWrap) {
    colsWrap = document.createElement("div");
    colsWrap.className = "dash-cols";
    dash.prepend(colsWrap);
  }

  let cols = [...colsWrap.querySelectorAll(":scope > .dash-col")];
  while (cols.length < layout.cols.length) {
    const col = document.createElement("div");
    col.className = "dash-col";
    colsWrap.appendChild(col);
    cols.push(col);
  }
  while (cols.length > layout.cols.length) cols.pop().remove();

  layout.cols.forEach((ids, i) => {
    const width = layout.colWidths && layout.colWidths[i];
    if (width) {
      cols[i].style.flex = `0 0 ${width}px`;
      cols[i].dataset.customWidth = "1";
    } else {
      cols[i].style.flex = "";
      delete cols[i].dataset.customWidth;
    }
    for (const id of ids) {
      const box = boxMap.get(id);
      cols[i].appendChild(box);
      if (layout.heights[id]) box.style.height = layout.heights[id];
    }
  });

  for (const id of layout.wide) {
    const box = boxMap.get(id);
    dash.appendChild(box); // after colsWrap, in saved order
    if (layout.heights[id]) box.style.height = layout.heights[id];
  }

  layoutDashSplitters(dash, screenKey);
}

const DASH_MIN_COL_WIDTH = 160;

/** Rebuilds the draggable splitters between columns so neighboring columns can be resized horizontally. */
function layoutDashSplitters(dash, screenKey) {
  const colsWrap = dash.querySelector(":scope > .dash-cols");
  if (!colsWrap) return;
  colsWrap.querySelectorAll(":scope > .dash-col-split").forEach((s) => s.remove());

  const cols = [...colsWrap.querySelectorAll(":scope > .dash-col")];
  for (let i = 0; i < cols.length - 1; i++) {
    const colA = cols[i];
    const colB = cols[i + 1];
    const split = document.createElement("div");
    split.className = "dash-col-split";
    colsWrap.insertBefore(split, colB);

    split.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      split.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startWidthA = colA.getBoundingClientRect().width;
      const startWidthB = colB.getBoundingClientRect().width;

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const widthA = Math.max(DASH_MIN_COL_WIDTH, startWidthA + dx);
        const widthB = Math.max(DASH_MIN_COL_WIDTH, startWidthB - dx);
        colA.style.flex = `0 0 ${widthA}px`;
        colA.dataset.customWidth = "1";
        colB.style.flex = `0 0 ${widthB}px`;
        colB.dataset.customWidth = "1";
      };
      const onUp = (ev) => {
        split.releasePointerCapture(ev.pointerId);
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        captureDashLayout(dash, screenKey);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
  }
}

function pruneEmptyDashColumns(dash, screenKey) {
  const colsWrap = dash.querySelector(":scope > .dash-cols");
  if (!colsWrap) return;
  let changed = false;
  for (const col of [...colsWrap.querySelectorAll(":scope > .dash-col")]) {
    if (colsWrap.querySelectorAll(":scope > .dash-col").length <= DASH_MIN_COLS) break;
    if (!col.querySelector(":scope > .dash-box")) { col.remove(); changed = true; }
  }
  if (changed && screenKey) layoutDashSplitters(dash, screenKey);
}

/** Clears a dashboard's saved layout (columns, wide row, heights, widths) back to the default arrangement. */
function resetDashLayout(dash, screenKey) {
  delete dashboardLayout[screenKey];
  saveDashboardLayout();
  for (const box of dash.querySelectorAll(".dash-box")) box.style.height = "";
  applyDashLayout(dash, screenKey);
}

/** Wires up drag-to-rearrange + resize for a dashboard's boxes (desktop only; a no-op on repeat calls). */
function initDashboard(dashId, screenKey) {
  const dash = $(dashId);
  if (!dash) return;
  applyDashLayout(dash, screenKey);
  if (dashInited.has(dashId)) return;
  dashInited.add(dashId);

  if (!dash.querySelector(":scope > .dash-reset")) {
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "dash-reset";
    resetBtn.title = "Reset layout";
    resetBtn.textContent = "Reset layout";
    resetBtn.addEventListener("click", () => resetDashLayout(dash, screenKey));
    dash.prepend(resetBtn);
  }

  let dragging = null;

  for (const box of dash.querySelectorAll(".dash-box")) {
    if (box.querySelector(".dash-box-content")) continue; // already wired (layout reload after login)

    // Move the box's real content into a scrolling wrapper so the box
    // itself never scrolls — that keeps the handle/resize grip (siblings,
    // pinned to the box's corners) fixed in place while content scrolls.
    const content = document.createElement("div");
    content.className = "dash-box-content";
    while (box.firstChild) content.appendChild(box.firstChild);
    box.appendChild(content);

    const handle = document.createElement("div");
    handle.className = "dash-box-handle";
    handle.title = "Drag to rearrange";
    handle.textContent = "⠿";
    box.append(handle);

    const resizer = document.createElement("div");
    resizer.className = "dash-box-resize";
    resizer.title = "Drag to resize";
    box.append(resizer);

    handle.addEventListener("mousedown", () => { box.draggable = true; });
    handle.addEventListener("mouseup", () => { box.draggable = false; });

    box.addEventListener("dragstart", (e) => {
      dragging = box;
      box.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    box.addEventListener("dragend", () => {
      box.draggable = false;
      box.classList.remove("dragging");
      dragging = null;
      const colsWrap = dash.querySelector(":scope > .dash-cols");
      if (colsWrap) for (const c of colsWrap.querySelectorAll(".dash-col")) c.classList.remove("drag-target");
      pruneEmptyDashColumns(dash, screenKey);
      captureDashLayout(dash, screenKey);
    });

    resizer.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      resizer.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startY = e.clientY;
      const startWidth = box.getBoundingClientRect().width;
      const startHeight = box.getBoundingClientRect().height;

      const onMove = (ev) => {
        const dy = ev.clientY - startY;
        box.style.height = Math.max(DASH_MIN_BOX_HEIGHT, startHeight + dy) + "px";
        // Dragging the grip far enough to the right promotes the box to
        // full-width (the "wide" row below the columns).
        const dx = ev.clientX - startX;
        if (dx > startWidth * DASH_WIDE_DRAG_PX && box.parentElement.classList.contains("dash-col")) {
          dash.appendChild(box);
        }
      };
      const onUp = (ev) => {
        resizer.releasePointerCapture(ev.pointerId);
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        pruneEmptyDashColumns(dash, screenKey);
        captureDashLayout(dash, screenKey);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
  }

  // Delegated on document (not the dash element) because dragover stops
  // firing on `dash` the instant the pointer crosses its own outer edge —
  // which is exactly where the "drag past the edge to add a column" check
  // needs to fire. `dragging` is scoped to this dashboard's closure, so
  // other dashboards' listeners no-op while this one is idle.
  document.addEventListener("dragover", (e) => {
    if (!dragging) return;
    e.preventDefault();

    const colsWrap = dash.querySelector(":scope > .dash-cols");
    const cols = colsWrap ? [...colsWrap.querySelectorAll(":scope > .dash-col")] : [];
    for (const c of cols) c.classList.remove("drag-target");

    const x = e.clientX;
    const y = e.clientY;
    const colsRect = colsWrap ? colsWrap.getBoundingClientRect() : null;

    // Below the columns row (or there's no row at all) => full-width "wide" placement.
    if (!colsRect || y > colsRect.bottom) {
      const wideBoxes = [...dash.querySelectorAll(":scope > .dash-box")].filter((b) => b !== dragging);
      const before = wideBoxes.find((b) => y < b.getBoundingClientRect().top + b.getBoundingClientRect().height / 2);
      if (before) dash.insertBefore(dragging, before);
      else dash.appendChild(dragging);
      pruneEmptyDashColumns(dash, screenKey);
      return;
    }
    if (!cols.length) return;

    const firstRect = cols[0].getBoundingClientRect();
    const lastRect = cols[cols.length - 1].getBoundingClientRect();

    // A drag that lingers past an outer edge fires this handler on every
    // animation frame. If the edge column already holds nothing but the box
    // being dragged, it *is* the new column from an earlier frame — reuse it
    // instead of spinning up another, which would otherwise create/prune a
    // fresh column every tick and could drop the box mid-thrash.
    const isSoloDragging = (col) => col.children.length === 1 && col.firstElementChild === dragging;

    let targetCol;
    if (x < firstRect.left - DASH_EDGE_PX && (cols.length < DASH_MAX_COLS || isSoloDragging(cols[0]))) {
      if (isSoloDragging(cols[0])) {
        targetCol = cols[0];
      } else {
        targetCol = document.createElement("div");
        targetCol.className = "dash-col";
        colsWrap.insertBefore(targetCol, cols[0]);
        layoutDashSplitters(dash, screenKey);
      }
    } else if (x > lastRect.right + DASH_EDGE_PX && (cols.length < DASH_MAX_COLS || isSoloDragging(cols[cols.length - 1]))) {
      if (isSoloDragging(cols[cols.length - 1])) {
        targetCol = cols[cols.length - 1];
      } else {
        targetCol = document.createElement("div");
        targetCol.className = "dash-col";
        colsWrap.appendChild(targetCol);
        layoutDashSplitters(dash, screenKey);
      }
    } else {
      let bestDist = Infinity;
      for (const col of cols) {
        const r = col.getBoundingClientRect();
        const dist = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
        if (dist < bestDist) { bestDist = dist; targetCol = col; }
      }
    }

    targetCol.classList.add("drag-target");
    const siblings = [...targetCol.querySelectorAll(":scope > .dash-box")].filter((b) => b !== dragging);
    const before = siblings.find((sib) => y < sib.getBoundingClientRect().top + sib.getBoundingClientRect().height / 2);
    if (before) targetCol.insertBefore(dragging, before);
    else targetCol.appendChild(dragging);

    pruneEmptyDashColumns(dash, screenKey);
  });
  document.addEventListener("drop", (e) => { if (dragging) e.preventDefault(); });
}

function initProfileDashboard() { initDashboard("profile-dashboard", "profile"); }
function initDetailDashboard() { initDashboard("detail-dashboard", "detail"); }
function initHubDashboard() { initDashboard("hub-dashboard", "hub"); }

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

  // The account's saved dashboard layout wins over whatever this device had
  // locally — signing in on a second device should show the same layout.
  const serverLayout = await db.getAccountDashboardLayout(acct.uid);
  if (serverLayout) {
    dashboardLayout = serverLayout;
    try { localStorage.setItem(DASH_LAYOUT_KEY, JSON.stringify(dashboardLayout)); } catch {}
    if (!$("screen-hub").classList.contains("hidden")) initHubDashboard();
    if (!$("screen-profile").classList.contains("hidden")) initProfileDashboard();
    if (!$("screen-detail").classList.contains("hidden")) initDetailDashboard();
  } else if (Object.keys(dashboardLayout).length) {
    await db.setAccountDashboardLayout(acct.uid, dashboardLayout);
  }

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

  let bonusSeconds = 0;
  for (const g of list) {
    const meId = myId(g);
    for (const c of g.claims || []) {
      if (c.status === "settled" && c.by === meId && (c.multiplier || 1) > 1) {
        bonusSeconds += (c.seconds || 0) - (c.rawSeconds || 0);
      }
    }
  }

  setHTML(
    "profile-record",
    [
      ["Wins", String(wins)],
      ["Losses", String(losses)],
      ["Ties", String(ties)],
      ["Ongoing", String(ongoing)],
      ["Bonus time gained", fmtDuration(bonusSeconds)],
    ]
      .map(
        ([l, v]) =>
          `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${v}</div></div>`
      )
      .join("")
  );

  const gamesHtml =
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

  const gamesHost = $("profile-games");
  if (gamesHost.dataset.sig !== gamesHtml) {
    gamesHost.dataset.sig = gamesHtml;
    gamesHost.innerHTML = gamesHtml;
    gamesHost.querySelectorAll("[data-open]").forEach((el) =>
      el.addEventListener("click", () => openDetail(el.dataset.open))
    );
  }

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

  renderMinigameBreakdown(list, gameFilter);
}

/**
 * All-time record broken out per minigame type (rather than one combined
 * total), so a lopsided coin-flip record doesn't hide behind a good overall
 * win rate. Always all-time and independent of the minigame-type filter above
 * — that filter narrows the period table to one type, this shows all of them
 * side by side.
 */
/**
 * Which minigame rows are expanded in the profile breakdown. This screen
 * re-renders on the same 200ms tick as everything else, so without baking
 * the open state back into the markup every render, the very next tick would
 * blow away a <details> the instant you opened it — same issue and same fix
 * as the feed's `openFeedRuns` above.
 */
const openMinigameRows = new Set();
let minigameBreakdownWired = false;

function renderMinigameBreakdown(list, gameFilter) {
  const host = $("profile-minigame-breakdown");
  if (!minigameBreakdownWired) {
    minigameBreakdownWired = true;
    // `toggle` doesn't bubble, but a capturing listener still sees it on the way down.
    host.addEventListener(
      "toggle",
      (e) => {
        const li = e.target.closest?.("[data-key]");
        if (!li || e.target.tagName !== "DETAILS") return;
        if (e.target.open) openMinigameRows.add(li.dataset.key);
        else openMinigameRows.delete(li.dataset.key);
      },
      true
    );
  }

  const byType = {}; // minigame key -> { wins, losses, ties, entries }
  for (const key of Object.keys(DUEL_META)) byType[key] = { wins: 0, losses: 0, ties: 0, entries: [] };

  for (const g of list) {
    if (gameFilter !== "__all__" && g.code !== gameFilter) continue;
    const meId = myId(g);
    const opp = opponentOf(g);
    if (!opp) continue;
    for (const c of g.claims || []) {
      if (!c.viaDuel || c.status !== "settled" || !c.game || !byType[c.game]) continue;
      const won = c.by === meId;
      if (!won && c.by !== opp.id) continue;
      if (won) byType[c.game].wins++;
      else byType[c.game].losses++;
      byType[c.game].ties += c.ties || 0;
      byType[c.game].entries.push({ at: c.at, seconds: c.seconds || 0, won, meId, ties: c.ties || 0, mgd: c.mgDetail || null });
    }
  }

  const html = Object.entries(DUEL_META)
    .map(([key, meta]) => {
      const { wins, losses, ties, entries } = byType[key];
      const total = wins + losses;
      const pct = total ? `${Math.round((wins / total) * 100)}%` : "—";
      return `<li class="mg-row" style="--mg-color:${meta.color}" data-key="${key}">
        <details ${openMinigameRows.has(key) ? "open" : ""}>
          <summary>
            <span class="mg-tag">${meta.icon} ${esc(meta.label)}</span>
            <span class="mg-rec">${wins}W – ${losses}L${ties ? ` – ${ties}T` : ""}</span>
            <span class="mg-pct">${pct}</span>
          </summary>
          <div class="mg-detail">${minigameDetailHtml(key, entries)}</div>
        </details>
      </li>`;
    })
    .join("");

  setHTML("profile-minigame-breakdown", html);
}

const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
/** Most frequent value; ties break toward whichever appears first. */
function mode(arr) {
  const counts = new Map();
  let best = null;
  let bestCount = 0;
  for (const v of arr) {
    const c = (counts.get(v) || 0) + 1;
    counts.set(v, c);
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

function mgStat(label, value) {
  return `<div class="mg-stat"><span class="mg-stat-label">${esc(label)}</span><span class="mg-stat-value">${value}</span></div>`;
}

/** Deeper numbers for one minigame type, built from each claim's persisted `mgDetail` — absent on duels settled before this shipped. */
function minigameDetailHtml(key, entries) {
  const tracked = entries.filter((e) => e.mgd && (e.mgd.detail || e.mgd.picks));
  if (!tracked.length) {
    return `<p class="mg-empty">${entries.length ? "No detailed numbers recorded for these — they're from before per-throw tracking shipped." : "No duels here yet."}</p>`;
  }
  const untracked = entries.length - tracked.length;
  const note = untracked
    ? `<p class="mg-empty">${untracked} earlier duel${untracked === 1 ? "" : "s"} here ${untracked === 1 ? "isn't" : "aren't"} counted below (no detail recorded).</p>`
    : "";

  const mine = (e, sideA, sideB) => {
    const d = e.mgd.detail;
    if (!d) return null;
    return e.mgd.challenger === e.meId ? d[sideA] : d[sideB];
  };

  switch (key) {
    case "dice": {
      const rollOf = (e) => mine(e, "rollA", "rollB");
      const rolls = tracked.map(rollOf).filter((v) => Number.isFinite(v));
      if (!rolls.length) return note || `<p class="mg-empty">No rolls recorded.</p>`;
      const perRoll = [1, 2, 3, 4, 5, 6]
        .map((n) => {
          const mineOfN = tracked.filter((e) => rollOf(e) === n);
          const wins = mineOfN.filter((e) => e.won).length;
          const pct = mineOfN.length ? `${Math.round((wins / mineOfN.length) * 100)}%` : "—";
          return mgStat(`Rolled ${n} winrate`, `${pct} (${mineOfN.length})`);
        })
        .join("");
      return (
        mgStat("Most rolled", mode(rolls)) +
        mgStat("Average roll", mean(rolls).toFixed(2)) +
        mgStat("Rolls tracked", rolls.length) +
        perRoll +
        note
      );
    }
    case "golf": {
      const distOf = (e) => mine(e, "distA", "distB");
      const dists = tracked.map(distOf).filter((v) => Number.isFinite(v));
      if (!dists.length) return note || `<p class="mg-empty">No putts recorded.</p>`;
      const totalHolesMade = dists.filter((d) => d === 0).length;
      const sorted = tracked.slice().sort((a, b) => a.at - b.at);
      let bestWinStreak = 0,
        curWin = 0;
      let highestStreak = 0,
        curMade = 0;
      let firstHoleStreak = 0,
        curFirstHole = 0;
      for (const e of sorted) {
        if (e.won) {
          curWin++;
          bestWinStreak = Math.max(bestWinStreak, curWin);
        } else curWin = 0;

        const made = distOf(e) === 0;
        if (made) {
          curMade++;
          highestStreak = Math.max(highestStreak, curMade);
        } else curMade = 0;

        if (made && (e.ties || 0) === 0) {
          curFirstHole++;
          firstHoleStreak = Math.max(firstHoleStreak, curFirstHole);
        } else curFirstHole = 0;
      }
      return (
        mgStat("Total holes made", totalHolesMade) +
        mgStat("Highest streak", highestStreak) +
        mgStat("Longest streak of 1st hole made", firstHoleStreak) +
        mgStat("Best win streak", bestWinStreak) +
        mgStat("Furthest miss", `${Math.round(Math.max(...dists))} from the hole`) +
        mgStat("Average distance", Math.round(mean(dists))) +
        note
      );
    }
    case "coin": {
      const longestTieStreak = entries.length ? Math.max(...entries.map((e) => e.ties || 0)) : 0;
      const doubles = tracked.filter((e) => e.mgd.doubled && e.mgd.doubler === e.meId);
      const doublesWon = doubles.filter((e) => !e.mgd.doubleLost);
      const gained = doublesWon.reduce((s, e) => s + (e.seconds - (e.mgd.potSeconds || 0)), 0);
      const perCall = ["heads", "tails"]
        .map((side) => {
          const mineOfSide = tracked.filter((e) => e.mgd.picks?.[e.meId] === side);
          const wins = mineOfSide.filter((e) => e.won).length;
          const losses = mineOfSide.length - wins;
          return mgStat(`${side === "heads" ? "🪙 Heads" : "🪙 Tails"} record`, `${wins}W – ${losses}L`);
        })
        .join("");
      return (
        mgStat("Went double-or-nothing", doubles.length) +
        mgStat("Doubles won", doublesWon.length) +
        mgStat("Time gained from doubling", fmtDuration(gained)) +
        mgStat("Longest tie streak", longestTieStreak) +
        perCall +
        note
      );
    }
    case "rps": {
      const longestTieStreak = entries.length ? Math.max(...entries.map((e) => e.ties || 0)) : 0;
      const throws = tracked.map((e) => e.mgd.picks?.[e.meId]).filter(Boolean);
      if (!throws.length)
        return mgStat("Longest tie streak", longestTieStreak) + (note || `<p class="mg-empty">No throws recorded.</p>`);
      const wonThrows = tracked.filter((e) => e.won).map((e) => e.mgd.picks?.[e.meId]).filter(Boolean);
      const perSymbol = THROWS.map((sym) => {
        const mineOfSym = tracked.filter((e) => e.mgd.picks?.[e.meId] === sym);
        const winsOfSym = mineOfSym.filter((e) => e.won).length;
        const pct = mineOfSym.length ? `${Math.round((winsOfSym / mineOfSym.length) * 100)}%` : "—";
        return mgStat(`${THROW_EMOJI[sym]} ${sym} winrate`, `${pct} (${mineOfSym.length})`);
      }).join("");
      return (
        mgStat("Most used throw", `${THROW_EMOJI[mode(throws)]} ${mode(throws)}`) +
        (wonThrows.length ? mgStat("Most won with", `${THROW_EMOJI[mode(wonThrows)]} ${mode(wonThrows)}`) : "") +
        mgStat("Longest tie streak", longestTieStreak) +
        perSymbol +
        note
      );
    }
    case "reaction": {
      const latencies = tracked
        .map((e) => {
          const falseStart = mine(e, "falseStartA", "falseStartB");
          const latency = mine(e, "latencyA", "latencyB");
          return falseStart || !Number.isFinite(latency) || latency < 0 ? null : latency;
        })
        .filter((v) => v !== null);
      if (!latencies.length) return note || `<p class="mg-empty">No clean reactions recorded.</p>`;
      return (
        mgStat("Fastest", `${Math.round(Math.min(...latencies))}ms`) +
        mgStat("Slowest", `${Math.round(Math.max(...latencies))}ms`) +
        mgStat("Average", `${Math.round(mean(latencies))}ms`) +
        note
      );
    }
    case "closest": {
      const guesses = tracked
        .map((e) => {
          const raw = Number(e.mgd.picks?.[e.meId]);
          if (!Number.isFinite(raw)) return null;
          // Legacy 1-100 guesses (if the range ever changes) fold down to 1-10.
          const bucket = raw > 10 ? Math.max(1, Math.min(10, Math.round(raw / 10))) : Math.round(raw);
          return { bucket, won: e.won };
        })
        .filter(Boolean);
      if (!guesses.length) return note || `<p class="mg-empty">No guesses recorded.</p>`;
      const rows = Array.from({ length: 10 }, (_, i) => i + 1)
        .map((n) => {
          const of = guesses.filter((g) => g.bucket === n);
          if (!of.length) return "";
          const wins = of.filter((g) => g.won).length;
          const pct = `${Math.round((wins / of.length) * 100)}%`;
          return mgStat(`Guessed ${n}`, `${pct} winrate (${of.length})`);
        })
        .join("");
      return rows + note;
    }
    default:
      return note || `<p class="mg-empty">Nothing tracked for this minigame yet.</p>`;
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

/**
 * Recent-activity trend: for each of the last-hour/6h/day windows, how much
 * each side has actually claimed (not the mathematical max — the real pace).
 * Used to say whether the current lead looks like it's holding up or not,
 * as a softer companion to the hard unwinnable-by math in `catchUpWindow`.
 *
 * @returns null when there's no opponent, otherwise
 *   { windows: [{ key, label, mine, theirs, diff }], lead, verdict }
 *   `verdict` is a short human sentence describing the trend given `lead`.
 */
function paceFor(g) {
  const opp = opponentOf(g);
  if (!opp) return null;

  const { rows } = totalsFor(g);
  const mine = rows[myId(g)]?.all.claimed || 0;
  const theirs = rows[opp.id]?.all.claimed || 0;
  const lead = mine - theirs;

  // How much more, per that same bucket size, you'd need to be ahead of your
  // opponent by — sustained for the rest of the game — to erase the gap
  // exactly by the deadline. That's the deficit spread evenly over the
  // remaining time. Compared directly against `diff` (what you're actually
  // up by in that window) to flag when the real margin is falling short.
  // A rough guide, not the exact math `catchUpWindow` does — it doesn't
  // account for exactly where 2x windows fall.
  const remainMs = Math.max(0, g.meta.endsAt - db.now());

  const windows = ["1h", "6h", "1d", "3d"].map((key) => {
    const p = PERIODS.find((x) => x.key === key);
    const m = rows[myId(g)]?.[key]?.claimed || 0;
    const t = rows[opp.id]?.[key]?.claimed || 0;
    const need = lead !== 0 && remainMs > 0 ? Math.abs(lead) * (p.ms / remainMs) : null;
    return { key, label: p.label, ms: p.ms, mine: m, theirs: t, diff: m - t, need };
  });

  // Prefer the freshest window that actually has activity in it, so a quiet
  // last hour doesn't drown out a real trend visible over the last day.
  const primary = windows.find((w) => w.mine + w.theirs > 0) || windows[windows.length - 1];

  let verdict;
  if (lead === 0) {
    verdict =
      primary.diff > 0
        ? "Tied, but you've been pulling ahead recently."
        : primary.diff < 0
          ? "Tied, but they've been pulling ahead recently."
          : "Tied, and pace is even.";
  } else if (lead > 0) {
    verdict =
      primary.diff > 0
        ? "You're winning and on pace to stay ahead."
        : primary.diff < 0
          ? "You're winning, but they're closing the gap — watch this."
          : "You're winning and holding steady.";
  } else {
    verdict =
      primary.diff > 0
        ? "You're losing, but you're closing the gap."
        : primary.diff < 0
          ? "You're losing and falling further behind."
          : "You're losing and holding steady — not closing the gap.";
  }

  return { windows, lead, verdict, forMe: lead < 0 };
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

/**
 * Duel history for a single (1v1) game: overall record against this
 * opponent, the individual settled duels (most recent first), and how many
 * of the most recent claims in a row were contested — a "hot streak" of
 * disputes rather than clean claims.
 */
function duelStatsFor(g) {
  const meId = myId(g);
  const opp = opponentOf(g);
  const claims = g.claims || [];

  const settled = claims.filter((c) => c.status === "settled");
  let streak = 0;
  for (let i = settled.length - 1; i >= 0; i--) {
    if (!settled[i].viaDuel) break;
    streak++;
  }

  const history = [];
  let wins = 0, losses = 0, ties = 0;
  for (const c of claims) {
    if (!c.viaDuel || c.status !== "settled") continue;
    const won = c.by === meId;
    if (!won && opp && c.by !== opp.id) continue; // shouldn't happen in a 1v1
    if (won) wins++; else losses++;
    ties += c.ties || 0;
    history.push({ at: c.at, game: c.game || null, won, ties: c.ties || 0 });
  }
  history.sort((a, b) => b.at - a.at);

  return { wins, losses, ties, streak, history };
}

/** The game-card badge for a currently-open duel: which minigame, hoverable for the matchup's history. */
function duelBadgeFor(g, duel) {
  const meta = DUEL_META[duel.game] || DUEL_META.rps;
  const opp = opponentOf(g);
  const stats = duelStatsFor(g);

  const rows = stats.history
    .slice(0, 8)
    .map((h) => {
      const hMeta = h.game ? DUEL_META[h.game] : null;
      const label = hMeta ? `${hMeta.icon} ${hMeta.label}` : "Unknown minigame";
      const tieNote = h.ties ? ` · ${h.ties} tie${h.ties === 1 ? "" : "s"} first` : "";
      return `<li class="${h.won ? "win" : "loss"}">${h.won ? "You won" : `${esc(opp?.name || "They")} won`} — ${esc(label)}${tieNote}</li>`;
    })
    .join("");

  return `
    <span class="gc-flag duel gc-duel-badge" style="--mg-color:${meta.color}" tabindex="0">
      ${meta.icon} ${esc(meta.label)}
      <div class="gc-duel-tip">
        <div class="gc-duel-tip-record">
          <span class="win">${stats.wins}W</span> · <span class="loss">${stats.losses}L</span> · <span class="tie">${stats.ties} tie${stats.ties === 1 ? "" : "s"}</span>
        </div>
        ${stats.streak > 1 ? `<div class="gc-duel-tip-streak">⚔ ${stats.streak} contested claims in a row</div>` : ""}
        ${rows ? `<ul class="gc-duel-tip-list">${rows}</ul>` : `<p class="gc-duel-tip-empty">No past duels yet — this is the first.</p>`}
      </div>
    </span>`;
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
  }
  render();
}

/**
 * A player clicked "I'm ready" on a reaction duel. Reports their side clear
 * and, if that makes both sides clear, starts the round's clock (see
 * engine.applyReactionClear/applyStartReaction, driven by db.checkReactionStart).
 */
async function markReactionReady(code, duelId, playerId) {
  await db.checkReactionStart(code, duelId, playerId, true);
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

  const startedAt = Math.max(
    (d.status === "double_offer" ? d.decidedAt : d.roundStartAt || d.createdAt) || 0,
    d.lastActivityAt || 0
  );
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
  // Ticking fields (clock, cooldown, catch-up countdown) change every 200ms
  // and used to be baked into the signature string below, so the whole list
  // got torn down and rebuilt ~5x/second — killing hover state and eating
  // clicks mid-interaction. `sig` excludes those so a rebuild only happens on
  // an actual structural change; the ticking text is patched in place after.
  const sigKeys = [];
  const html = roster
    .map((entry) => {
      const g = games.get(entry.code);
      if (!g || !g.meta) {
        sigKeys.push(`${entry.code}|loading`);
        return `<div class="game-card loading">
                <div class="gc-main"><div class="gc-name">${esc(entry.code)}</div>
                <div class="gc-sub">loading…</div></div>
                <button class="gc-remove" data-forget="${esc(entry.code)}" title="Remove — this game never loaded">✕</button>
                </div>`;
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
      const catchUpHtml = catchUpHtmlFor(catchUp, opp, remain);
      const pace = over ? null : paceFor(g);
      const paceHtml = paceHtmlFor(pace);

      // Only these decide whether the DOM needs to be torn down and rebuilt;
      // seconds-precision countdown text is intentionally left out so a
      // rebuild doesn't happen every tick (see note above renderGameList).
      sigKeys.push([
        g.code, over, duel, hot, synced, !!opp, mine, theirs, oppOnline,
        status ? status.cls : "", catchUp ? `${catchUp.final}|${catchUp.forMe}` : "",
        pace ? pace.verdict : "",
      ].join("|"));

      const duelBadgeHtml = duel ? duelBadgeFor(g, duel) : "";

      return `
      <div class="game-card ${over ? "over" : ""} ${duel ? "duel" : ""}" data-code="${esc(g.code)}">
        <div class="gc-main" data-open="${esc(g.code)}">
          <div class="gc-head">
            <span class="gc-name">${esc(gameLabel(g))}</span>
            ${hot ? '<span class="gc-flag hot">2x</span>' : ""}
            ${duelBadgeHtml}
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
            ${over ? "" : `<span class="gc-clock">${fmtDuration(onClock(g))} on the clock</span> · `}<span class="gc-deadline">${deadline}</span>
          </div>
          <div class="gc-catchup-wrap">${catchUpHtml}</div>
          <div class="gc-pace-wrap">${paceHtml}</div>
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
  const sig = sigKeys.join(",,");

  if (host.dataset.sig !== sig) {
    host.dataset.sig = sig;
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
    host.querySelectorAll("[data-forget]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const code = b.dataset.forget;
        if (confirm(`Remove ${code}? It never finished loading, so it'll just be forgotten here.`)) {
          removeFromRoster(code);
        }
      })
    );
  }

  // Patch ticking text in place every call (rebuild or not) so the countdown
  // still updates live without recreating any nodes — that's what keeps
  // hover/click stable while a card is under the cursor.
  roster.forEach((entry) => {
    const g = games.get(entry.code);
    if (!g || !g.meta) return;
    const card = host.querySelector(`[data-code="${CSS.escape(g.code)}"]`);
    if (!card) return;
    const over = isOver(g);

    const clockEl = card.querySelector(".gc-clock");
    if (clockEl) clockEl.textContent = `${fmtDuration(onClock(g))} on the clock`;

    const remain = g.meta.endsAt - db.now();
    const deadline = over
      ? "ended"
      : remain < 86400e3
        ? `${Math.max(0, Math.floor(remain / 3600e3))}h left`
        : `${Math.ceil(remain / 86400e3)}d left`;
    const deadlineEl = card.querySelector(".gc-deadline");
    if (deadlineEl) deadlineEl.textContent = deadline;

    const statusEl = card.querySelector(".gc-status");
    if (statusEl) {
      const cdLeft = cooldownLeft(g);
      if (!over && cdLeft > 0) statusEl.textContent = `Ready in ${(cdLeft / 1000).toFixed(1)}s`;
    }

    const catchUp = over ? null : catchUpWindow(g);
    const catchUpWrap = card.querySelector(".gc-catchup-wrap");
    if (catchUp && catchUpWrap) {
      const opp = opponentOf(g);
      catchUpWrap.innerHTML = catchUpHtmlFor(catchUp, opp, remain);
    }

    const pace = over ? null : paceFor(g);
    const paceWrap = card.querySelector(".gc-pace-wrap");
    if (pace && paceWrap) paceWrap.innerHTML = paceHtmlFor(pace);
  });
}

/**
 * Countdown to the deadline that used to live here (how long until a lead
 * becomes mathematically unwinnable) was misleading on its own — it assumes
 * the trailing player claims literally every remaining second, so it reads
 * like a hard deadline when it's really a best-case one. Replaced with the
 * plain time-until-the-game-ends plus the clinch numbers, which are the
 * activity-based (not time-based) thing worth actually watching.
 */
function catchUpHtmlFor(catchUp, opp, remainMs) {
  if (!catchUp) return "";
  if (catchUp.final) {
    return catchUp.forMe
      ? `<div class="gc-catchup lost">You can no longer catch up.</div>`
      : `<div class="gc-catchup safe">${esc(opp?.name || "They")} can no longer catch up.</div>`;
  }
  let html = `<div class="gc-catchup">${fmtDuration(Math.max(0, remainMs) / 1000)} until the game ends</div>`;
  // Only the leader has a meaningful clinch number — the trailing side is by
  // definition not yet in a position to lock it in.
  html += catchUp.forMe
    ? `<div class="gc-clinch">${esc(opp?.name || "They")} win outright with ${fmtDuration(catchUp.theyNeed)} more</div>`
    : `<div class="gc-clinch">You win outright with ${fmtDuration(catchUp.youNeed)} more</div>`;
  return html;
}

/** "mm:ss", or "hh:mm:ss" once it runs an hour or past — for the tight
 * per-row catch-up parenthetical, where the compact word form reads noisy. */
function fmtMmSs(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function paceHtmlFor(pace) {
  if (!pace) return "";
  const rows = pace.windows
    .map((w) => {
      const active = w.mine + w.theirs > 0;
      // Red whenever the margin you're actually up by is falling short of
      // what you'd need to sustain to close the gap by the deadline —
      // regardless of whether that margin is nominally positive or negative.
      const short = w.need != null && w.diff < w.need;
      const cls = short ? "short" : w.diff > 0 ? "up" : w.diff < 0 ? "down" : "";
      const text = active ? `${w.diff > 0 ? "+" : w.diff < 0 ? "−" : ""}${fmtMmSs(Math.abs(w.diff))}` : "—";
      const needText = w.need != null ? ` <span class="gc-pace-need">(need ${fmtMmSs(w.need)})</span>` : "";
      return `<div class="gc-pace-row"><span class="gc-pace-label">${esc(w.label)}</span><span class="gc-pace-diff ${cls}">${text}${needText}</span></div>`;
    })
    .join("");
  const verdictCls = pace.lead === 0 ? "" : pace.lead > 0 ? "safe" : "lost";
  return `<div class="gc-pace">
    <div class="gc-pace-title">Pace</div>
    ${rows}
    <div class="gc-pace-verdict ${verdictCls}">${esc(pace.verdict)}</div>
  </div>`;
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
/** Reshape groupRuns() output into barChart-compatible rows, one bar per streak. */
function runsToBarRows(runs) {
  return runs.map((r, i) => ({
    order: i + 1,
    at: r.to,
    by: r.by,
    mine: r.mine,
    seconds: r.seconds,
    rawSeconds: r.rawSeconds,
    multiplier: r.anyDoubled ? 2 : 1,
    viaDuel: r.anyDuel,
    count: r.count,
  }));
}

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
  const claimBars = claimRows(merged, "__me__");
  const rows = sortRows(mergeClicks ? runsToBarRows(groupRuns(claimBars)) : claimBars, clickSort);
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

/** Colored chip for one settled duel — hover/focus for what actually happened in that specific duel. */
function duelTag(g, row) {
  const meta = DUEL_META[row.game];
  if (!meta) return '<span class="f-tag duel">DUEL</span>';
  const meId = myId(g);
  // A lost double-or-nothing leaves `row.by` as whoever won the original
  // flip, but nobody actually banked the pot — say so instead of "won".
  const verdict = row.mgDetail?.potLost
    ? `<span class="loss">${row.mine ? "You" : esc(g.players?.[row.by]?.name || "They")} won the flip, but the double lost — nobody claimed it</span>`
    : row.mine
      ? `<span class="win">You won</span>`
      : `<span class="loss">${esc(g.players?.[row.by]?.name || "They")} won</span>`;

  let detailLine = "";
  if (row.mgDetail?.detail || row.mgDetail?.picks) {
    const oppId = row.mgDetail.challenger === meId ? row.mgDetail.defender : row.mgDetail.challenger;
    const oppName = g.players?.[oppId]?.name || "They";
    const d = {
      game: row.game,
      finalPicks: row.mgDetail.picks || {},
      detail: row.mgDetail.detail || {},
      challenger: row.mgDetail.challenger,
    };
    detailLine = `<div class="gc-duel-tip-streak">${resultDetailHtml(d, meId, oppId, oppName)}</div>`;
  }

  const tieNote = row.ties ? `<div class="gc-duel-tip-streak">${row.ties} redraw${row.ties === 1 ? "" : "s"} first</div>` : "";

  let doubleNote = "";
  if (row.mgDetail?.doubled && !row.mgDetail?.potLost) {
    const doublerName = row.mgDetail.doubler === meId ? "You" : g.players?.[row.mgDetail.doubler]?.name || "They";
    doubleNote = `<div class="gc-duel-tip-streak">${doublerName} went double-or-nothing and won.</div>`;
  }

  return `<span class="f-tag duel gc-duel-badge" style="--mg-color:${meta.color}" tabindex="0">
    ${meta.icon} ${esc(meta.label)}
    <div class="gc-duel-tip">
      <div class="gc-duel-tip-record">${verdict}</div>
      ${detailLine}
      ${doubleNote}
      ${tieNote}
    </div>
  </span>`;
}

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
              (run.duelGames.length
                ? run.duelGames.map((k) => duelTag(g, run.duelReps[k])).join("")
                : run.anyDuel
                  ? '<span class="f-tag duel">DUEL</span>'
                  : "") +
              (run.items.some((i) => i.id === escrowedId)
                ? '<span class="f-tag duel">ESCROW</span>'
                : "");

            if (run.count === 1) {
              return `<li>
                <span class="f-who">${esc(who)}</span>
                <span class="f-amt">${fmtDuration(run.seconds)}</span>
                ${tags}
                <span class="f-when" data-when="${run.to}"></span>
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
                  ${i.viaDuel ? (i.game ? duelTag(g, i) : '<span class="f-tag duel">DUEL</span>') : ""}
                  <span class="f-when" data-when="${i.at}"></span>
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
                  <span class="f-when" data-when="${run.to}"></span>
                </summary>
                <ul class="splits">${splits}</ul>
              </details>
            </li>`;
          })
          .join("")
      : `<li class="feed-empty">No claims yet.</li>`
  );

  // Patched in place every call (rebuild or not) — baking the "…ago" text
  // straight into the html would change the string every tick, forcing
  // setHTML to tear down and rebuild the whole list each time and killing
  // hover state on anything under the cursor (e.g. the duel tag tooltip).
  host.querySelectorAll("[data-when]").forEach((el) => {
    el.textContent = fmtAgo(db.now() - Number(el.dataset.when));
  });
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
  $("btn-merge-clicks").addEventListener("click", () => {
    mergeClicks = !mergeClicks;
    store.set("mergeClicks", mergeClicks);
    $("btn-merge-clicks").classList.toggle("active", mergeClicks);
    $("btn-merge-clicks").setAttribute("aria-pressed", String(mergeClicks));
    renderHubStats();
  });
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
  $("btn-merge-clicks").classList.toggle("active", mergeClicks);
  $("btn-merge-clicks").setAttribute("aria-pressed", String(mergeClicks));
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

function renderDuelModal() {
  const host = $("rps-host");
  const entries = allActiveDuels();

  // Remove modals for duels that are no longer active.
  const activeKeys = new Set(entries.map((e) => `duel-${e.g.code}-${e.duel.id}`));
  for (const el of [...host.children]) {
    if (!activeKeys.has(el.id)) el.remove();
  }

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
      card.className = "modal-backdrop";
      card.id = key;
      card.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true">
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
          <p class="modal-lock" data-el="lock">You can't claim again until you've made your move.</p>
        </div>`;
      host.appendChild(card);

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
        const readyBtn = e.target.closest("[data-reaction-ready]");
        if (readyBtn) {
          const cur = games.get(g.code);
          const curDuel = cur?.state?.duel;
          if (!curDuel || curDuel.id !== d.id) return;
          readyBtn.disabled = true;
          markReactionReady(g.code, curDuel.id, myId(g)).then(render);
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
    const isCoin = d.game === "coin";
    const coinFace = isCoin ? d.detail?.result : null;
    const isDice = d.game === "dice";

    // Picker (also hosts the coin's double-or-nothing choice, once decided)
    const pickerEl = el("picker");
    pickerEl.classList.toggle("hidden", resolved);
    if (!resolved) {
      const sig = `${d.status}|${d.game}|${d.round}|${iPicked}|${
        d.game === "reaction" ? `${db.now() >= d.goAt}|${!!d.reactionClear?.[meId]}` : ""
      }`;
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
      resultEl.classList.remove("hidden");

      // Kick off (or continue) the coin's flip animation the moment this
      // resolution appears — not on every 200ms tick while it plays out.
      const resultSig = `${d.id}|${d.status}|${d.doubled}|${d.doubleLost}|${d.timedOut}`;
      if (coinFace && resultEl.dataset.flipSig !== resultSig) {
        resultEl.dataset.flipSig = resultSig;
        if (d.doubled) {
          // A genuine double-or-nothing gamble is a fresh flip, however far
          // the first one got — settle it with a couple of pulses.
          const secondFace = d.doubleLost ? (coinFace === "heads" ? "tails" : "heads") : coinFace;
          card.dataset.coinRevealAt = String(db.now() + COIN_FLIP_MS + COIN_PULSE_MS * COIN_PULSE_COUNT);
          playCoinFlip(resultEl, secondFace, { pulse: true });
        } else if (!card.dataset.coinRevealAt || db.now() >= Number(card.dataset.coinRevealAt)) {
          // No flip already in flight (e.g. this card just mounted after a
          // reload) — play one now instead of jumping straight to settled.
          card.dataset.coinRevealAt = String(db.now() + COIN_FLIP_MS);
          playCoinFlip(resultEl, coinFace);
        }
        // Otherwise the double_offer stage's flip is still spinning toward
        // this same face — let it run rather than restarting or cutting it off.
      }

      // Same idea for the die: tumble it for a beat before the roll numbers
      // land, so a fast bot response can't flash straight past the roll.
      if (isDice && resultEl.dataset.diceSig !== resultSig) {
        resultEl.dataset.diceSig = resultSig;
        card.dataset.diceRevealAt = String(db.now() + DICE_ROLL_MS);
        playDiceRoll(resultEl);
      }

      const stillFlipping = coinFace && card.dataset.coinRevealAt && db.now() < Number(card.dataset.coinRevealAt);
      const stillRolling = isDice && card.dataset.diceRevealAt && db.now() < Number(card.dataset.diceRevealAt);
      const stillAnimating = stillFlipping || stillRolling;
      statusEl.textContent = "";

      // While the coin/die is still animating, the pot stays on the "in
      // escrow" look — no "Doubled!"/"Settled" label — so a fast bot response
      // can't flash past the reveal.
      const potLabel = stillAnimating
        ? `In escrow${d.round > 1 ? ` · round ${d.round}` : ""}`
        : d.doubled && !d.doubleLost
          ? "Doubled!"
          : "Settled";
      el("pot").innerHTML = `<div class="pot-label">${potLabel}</div>
        <div class="pot-value">${fmtDuration(d.potSeconds * potMultiplier)}</div>`;

      // Hold the verdict/explanation back until the coin/die (if any) has
      // fully settled, so a fast bot response can't flash straight past it.
      if (!stillAnimating && resultEl.dataset.sig !== resultSig) {
        resultEl.dataset.sig = resultSig;

        const doubleNote = d.doubled
          ? d.doubleLost
            ? `<div class="rr-detail">Double-or-nothing gone wrong — the pot's gone, nobody claims it.</div>`
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
        const restHtml = d.potLost
          ? `
          <div class="rr-throws">${resultDetailHtml(d, meId, oppId, oppName)}</div>
          <div class="rr-verdict lost">Nobody takes it</div>
          <div class="rr-detail">The double-or-nothing flip lost — the pot's gone for good, ${esc(oppName)} gets nothing either.</div>
          ${timeoutNote}
          ${doubleNote}
          ${golfReplayHtml}`
          : `
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

        const finalFace = d.doubled ? (d.doubleLost ? (coinFace === "heads" ? "tails" : "heads") : coinFace) : coinFace;
        const coinHtml = finalFace
          ? `<div class="coin-flip-stage"><div class="coin-face settle ${finalFace}">${COIN_FACE[finalFace]}</div></div>
            <div class="coin-outcome ${finalFace}">${finalFace === "heads" ? "Heads" : "Tails"}</div>`
          : "";
        const diceHtml = isDice ? `<div class="dice-flip-stage"><div class="dice-face">🎲</div></div>` : "";
        resultEl.innerHTML = `${coinHtml}${diceHtml}${restHtml}`;

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

      el("pot").innerHTML = `<div class="pot-label">In escrow${d.round > 1 ? ` · round ${d.round}` : ""}</div>
        <div class="pot-value">${fmtDuration(d.potSeconds * potMultiplier)}</div>`;

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
            playCoinFlip(resultEl, coinResult);
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
      if (!d.goAt) {
        const iAmReady = !!d.reactionClear?.[meId];
        return iAmReady
          ? `<div class="duel-locked">Ready. Waiting for the other side…</div>`
          : `<button type="button" class="btn btn-primary duel-tap" data-reaction-ready>I'm ready</button>`;
      }
      const go = db.now() >= d.goAt;
      return go
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
const COIN_PULSE_MS = 350;
const COIN_PULSE_COUNT = 2;
let coinFlipSeq = 0;
const COIN_FACE = { heads: "👑", tails: "⭐" };

/**
 * Animate a coin flip into `el`: alternates the shown face between heads and
 * tails for COIN_FLIP_MS, then settles on `finalResult`. The outcome is
 * already decided server-side — this is purely a client-side reveal delay
 * for suspense. With `pulse: true` (the double-or-nothing re-flip), the
 * final face grows/shrinks a couple of times before settling, instead of
 * settling immediately.
 */
function playCoinFlip(el, finalResult, { pulse = false } = {}) {
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

  const outcomeLabel = finalResult === "heads" ? "Heads" : "Tails";
  setTimeout(() => {
    clearInterval(interval);
    if (el.dataset.flipToken !== token) return;
    el.innerHTML = `<div class="coin-flip-stage"><div class="coin-face ${pulse ? "pulse" : "settle"} ${finalResult}">${COIN_FACE[finalResult]}</div></div>
      <div class="coin-outcome ${finalResult}">${outcomeLabel}</div>`;
    if (pulse) {
      setTimeout(() => {
        if (el.dataset.flipToken !== token) return;
        const face = el.querySelector(".coin-face");
        if (face) face.className = `coin-face settle ${finalResult}`;
      }, COIN_PULSE_MS * COIN_PULSE_COUNT);
    }
  }, COIN_FLIP_MS);
}

const DICE_ROLL_MS = 1000;
const DICE_ROLL_TICK_MS = 90;
const DICE_FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
let diceRollSeq = 0;

/**
 * Animate a die roll into `el`: cycles through random die faces for
 * DICE_ROLL_MS, purely as a client-side reveal delay for suspense — the
 * actual roll is already decided server-side. The caller (render) rebuilds
 * `el` with the settled result once card.dataset.diceRevealAt elapses.
 */
function playDiceRoll(el) {
  const token = String(++diceRollSeq);
  el.dataset.rollToken = token;
  el.innerHTML = `<div class="dice-flip-stage"><div class="dice-face spin">${DICE_FACES[0]}</div></div>`;
  const faceEl = el.querySelector(".dice-face");

  const interval = setInterval(() => {
    if (el.dataset.rollToken !== token) return clearInterval(interval);
    faceEl.textContent = DICE_FACES[Math.floor(Math.random() * DICE_FACES.length)];
  }, DICE_ROLL_TICK_MS);

  setTimeout(() => clearInterval(interval), DICE_ROLL_MS);
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
      )} · target was ${detail.target}${detail.exact ? " · exact match! 5x payout" : ""}`;
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
