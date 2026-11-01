// Run from this folder to fill or fix the calendar from your Mac, without deploying:
//   CALENDAR_ID=... node resync-local.js          (or put CALENDAR_ID in .env)
//   node resync-local.js --dry-run                 shows what would change
// Uses scripts/serviceAccountKey.json, the same account the deployed functions run as.
const path = require("path");
const fs = require("fs");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { createClient, calendarApi, reconcile } = require("./calendar");

const keyFile = path.join(__dirname, "..", "scripts", "serviceAccountKey.json");
const envFile = path.join(__dirname, ".env");
let calendarId = process.env.CALENDAR_ID;
if (!calendarId && fs.existsSync(envFile)) {
  const m = fs.readFileSync(envFile, "utf8").match(/^CALENDAR_ID=(.+)$/m);
  if (m) calendarId = m[1].trim();
}
if (!calendarId) { console.error("Set CALENDAR_ID (env or functions/.env)."); process.exit(1); }

initializeApp({ credential: cert(require(keyFile)) });
const db = getFirestore();
let cal = calendarApi(createClient(keyFile), calendarId);
if (process.argv.includes("--dry-run")) {
  const writes = [];
  cal = Object.assign({}, cal, {
    upsert: async (id, e) => writes.push("upsert " + (e.start.dateTime || e.start.date) + " " + e.summary),
    remove: async (id) => writes.push("remove " + id)
  });
  reconcile(db, cal, console.log).then(() => { writes.slice(0, 15).forEach((w) => console.log(" ", w)); process.exit(0); });
} else {
  reconcile(db, cal, console.log).then(() => process.exit(0)).catch((e) => {
    console.error(e.response ? JSON.stringify(e.response.data) : e);
    process.exit(1);
  });
}
