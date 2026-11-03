// Keeps the shared Google Calendar in step with the ledger.
// - A class is written (added, edited, deleted, synced): its event is updated within seconds.
// - A BestMinds marking batch is written: its due-date event is updated the same way.
// - A trip or custom centre changes: the whole calendar is rechecked, since that can affect many classes.
// - Once a night everything is rechecked anyway, to catch anything that slipped through.
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { createClient, calendarApi, syncClass, syncBatch, reconcile } = require("./calendar");

initializeApp();
const db = getFirestore();
// The Google Calendar the classes go into (Settings → the calendar → Integrate calendar → Calendar ID).
// Set in functions/.env, which isn't committed.
const CALENDAR_ID = defineString("CALENDAR_ID");

setGlobalOptions({
  region: "asia-southeast1", // same as Firestore
  // The calendar is shared with this account, so the functions run as it.
  serviceAccount: "firebase-adminsdk-fbsvc@shraddha-income-tracker.iam.gserviceaccount.com",
  maxInstances: 2
});

let cal = null;
function calendar() {
  cal = cal || calendarApi(createClient(), CALENDAR_ID.value());
  return cal;
}

exports.calendarSyncClass = onDocumentWritten("classes/{classId}", async (event) => {
  const after = event.data.after.exists ? event.data.after.data() : null;
  const before = event.data.before.exists ? event.data.before.data() : null;
  await syncClass(db, calendar(), event.params.classId, after, before);
});

exports.calendarSyncMarking = onDocumentWritten("marking/{batchId}", async (event) => {
  const after = event.data.after.exists ? event.data.after.data() : null;
  await syncBatch(calendar(), event.params.batchId, after);
});

async function recheckAll() {
  await reconcile(db, calendar(), (stats) => logger.info("calendar reconcile", stats));
}

exports.calendarSyncLeaves = onDocumentWritten({ document: "leaves/{leaveId}", timeoutSeconds: 540 }, recheckAll);
exports.calendarSyncOrgs = onDocumentWritten({ document: "orgs/{orgId}", timeoutSeconds: 540 }, recheckAll);
exports.calendarNightly = onSchedule({ schedule: "every day 04:00", timeZone: "Asia/Singapore", timeoutSeconds: 540 }, recheckAll);
