// PIN rules + hashing (no Firebase). Unit tested.
//
// A PIN is a light deterrent against badge-borrowing, not strong authentication: the
// salted hash lives on the staff record, which the station login can read. It stops a
// coworker from casually scanning someone else's badge; it won't stop a determined attacker
// who already has a station login.

export const PIN_MODES = ["off", "selected", "all"];

export const normSettings = (raw) => ({
  pinMode: PIN_MODES.includes(raw?.pinMode) ? raw.pinMode : "off",
});

export const validPin = (p) => /^\d{4,6}$/.test(String(p ?? ""));

/** 'none' = no PIN step · 'enter' = they have a PIN · 'create' = must make one now (first use) */
export function pinNeed(settings, staff) {
  const mode = normSettings(settings).pinMode;
  const required = mode === "all" || (mode === "selected" && staff?.pinRequired === true);
  if (!required) return "none";
  return staff?.pinHash ? "enter" : "create";
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export const newSalt = () => hex(crypto.getRandomValues(new Uint8Array(16)));

export async function hashPin(pin, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(String(pin)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(String(salt)), iterations: 100000, hash: "SHA-256" }, key, 256);
  return hex(bits);
}

export async function checkPin(pin, staff) {
  if (!validPin(pin) || !staff?.pinHash || !staff?.pinSalt) return false;
  return (await hashPin(pin, staff.pinSalt)) === staff.pinHash;
}
