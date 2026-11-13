// ─────────────────────────────────────────────────────────────
//  1. Paste your Firebase web-app config below (Firebase Console →
//     Project settings → Your apps → Web app → "Config").
//  2. Adjust SETTINGS to taste.
// ─────────────────────────────────────────────────────────────
export const firebaseConfig = {
  apiKey: "AIzaSyC-d6AO5K0wPPkv6KUkYx-KzZaG7B8s2d8",
  authDomain: "transportinventory-17902.firebaseapp.com",
  projectId: "transportinventory-17902",
  appId: "1:808563708285:web:7cdbcf13f844317616bc14",
};

export const SETTINGS = {
  ORG_NAME: "Patient Transport",
  APP_NAME: "Device Check-Out",

  // false = an employee can only hold one phone at a time.
  ALLOW_MULTIPLE_PER_EMPLOYEE: false,

  // After scanning an ID, how long the station waits for the phone scan.
  EMPLOYEE_PENDING_SECONDS: 20,
  // Longer window while someone is typing a PIN.
  PIN_SECONDS: 30,
  // Wrong PIN guesses before the station makes them scan their ID again.
  PIN_MAX_TRIES: 3,
  // How long the green/red result stays on screen before resetting.
  RESULT_SECONDS: 4,
  // Devices out longer than this are flagged on the admin dashboard.
  OVERDUE_HOURS: 12.5,

  // Digits in generated asset IDs (PH-001). The prefix comes from each asset type
  // (Phone → PH-, iPad → IP-) and can be changed in the Asset types dialog.
  ASSET_ID_PAD: 3,

  // Max records per write batch when importing (Firestore rule-lookup limit).
  IMPORT_CHUNK: 6,
};
