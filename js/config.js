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

// ---------------------------------------------------------------------------
// APP CHECK (optional, but strongly recommended)
//
// Firebase configs (above) are never secret — they're meant to ship to every
// visitor's browser. What actually stops a stranger from grabbing that config
// and writing their own script against your database is App Check: it makes
// every request carry a token proving it came from a real load of *this*
// site, not just anything that knows the config.
//
// 1. Firebase console -> Build -> App Check -> Apps -> your web app ->
//    Register -> reCAPTCHA v3 -> it gives you a site key from
//    https://www.google.com/recaptcha/admin (created for you automatically).
// 2. Paste that site key below.
// 3. Once you've confirmed real traffic is getting valid tokens (App Check
//    dashboard shows verified requests), flip "Enforce" on for Realtime
//    Database in the App Check console. Leave it un-enforced while testing —
//    enforcing before the site key is live here would lock everyone out,
//    including you.
//
// Leave this blank to skip App Check (the site still works, just without
// this protection).
export const RECAPTCHA_SITE_KEY = "6LeuyWstAAAAAFQwEdXJO_uMT0STeQyvOpH2tDVA";


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
