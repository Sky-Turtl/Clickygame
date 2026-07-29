// ---------------------------------------------------------------------------
// PASTE YOUR FIREBASE CONFIG HERE.
//
// 1. Go to https://console.firebase.google.com  ->  Add project
// 2. Build -> Realtime Database -> Create Database
//    (then set the security rules from README.md step 3)
// 3. Sidebar: Settings (gear) -> Project settings -> General -> Your apps
//    -> Web (</>) -> Register app
// 4. Copy the firebaseConfig object it shows you and paste it below, keeping
//    the `export` keyword in front of `const`.
//
// See README.md for the full walkthrough including security rules.
// ---------------------------------------------------------------------------

// Keep the `export` keyword — the rest of the app imports this by name.
export const firebaseConfig = {
  apiKey: "AIzaSyDxPhI8qK2GQvEsFkgTLcly-msUaRJGN8E",
  authDomain: "clicky-f87a3.firebaseapp.com",
  databaseURL: "https://clicky-f87a3-default-rtdb.firebaseio.com",
  projectId: "clicky-f87a3",
  storageBucket: "clicky-f87a3.firebasestorage.app",
  messagingSenderId: "910470214643",
  appId: "1:910470214643:web:ba420e8ceb57595cf49886"
};


// --- Game tuning ------------------------------------------------------------

// Two claims from *different* players inside this window trigger a duel minigame.
export const TIE_WINDOW_MS = 3000;

// How long you must wait after your OWN claim before you can claim again.
// Deliberately per-player, not global: a global minimum longer than
// TIE_WINDOW_MS would make it impossible for two claims to ever land within the
// tie window, silently killing duels. This stops one player machine-gunning
// the button while leaving duels intact.
export const MIN_CLAIM_INTERVAL_MS = 5000;

// How many 1-hour double-time windows happen per day.
export const DOUBLE_WINDOWS_PER_DAY = 2;

// Multiplier applied during those windows.
export const DOUBLE_MULTIPLIER = 2;

// Discord stays quiet for small claims — only a claim at or above this many
// seconds is worth a notification. Set to 0 to be told about every one.
export const NOTIFY_CLAIM_MIN_SECONDS = 30 * 60;

// `dev/index.html` sets window.CLICKY_DEMO to run against the in-memory mock
// store, so the game is playable before Firebase is set up.
export const isConfigured = () =>
  globalThis.CLICKY_DEMO === true || !String(firebaseConfig.apiKey).includes("PASTE_ME");
