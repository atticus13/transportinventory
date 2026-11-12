// Scan barcodes with the phone/tablet camera. Works on any page served over HTTPS (GitHub Pages is).
// Uses the browser's built-in BarcodeDetector when it has one (Chrome/Android); otherwise loads ZXing from a CDN (iPhone/iPad Safari, Firefox).
import { norm } from "./util.js";

const ZXING = ["https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js", "https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js"];
const FORMATS = ["code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e", "itf", "codabar", "qr_code"];
const SAME_CODE_GAP_MS = 2500;
export const CAMERA_VERSION = "8";

/**
 * Pure. The camera sees the same barcode on every frame, so a code only counts again after it has been out of view for `gap` ms.
 * Returns { accept, last } where `last` is the new tracking state (refreshed every time the same code is still in view).
 */
export function trackScan(code, last, now = Date.now(), gap = SAME_CODE_GAP_MS) {
  const c = norm(code);
  if (!c) return { accept: false, last };
  if (last && last.code === c && now - last.at < gap) return { accept: false, last: { code: c, at: now } };
  return { accept: true, last: { code: c, at: now } };
}

export const cameraSupported = () => !!(typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia && globalThis.isSecureContext !== false);

let zxingLoading = null;
function loadZXing() {
  if (globalThis.ZXing) return Promise.resolve(globalThis.ZXing);
  if (zxingLoading) return zxingLoading;
  const tryUrl = (i) => new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = ZXING[i]; s.onload = () => (globalThis.ZXing ? resolve(globalThis.ZXing) : reject(new Error("ZXing missing")));
    s.onerror = () => reject(new Error("load failed"));
    document.head.appendChild(s);
  }).catch((e) => (i + 1 < ZXING.length ? tryUrl(i + 1) : Promise.reject(e)));
  zxingLoading = tryUrl(0).catch((e) => { zxingLoading = null; throw e; });
  return zxingLoading;
}

/** Returns async decode(canvas) -> string|null */
async function makeDecoder() {
  if (globalThis.BarcodeDetector) {
    try {
      const supported = (await globalThis.BarcodeDetector.getSupportedFormats?.()) || FORMATS;
      const det = new globalThis.BarcodeDetector({ formats: FORMATS.filter((f) => supported.includes(f)) });
      return async (canvas) => (await det.detect(canvas))[0]?.rawValue || null;
    } catch { /* fall through to ZXing */ }
  }
  const Z = await loadZXing();
  const hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.ITF, Z.BarcodeFormat.QR_CODE]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  return async (canvas) => {
    try { return reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)))).getText(); }
    catch { return null; }
  };
}

const CSS = `
.camscan{position:fixed;inset:0;z-index:9999;background:#05080f;display:flex;flex-direction:column;color:#eaf0fa;font-family:inherit}
.camscan header{display:flex;align-items:center;gap:10px;padding:12px 14px}
.camscan header b{flex:1;font-size:17px}
.camscan .cs-view{position:relative;flex:0 0 36vh;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden}
.camscan video{width:100%;height:100%;object-fit:cover}
.camscan .cs-box{position:absolute;left:8%;right:8%;top:50%;height:56%;transform:translateY(-50%);border:3px solid #ff8a1f;border-radius:14px;box-shadow:0 0 0 100vmax rgba(0,0,0,.35);pointer-events:none}
.camscan .cs-box.hit{border-color:#3ddc84}
.camscan footer{flex:1;padding:12px 14px 18px;display:flex;flex-direction:column;gap:10px;text-align:center}
.camscan .cs-manual{margin-top:auto}
.camscan .cs-ver{font-size:11px;color:#5c6b85;font-weight:400}
.camscan .cs-status{font-size:15px;font-weight:600;min-height:20px;color:#9fb0c8}
.camscan .cs-bubble{position:relative;overflow:hidden;border-radius:22px;background:linear-gradient(160deg,#ff8a1f,#f26a00);color:#1b0f02;min-height:104px;display:grid}
.camscan .cs-step{grid-area:1/1;display:grid;place-content:center;gap:4px;padding:16px 18px;text-align:center}
.camscan .cs-step b{font-size:24px;line-height:1.15;font-weight:800}
.camscan .cs-step i{font-style:normal;font-size:17px;font-weight:600}
.camscan .cs-step span{font-size:14px;opacity:.85}
.camscan button{min-height:48px;padding:10px 20px;border-radius:12px;border:1px solid #33425e;background:#14203a;color:#eaf0fa;font-size:16px;font-weight:600}
`;

