# Teaching Ledger

Personal income tracker across Mind Stretcher, Ottodot, Mastermaths, Bluetree,
PrimePlus and any centres added in Settings. Firebase Hosting + Firestore, with
the owner signing in by email + password. Installable to the phone home screen as an app.

Live at: https://shraddha-income-tracker.web.app

## Features

- **Dashboard**
  - Up-next class and the classes coming up.
  - Earned vs still-to-come totals for today, this week, a month or a year.
  - Breakdown by centre:
    - tap a centre to see its month-by-month trend
    - "$/hour" shows the hourly rate each centre works out to
  - Monthly income chart with an optional goal line. Tap it for the year view and its stats.
  - Payments: mark each centre's month as paid, with a reminder for finished months still unpaid.
  - Clash warnings: a banner when upcoming classes overlap. Each clash can be dismissed.
  - Relief reminder for overseas trips where classes still need cover.
- **Add**: one-off or weekly classes. Pay is worked out from each centre's rates. You're warned before saving a class that overlaps another.
- **History**
  - list, week and calendar views, filterable by centre
  - sync log for the Tampermonkey scripts
- **Trash**: deleted classes can be restored.
- **Settings**
  - Monthly goal.
  - Export classes and income as CSV or a PDF statement, for this or last month, this or last year, or all time.
  - Overseas trips:
    - Working: classes count as usual.
    - Not working: classes are dropped from income. Relief is tracked per class.
  - Centre colours and custom centres.

## Structure

- `public/index.html`: the whole app. Single file, no build step.
  - It loads `jsPDF` from cdnjs only when exporting a PDF.
- `public/manifest.json`, `public/sw.js` and the icons make it installable.
  - The service worker caches nothing, so new deploys show up straight away.
- `firestore.rules`: only the owner's Firebase account (matched by UID) can read or write.
- `mindstretcher-sync.user.js`: Tampermonkey script that runs on Dash (`dash.mindstretcher.com`). It reads the schedule and attendance, then writes classes straight into Firestore.
- `ottodot-sync.user.js`: Tampermonkey script that does the same from Ottodot's Airtable schedule.
- Sign-in for the sync scripts:
  - The first sync asks for the ledger's email + password.
  - After that, only Firebase's refresh token is kept, in Tampermonkey storage.

## Sign-in

- Firebase Auth uses Email/Password with a single account. Create it in Firebase Console → Authentication → Users.
- Put that account's UID in `firestore.rules`.
- The app stays signed in on each device until you sign out in Settings → Account.
- `scripts/`: one-off/admin Node scripts (data migration, rules deploy, API key fixes). They're not part of the running app.

### Firestore collections

| Collection / doc   | What it holds                                                    |
| ------------------ | ---------------------------------------------------------------- |
| `classes`          | One doc per class: org, date, time, hours, rate, income. Soft-deleted with `deletedAt`. |
| `series`           | Weekly repeating classes, expanded into `classes` up to a year ahead. |
| `orgs`             | Custom centres (name, hourly rate, colour).                       |
| `payments`         | `{org}_{YYYY-MM}`: whether that centre's month has been paid.     |
| `leaves`           | Overseas trips: dates, working or not, per-class relief ticks.    |
| `syncRuns`         | Log of each Tampermonkey sync.                                    |
| `settings/colors`  | Centre colours.                                                   |
| `settings/goals`   | Monthly income goal.                                              |
| `settings/clashes` | Overlapping classes marked as fine.                               |

## API key

The committed `public/index.html` has `apiKey: "YOUR_FIREBASE_API_KEY"` as a placeholder.

To run or deploy:
1. Put the real web API key in your local copy. It's under Firebase Console → Project Settings → General.
2. Swap the placeholder back in before committing.

## Local setup for scripts

`scripts/serviceAccountKey.json` (Firebase Admin SDK service account key,
**never committed**, gitignored) is required to run anything in `scripts/`.
Generate one from Firebase Console → Project Settings → Service Accounts.

```bash
npm install
export GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/scripts/serviceAccountKey.json"
```

## Run locally

```bash
python3 -m http.server 5173 --directory public
```

## Deploy

```bash
npx firebase-tools deploy --only hosting --project shraddha-income-tracker
```
