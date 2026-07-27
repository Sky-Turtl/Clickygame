// ---------------------------------------------------------------------------
// PASTE YOUR FIREBASE CONFIG HERE.
//
// 1. Go to https://console.firebase.google.com  ->  Add project
// 2. Build -> Realtime Database -> Create Database -> Start in TEST MODE
// 3. Project settings (gear icon) -> Your apps -> Web (</>) -> Register app
// 4. Copy the firebaseConfig object it shows you and paste it below.
//
// See README.md for the full walkthrough including security rules.
// ---------------------------------------------------------------------------

const firebaseConfig = {
  apiKey: "AIzaSyDxPhI8qK2GQvEsFkgTLcly-msUaRJGN8E",
  authDomain: "clicky-f87a3.firebaseapp.com",
  databaseURL: "https://clicky-f87a3-default-rtdb.firebaseio.com",
  projectId: "clicky-f87a3",
  storageBucket: "clicky-f87a3.firebasestorage.app",
  messagingSenderId: "910470214643",
  appId: "1:910470214643:web:ba420e8ceb57595cf49886"
};


// --- Game tuning ------------------------------------------------------------

// Two claims from *different* players inside this window trigger rock-paper-scissors.
export const TIE_WINDOW_MS = 3000;

// How many 1-hour double-time windows happen per day.
export const DOUBLE_WINDOWS_PER_DAY = 2;

// Multiplier applied during those windows.
export const DOUBLE_MULTIPLIER = 2;

// `dev/index.html` sets window.CLICKY_DEMO to run against the in-memory mock
// store, so the game is playable before Firebase is set up.
export const isConfigured = () =>
  globalThis.CLICKY_DEMO === true || !String(firebaseConfig.apiKey).includes("PASTE_ME");
