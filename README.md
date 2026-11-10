# Device Check-Out Tracker

Scan an employee badge, scan a device (phone, iPad, anything), done. Scan the device again to return it.
Plain HTML/JS pages hosted on **GitHub Pages**; **Firebase** (Firestore + Auth) stores the data and the logins. No build step, nothing to install on your computer.

| Page | URL | Who |
|---|---|---|
| Scan station | `https://<you>.github.io/<repo>/` | Employees, on the check-out computer |
| Admin portal | `.../admin.html` | Admins only |
| Label designer | `.../print.html` | Opened from the admin portal |

This is set up as a **test environment**. See "Before real use" at the bottom.

---

## Setup (about 30 minutes, all in a web browser)

### Part 1: Firebase (the database and logins)

1. Go to **console.firebase.google.com** → **Add project** → name it (e.g. `transport-tracker`). Google Analytics can be off.
2. **Build → Firestore Database → Create database** → pick a location → **Production mode**.
3. **Build → Authentication → Get started → Email/Password → Enable → Save.**
4. **Project settings (gear) → General → Your apps → `</>` (Web)** → nickname it → **Register app** (skip "Hosting"). Copy the `firebaseConfig` values; you'll paste them in Part 2.
5. **Firestore → Rules** tab → delete everything there → paste the full contents of `firestore.rules` from this repo → **Publish**.
6. **Firestore → Indexes → Composite → Add index** three times (Query scope: *Collection*):

   | Collection ID | Field 1 | Field 2 |
   |---|---|---|
   | `logs` | `employeeId` Ascending | `ts` Descending |
   | `logs` | `assetId` Ascending | `ts` Descending |
   | `auditLog` | `adminUid` Ascending | `ts` Descending |

   They take a minute or two to build. (Only needed for the per-person, per-device and per-admin reports.)

### Part 2: GitHub (hosts the pages)

1. Create a GitHub account if needed, then **New repository** → name it → **Public** (free Pages requires public) → Create.
2. **Add file → Upload files** → drag in the *contents* of the unzipped folder (including the `docs` folder) → Commit.
3. Open `docs/js/firebase-config.js` in GitHub → pencil icon → paste your Firebase values from step 4 above → Commit.
4. **Settings → Pages →** Source: *Deploy from a branch* → Branch `main`, folder **`/docs`** → Save. After a minute it shows your site address, `https://<you>.github.io/<repo>/`.

### Part 3: Connect the two

1. Firebase → **Authentication → Settings → Authorized domains → Add domain** → `<you>.github.io` (just the domain, no path).
2. **Create the first admin** (the only manual step; later admins are added in the portal):
   - **Authentication → Users → Add user** (your email + password). Copy the **User UID**.
   - **Firestore → Start collection** `admins` → Document ID = that UID → fields `email` (string), `name` (string), `active` (boolean, `true`).
3. Open `<site>/admin.html` and sign in.
4. **Admins → Add admin / station login → Station login** for the check-out computer. Open `<site>/` on it, sign in once; it stays signed in.
5. **Assets → Asset types…** add Phone, iPad. Then add or import devices.

Optional: Google Cloud Console → APIs & Services → Credentials → restrict the browser API key to `<you>.github.io/*`. The Firebase config is not a secret; the security rules are what protect the data.

### Updating later
Edit the file in GitHub (pencil → Commit). Pages republishes in about a minute. Rules changes are pasted into Firebase → Firestore → Rules → Publish.

### Test with one person and one device
1. Staff → add `90001` / "Test User". Assets → add a Phone.
2. Tick each → **Print labels…**.
3. At the station: scan badge → scan device (**CHECKED OUT**) → scan device again (**CHECKED IN**).
4. To see an alert: check a device out, then take it with a second test badge without returning it.

---

## How scanning works

| What's scanned | Result |
|---|---|
| Badge → available device | **Checked out** to that person |
| Badge → the device they have | **Checked in** |
| Device alone, currently out | **Checked in** for whoever had it |
| Device alone, currently available | "Scan your ID first." |
| Badge → device still out to someone else | **Allowed** (takeover). Opens an alert, see below |
| Badge → a second device | Blocked (one per person; configurable) |
| Inactive badge / out-of-service device / unknown code | Clear red message (lost devices say "marked LOST, tell your supervisor") |

The station resets 20 s after a badge scan; **Start over** / **Esc** resets immediately. **Manual** is there if the scanner breaks.

### Missed returns
If a device is taken while still checked out to someone else, the station allows it, the previous holder gets a "not returned" log entry, and an alert opens for admins (bell badge, banner, Alerts tab). An admin resolves it with a reason; that is recorded in the changelog.

