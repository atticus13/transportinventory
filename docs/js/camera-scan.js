// Scan barcodes with the phone/tablet camera. Works on any page served over HTTPS (GitHub Pages is).
// Uses the browser's built-in BarcodeDetector when it has one (Chrome/Android); otherwise loads ZXing from a CDN (iPhone/iPad Safari, Firefox).
import { norm } from "./util.js";

const ZXING = ["https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js", "https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js"];
const FORMATS = ["code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e", "itf", "codabar", "qr_code"];
const SAME_CODE_GAP_MS = 2500;

/** Pure: ignore the same code seen again within a couple of seconds (the camera sees it on every frame). */
export function acceptScan(code, last, now = Date.now(), gap = SAME_CODE_GAP_MS) {
  const c = norm(code);
  if (!c) return false;
  return !(last && last.code === c && now - last.at < gap);
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
.camscan .cs-view{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden}
.camscan video{width:100%;height:100%;object-fit:cover}
.camscan .cs-box{position:absolute;left:8%;right:8%;top:50%;height:34%;transform:translateY(-50%);border:3px solid #ff8a1f;border-radius:14px;box-shadow:0 0 0 100vmax rgba(0,0,0,.35);pointer-events:none}
.camscan .cs-box.hit{border-color:#3ddc84}
.camscan footer{padding:12px 14px 18px;display:grid;gap:8px;text-align:center}
.camscan .cs-status{font-size:18px;font-weight:700;min-height:24px}
.camscan .cs-sub{color:#9fb0c8;font-size:15px;min-height:20px}
.camscan button{min-height:48px;padding:10px 20px;border-radius:12px;border:1px solid #33425e;background:#14203a;color:#eaf0fa;font-size:16px;font-weight:600}
`;

/**
 * Opens a full-screen camera scanner.
 *  onCode(code)  called for every new barcode; return false to close, true/undefined to keep scanning (if keepOpen).
 *  mirror        optional () => ({title, sub}) shown under the picture (the station shows what to do next)
 * Returns {close()}.
 */
export async function openCameraScanner({ title = "Scan a barcode", onCode, keepOpen = true, mirror = null, onClose = null }) {
  if (!cameraSupported()) throw new Error("This browser can't use the camera here. (It needs HTTPS and permission to use the camera.)");
  if (!document.getElementById("camscan-css")) {
    const st = document.createElement("style"); st.id = "camscan-css"; st.textContent = CSS; document.head.appendChild(st);
  }
  const el = document.createElement("div");
  el.className = "camscan"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", title);
  el.innerHTML = `<header><b></b><button type="button" data-x>Done</button></header>
    <div class="cs-view"><video playsinline muted></video><div class="cs-box"></div></div>
    <footer><div class="cs-status">Starting the camera…</div><div class="cs-sub">Hold the barcode inside the box.</div></footer>`;
  el.querySelector("b").textContent = title;
  document.body.appendChild(el);
  const video = el.querySelector("video"), box = el.querySelector(".cs-box"), status = el.querySelector(".cs-status"), sub = el.querySelector(".cs-sub");
  let stream = null, stopped = false, last = null, timer = null;

  const close = () => {
    if (stopped) return;
    stopped = true; clearTimeout(timer);
    stream?.getTracks().forEach((t) => t.stop());
    el.remove(); onClose?.();
  };
  el.querySelector("[data-x]").addEventListener("click", close);

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    if (stopped) { stream.getTracks().forEach((t) => t.stop()); return { close }; }
    video.srcObject = stream; await video.play();
    status.textContent = "Ready. Point at a barcode.";
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
          if (code && acceptScan(code, last)) {
            last = { code, at: Date.now() };
            box.classList.add("hit"); setTimeout(() => box.classList.remove("hit"), 600);
            navigator.vibrate?.(60);
            status.textContent = `Scanned ${code}`;
            const keep = (await onCode(code)) !== false;
            if (!keepOpen || !keep) return close();
          }
        }
        if (mirror) { const m = mirror(); if (m?.title) status.textContent = m.title; if (m) sub.textContent = m.sub || ""; }
      } catch (e) { console.error("camera scan", e); }
      timer = setTimeout(tick, 120);
    };
    tick();
  } catch (e) {
    const denied = e?.name === "NotAllowedError" || e?.name === "SecurityError";
    status.textContent = denied ? "Camera permission was blocked." : "Couldn't start the camera.";
    sub.textContent = denied ? "Allow camera access for this site in the browser settings, then try again." : (e?.message || "");
  }
  return { close };
}
