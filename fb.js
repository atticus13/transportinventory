import * as appMod from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import * as A from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import * as F from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const configured = !String(firebaseConfig.apiKey).startsWith("YOUR_");
export const app = appMod.initializeApp(firebaseConfig);
export const auth = A.getAuth(app);
export const db = F.getFirestore(app);
export { A, F, appMod, firebaseConfig };

export function friendlyAuthError(e) {
  const c = e?.code || "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found") || c.includes("invalid-email"))
    return "Email or password is incorrect.";
  if (c.includes("too-many-requests")) return "Too many attempts. Wait a minute and try again.";
  if (c.includes("network")) return "Can't reach the server. Check the internet connection.";
  if (c.includes("email-already-in-use")) return "That email already has a login. Use “Send password reset” or pick a different email.";
  if (c.includes("weak-password")) return "Password must be at least 8 characters.";
  return e?.message || "Something went wrong.";
}
