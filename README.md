# Teaching Ledger

Personal income tracker across Mind Stretcher, Ottodot, Mastermaths, Bluetree,
and PrimePlus. Firebase Hosting + Firestore, gated by a shared passcode.

Live at: https://shraddha-income-tracker.web.app

## Structure

- `public/index.html` — the whole app (dashboard, add class, history/calendar,
  trash, org color customization). Single file, no build step.
- `firestore.rules` — access rule (`request.auth != null`, i.e. anyone who's
  passed the app's passcode gate and signed in anonymously).
- `mindstretcher-sync.user.js` — Tampermonkey script that runs on Dash
  (`dash.mindstretcher.com`), reads the schedule + attendance, and writes
  classes straight into Firestore. Install via Tampermonkey.
- `scripts/` — one-off/admin Node scripts (data migration, rules deploy,
  API key fixes). Not part of the running app.

## Local setup for scripts

`scripts/serviceAccountKey.json` (Firebase Admin SDK service account key,
**never committed**, gitignored) is required to run anything in `scripts/`.
Generate one from Firebase Console → Project Settings → Service Accounts.

```bash
npm install
export GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/scripts/serviceAccountKey.json"
```

## Deploy

```bash
npx firebase-tools deploy --only hosting --project shraddha-income-tracker
```