/**
 * Opens a full-screen camera scanner.
 *  onCode(code)  called for every new barcode; return false to close, true/undefined to keep scanning (if keepOpen).
 *  onManual      optional; shows a "Type it instead" button that closes the camera and calls this
 *  mirror        optional () => ({title, sub}) shown under the picture (the station shows what to do next)
 * Returns {close()}.
 */
export async function openCameraScanner({ title = "Scan a barcode", onCode, keepOpen = true, mirror = null, onClose = null, onManual = null }) {
  if (!cameraSupported()) throw new Error("This browser can't use the camera here. (It needs HTTPS and permission to use the camera.)");
  if (!document.getElementById("camscan-css")) {
    const st = document.createElement("style"); st.id = "camscan-css"; st.textContent = CSS; document.head.appendChild(st);
  }
  const el = document.createElement("div");
  el.className = "camscan"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", title);
  el.innerHTML = `<header><b></b><span class="cs-ver">v${CAMERA_VERSION}</span><button type="button" data-x>Done</button></header>
    <div class="cs-view"><video playsinline muted></video><div class="cs-box"></div></div>
    <footer><div class="cs-status">Starting the camera…</div><div class="cs-bubble"></div>${onManual ? '<button type="button" class="cs-manual" data-m>⌨ Type it instead</button>' : ""}</footer>`;
  el.querySelector("b").textContent = title;
  document.body.appendChild(el);
  const video = el.querySelector("video"), box = el.querySelector(".cs-box"), status = el.querySelector(".cs-status"), bubble = el.querySelector(".cs-bubble");
  let stream = null, stopped = false, last = null, timer = null;

  // The orange step bubble: when the step changes, the old one slides off to the left and the new one slides in from the right.
  let stepKey = null, stepEl = null;
  const showStep = ({ title = "", name = "", sub = "" }) => {
    const key = title + "|" + name;
    const html = `<b></b>${name ? "<i></i>" : ""}${sub ? "<span></span>" : ""}`;
    const fill = (e) => { e.querySelector("b").textContent = title; if (name) e.querySelector("i").textContent = name; if (sub) e.querySelector("span").textContent = sub; };
    if (stepEl && key === stepKey) { if (sub) { const sp = stepEl.querySelector("span"); if (sp) sp.textContent = sub; } return; }
    const next = document.createElement("div");
    next.className = "cs-step"; next.innerHTML = html; fill(next);
    bubble.appendChild(next);
    const old = stepEl;
    if (old && next.animate) {
      const opts = { duration: 320, easing: "ease-in-out", fill: "forwards" };
      old.animate([{ transform: "translateX(0)", opacity: 1 }, { transform: "translateX(-110%)", opacity: 0 }], opts).onfinish = () => old.remove();
      next.animate([{ transform: "translateX(110%)", opacity: 0 }, { transform: "translateX(0)", opacity: 1 }], opts);
    } else old?.remove();
    stepEl = next; stepKey = key;
  };
  showStep({ title: "Starting the camera…" });

  const close = () => {
    if (stopped) return;
    stopped = true; clearTimeout(timer);
    stream?.getTracks().forEach((t) => t.stop());
    el.remove(); onClose?.();
  };
  el.querySelector("[data-x]").addEventListener("click", close);
  el.querySelector("[data-m]")?.addEventListener("click", () => { close(); onManual?.(); });

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    if (stopped) { stream.getTracks().forEach((t) => t.stop()); return { close }; }
    video.srcObject = stream; await video.play();
    status.textContent = "Hold the barcode inside the box";
    showStep(mirror?.() || { title: "Point at a barcode" });
    const decode = await makeDecoder();
    const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });
    const tick = async () => {
      if (stopped) return;
      try {
        if (video.videoWidth) {
          canvas.width = video.videoWidth; canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
          const raw = await decode(canvas);
          const code = norm(raw);
          const t = trackScan(code, last);
          if (code) last = t.last;
          if (t.accept) {
            box.classList.add("hit"); setTimeout(() => box.classList.remove("hit"), 600);
            navigator.vibrate?.(60);
            status.textContent = `✓ Scanned ${code}`;
            const keep = (await onCode(code)) !== false;
            if (!keepOpen || !keep) return close();
          }
        }
        if (mirror) { const m = mirror(); if (m?.title) showStep(m); }
      } catch (e) { console.error("camera scan", e); }
      timer = setTimeout(tick, 120);
    };
    tick();
  } catch (e) {
    const denied = e?.name === "NotAllowedError" || e?.name === "SecurityError";
    status.textContent = "";
    showStep({ title: denied ? "Camera permission was blocked" : "Couldn't start the camera", sub: denied ? "Allow camera access for this site in the browser settings, then try again." : (e?.message || "") });
  }
  return { close };
}
