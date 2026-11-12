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
| Badge **or employee ID** → available device | **Checked out** to that person |
| Badge → the device they have | **Checked in** |
| Device alone, currently out | **Checked in** for whoever had it |
| Device alone, currently available | "Scan your ID first." |
| Badge → device still out to someone else | **Allowed** (takeover). Opens an alert, see below |
| Badge → a second device | Blocked (one per person; configurable) |
| Inactive badge / out-of-service device / unknown code | Clear red message (lost devices say "marked LOST, tell your supervisor") |

### Badge number vs employee ID
A badge's barcode is usually the employee ID plus a few extra digits. Each person has an **employee ID** and, optionally, a **badge number** (Staff tab). At the station they can scan the badge *or* scan/type the employee ID; both find the same person. Every check-out and check-in records which one was used (**Badge**, **Employee ID**, or **Device only** when a device is returned by scanning it alone). It shows in the Reports activity table and CSV ("ID Used"), and the report's staff table counts badge scans vs ID entries per person. A badge number can't equal any other employee ID, device ID or badge number.

The station resets 20 s after a badge scan; **Start over** / **Esc** resets immediately. **Manual** is there if the scanner breaks.

### Missed returns
If a device is taken while still checked out to someone else, the station allows it, the previous holder gets a "not returned" log entry, and an alert opens for admins (bell badge, banner, Alerts tab). An admin resolves it with a reason; that is recorded in the changelog.

### Optional PIN
**Settings → PIN**: Off, Everyone, or Only selected people (tick people in **Staff**, then "Require PIN"). The first time someone needs a PIN they create one (4 to 6 digits) at the station. Only a salted hash is stored. Admins can reset a PIN (the person creates a new one next scan). Three wrong tries cancels that scan.
*Honest limit:* this is a speed bump against someone scanning another person's badge, not strong security. The hash is checked in the browser.

### Report a damaged device
At the station press **Report a damaged device**: (1) scan the device, (2) type what's wrong, (3) scan your badge or enter your employee ID. The screen then says to place the device on your supervisor's desk. If the person reporting is the one holding the device, it is also checked back in. (After any check-in the station also offers a "Something wrong with…?" button that starts at step 2.) Reports show in **Alerts → Reported problems** and in the bell count. Resolve them there, optionally sending the device for repair (takes it out of service).

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
Bulk label printing with saved templates is in Assets/Staff (tick rows → **Print N labels…**). CSV import for staff (`employeeId,name`) and assets (`assetType,model,imei,serial,phoneNumber`). "Remove" never erases anything; history is kept.

## Admin portal notes
- **Asset types** (*Assets → Asset types…*) is the only place to add a new kind of item (Rover phone, iPad, Fob). Give it a name, optional **ID letters** (e.g. `S` for Supervisor phone) and tick which detail fields apply, so a **Fob** can have none. **Add asset** then starts with "What kind of item is this?"; once you pick a type it fills in the barcode ID for you: the letters plus the next number after the highest one already used, always 3 digits (`S001`, `S002`, … `S010`), starting at `001` for a new type. A type with no letters means you type each ID. You can change the suggested ID, but one that is already taken is flagged and refused. **Add & add another** saves and keeps the form open on the next ID. The detail fields you tick for a type (model, phone number, IMEI, serial) are **required** when adding or editing an item of that type and in uploads (rows missing one are skipped); leave a field unticked if it doesn't apply, as with a fob.
- **One of each kind:** a person can hold one device *per type* at a time, so a rover phone and a fob together is fine, two rover phones is not.
- **Staff** have an employee ID, an optional badge number, and a name.
- **Admins are staff too.** Every administrator is also on the staff list (they have an employee ID and optional badge number), so they can scan out a phone or fob like anyone else. The first time an existing admin signs in after this update they're asked for their employee ID; new admins (added one at a time or by spreadsheet) need an employee ID up front. A still-unlinked admin shows an **Add to staff** button on the Admins tab.
- **Admins can't edit their own records.** An admin can't change their own staff record (name, badge, PIN, removal), can't force-return, mark lost or edit a device they are holding, and can't edit or deactivate their own admin entry. Another admin has to do it. Check-out and check-in history can't be edited by anyone, admin or not; corrections are new entries. These limits are enforced by the database rules, not just the buttons. They apply once an admin is linked to a staff record.
- **Admins:** add one at a time, or import a spreadsheet.

## Spreadsheet imports
**Staff, Assets and Admins** each have an **Import spreadsheet** button, with **Download Excel template** and **Download CSV template** buttons for a blank, correctly headed file (the Excel one has an Instructions sheet; format the ID columns as Text in Excel so leading zeros are kept). Upload an Excel (`.xlsx`) or CSV file, or paste rows. The first row is headers; the first sheet is used. You get a preview of what will be added and what is skipped (and why) before anything is saved.

| Import | Columns |
|---|---|
| Staff | `employeeId`, `name` (or `firstName` + `lastName`), optional `badgeId`. If the employee already exists and the row has a `badgeId`, their badge number is filled in and nothing else changes. To add badge numbers for everyone, import `employeeId` + `badgeId`. |
| Assets | `assetType` (needed; must already exist under Assets → Asset types, otherwise the row is skipped) plus whichever of `model`, `imei`, `serial`, `phoneNumber` the type requires (ticked under Asset types). **No ID column is needed:** each device is numbered from its type's ID letters with the lowest free number (R001, R002, R003…). Add an `assetId` column only to pick a specific barcode, or for a type with no ID letters. |
| Admins | `email`, `name`, `employeeId` (needed for admins; they're added to staff too), optional `badgeId`, optional `role` (`admin` or `station`). Each person is emailed a link to set their own password. |

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
`npm test` runs the logic tests (scan rules, reports, CSV and spreadsheet imports, badge numbers, labels, PIN, shifts, inventory).

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
  js/sheet.js                    reads .xlsx/.csv uploads, builds the templates
firestore.rules, firestore.indexes.json   paste/create in the Firebase console
tests/
```