### Optional PIN
**Settings → PIN**: Off, Everyone, or Only selected people (tick people in **Staff**, then "Require PIN"). The first time someone needs a PIN they create one (4 to 6 digits) at the station. Only a salted hash is stored. Admins can reset a PIN (the person creates a new one next scan). Three wrong tries cancels that scan.
*Honest limit:* this is a speed bump against someone scanning another person's badge, not strong security. The hash is checked in the browser.

### Report a problem
After a check-in, the station offers "Report a problem" (cracked screen, won't charge, etc.). Reports show in **Alerts → Reported problems** and in the bell count. Resolve them there, optionally sending the device for repair (takes it out of service).

### Lost / retired devices
**Assets → Take out of service…** with a reason: Lost, Stolen, Out for repair, Retired, Removed. The station then blocks it with a reason-specific message. **Restore** puts it back in service.

### Inventory count
**Inventory** tab → choose scope (all or one type) → scan every device on the shelf → Finish. You get Found / Missing / Out with staff / Out of service / Unknown. Missing devices can be marked lost or checked in right there. Counts are saved to history.

### End-of-shift sweep
**Shift sweep** tab lists devices still out since before the last shift change, to print or follow up on. Shift change times are in **Settings** (default 07:00, 15:00, 23:00; **these are a guess, please change them**).

### Kiosk mode
Station → **Kiosk** button: fullscreen, screen kept awake, remembered on that computer. Exit: click the clock 5 times or Ctrl+Shift+K. `?kiosk=1` / `?kiosk=0` in the address forces it on/off.

---

## Admin portal
Dashboard · Alerts · Assets · Staff · Inventory · Shift sweep · Reports · Admins · Changelog · Settings.
Bulk label printing with saved templates is in Assets/Staff (tick rows → **Print N labels…**). CSV import for staff (`employeeId,name`) and assets (`assetId,assetType,model,imei,serial,phoneNumber`). "Remove" never erases anything; history is kept.

## Equipment
USB barcode scanner in keyboard mode that sends Enter; thermal label printer (Code 128; 2.25×1.25 in is common) or plain paper; badges must carry a barcode (magstripe/RFID need a different reader); any computer with Chrome/Edge.

## Settings in `docs/js/firebase-config.js`
`ALLOW_MULTIPLE_PER_EMPLOYEE`, `EMPLOYEE_PENDING_SECONDS`, `RESULT_SECONDS`, `OVERDUE_HOURS`, `ASSET_ID_PAD`, `IMPORT_CHUNK`, `PIN_SECONDS`, `PIN_MAX_TRIES`, `ORG_NAME`, `APP_NAME`. PIN mode and shift times are changed in the portal, not here.

## How it's locked down
- A login only works with an **active** record in `admins` (full) or `stations` (scan only).
- Stations can only change device state together with a matching log entry, open alerts and problem reports, and set a first-time PIN. They can't read alerts, reports, counts, or the changelog.
- Every admin write must carry the id of a changelog entry created in the same batch. Logs and the changelog can't be edited or deleted; nothing is hard-deleted.
- The GitHub repo is public, so don't put real staff data in it. Data lives only in Firebase.

## Before real use
- Check with IT/security before storing staff names and IDs in an outside cloud service.
- Run the rules tests once (needs Java): `npm i --no-save firebase-tools @firebase/rules-unit-testing firebase` then `npx firebase emulators:exec --only firestore --project demo-phone "node --test tests/rules.test.mjs"`. They were written but **not yet run** against the emulator.
- Do a real-browser pass on your own scanner and printer.

## Tests
`npm test` runs the logic tests (scan rules, reports, CSV, labels, PIN, shifts, inventory).

## Troubleshooting
- *"Firebase isn't configured yet"*: paste your config into `docs/js/firebase-config.js`.
- *Sign-in says unauthorized domain*: add `<you>.github.io` in Authentication → Authorized domains.
- *"That login isn't authorised"*: no active `admins`/`stations` record for that login.
- *A report says it needs an index*: add the three indexes in Part 1, step 6, wait a minute.
- *Scans type but nothing happens*: scanner isn't sending Enter.
- *Page changes don't show*: wait a minute after committing, then hard-refresh.

## Files
```
docs/                 the website (GitHub Pages serves this folder)
  index.html, js/station.js      scan station
  admin.html, js/admin.js        admin portal
  print.html, js/print.js        label designer
  js/*-logic.js                  tested rules (scan, pin, shift, inventory, report, import, label)
firestore.rules, firestore.indexes.json   paste/create in the Firebase console
tests/
```
