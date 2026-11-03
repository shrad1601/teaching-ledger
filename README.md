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
  - BestMinds marking: open batches with their due dates and progress (tap +1 per script marked), and what's been marked this month.
- **Add**: one-off or weekly classes. Pay is worked out from each centre's rates. You're warned before saving a class that overlaps another.
  - Where: online or physical, with an optional place. Ottodot and PrimePlus are always online; custom centres can have a default.
  - BestMinds marking: a batch of scripts with a due date and pay per script. A batch counts as earned on the day its last script is marked, and as projected on its due date until then.
- **History**
  - list, week and calendar views, filterable by centre
  - add a class on a day: tap a date in the calendar, then tap it again (or "+ Add class"), or tap + on a day in the week view. The form opens with that date, and saving goes back to History.
  - tap a class to edit it, or copy it to other dates (pick days on a calendar or "every week for 4 weeks"; pay is worked out for each date)
  - sync log for the Tampermonkey scripts
- **Trash**: deleted classes can be restored.
- **Settings**
  - Monthly goal.
  - Export classes and income as CSV or a PDF statement, for this or last month, this or last year, or all time.
  - PrimePlus timesheet: fills PrimePlus's invoice spreadsheet for a chosen month (lessons per class type, hourly rate with the pay per lesson, total).
  - Overseas trips:
    - Working: classes count as usual.
    - Not working: classes are dropped from income. Relief is tracked per class.
  - BestMinds marker stage (Trainee, Beginner, Competent, Expert) and the pay per script for each. New batches use the current stage's rate; existing batches keep theirs.
  - Centre colours and custom centres (name, hourly rate, colour, a short name for Google Calendar, and whether its classes are usually online, physical or vary).
- **Google Calendar**: every class is mirrored into a shared Google Calendar within seconds (see `functions/`).
  - Titles are short: `MS P5 Science Katong`, `Otto P4 Sci`. The place only shows when it isn't the centre's usual.
  - Regular classes are Peacock (blue), relief classes Lavender (purple). Mind Stretcher uses Dash's RELIEF tag and Ottodot its relief-teacher column; otherwise a class counts as regular if it repeats weekly.
  - Classes on not-working trips are left off. Events added by hand in the calendar are never touched.
  - Marking batches are all-day Tangerine events on the due date (`BM marking 25 scripts P6 Science WA2`), ticked ✓ once finished.

## Structure

- `public/index.html`: the whole app. Single file, no build step.
  - It loads `jsPDF` from cdnjs only when exporting a PDF, and `JSZip` only for the PrimePlus timesheet.
- `public/primeplus-timesheet.xlsx`: PrimePlus's blank invoice template that the timesheet fills in.
- `public/manifest.json`, `public/sw.js` and the icons make it installable.
  - The service worker caches nothing, so new deploys show up straight away.
- `firestore.rules`: only the owner's Firebase account (matched by UID) can read or write.
- `mindstretcher-sync.user.js`: Tampermonkey script that runs on Dash (`dash.mindstretcher.com`). It reads the schedule (including each class's venue and RELIEF tag) and attendance, then writes classes straight into Firestore.
- `ottodot-sync.user.js`: Tampermonkey script that does the same from Ottodot's Airtable schedule. Classes where you're the relief teacher are saved with `relief: true`.
- `functions/`: Cloud Functions (2nd gen, `asia-southeast1`) that keep the Google Calendar in step with `classes`.
  - `calendarSyncClass`: on any class write, updates that class's event (and the same slot a week either side, for the blue/purple colour).
  - `calendarSyncLeaves` / `calendarSyncOrgs`: recheck the whole calendar when a trip or custom centre changes.
  - `calendarNightly`: full recheck at 4am Singapore time.
  - Runs as the `firebase-adminsdk-fbsvc` service account, which the calendar is shared with ("Make changes to events") and which has Eventarc Event Receiver + Cloud Run Invoker on the project.
  - `CALENDAR_ID` goes in `functions/.env` (not committed).
  - `resync-local.js` rechecks the calendar from your Mac (`--dry-run` to preview). `import-timetree.js` was a one-off import of a TimeTree export with label colours and reminders.
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
| `classes`          | One doc per class: org, date, time, hours, rate, income, `mode` (online/physical), `place`, `relief` (MS, Ottodot). Soft-deleted with `deletedAt`. |
| `series`           | Weekly repeating classes, expanded into `classes` up to a year ahead. |
| `orgs`             | Custom centres (name, hourly rate, colour, optional `short` name for the calendar and default `mode`). |
| `marking`          | BestMinds batches: label, scripts, marked, due, rate, stage, `doneDate`. Soft-deleted with `deletedAt`. |
| `payments`         | `{org}_{YYYY-MM}`: whether that centre's month has been paid.     |
| `leaves`           | Overseas trips: dates, working or not, per-class relief ticks.    |
| `syncRuns`         | Log of each Tampermonkey sync.                                    |
| `settings/colors`  | Centre colours.                                                   |
| `settings/goals`   | Monthly income goal.                                              |
| `settings/clashes` | Overlapping classes marked as fine.                               |
| `settings/marking` | BestMinds marker stage and pay per script for each stage.         |

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
npx firebase-tools deploy --only functions --project shraddha-income-tracker
```
