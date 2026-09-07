// One-time migration: reads exported JSON docs under ../data/<collection>/<docId>.json
// and writes them into Firestore with the same collection/doc IDs. Safe to re-run
// (uses .set(), so it just overwrites with the same data).
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const fs = require("fs");
const path = require("path");

const serviceAccount = require("./serviceAccountKey.json");
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const DATA_DIR = path.join(__dirname, "..", "data");

async function migrateCollection(collectionName) {
  const dir = path.join(DATA_DIR, collectionName);
  if (!fs.existsSync(dir)) {
    console.log(`(skip) no ${collectionName}/ folder found`);
    return 0;
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  let batch = db.batch();
  let count = 0;
  for (const file of files) {
    const docId = file.replace(/\.json$/, "");
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    batch.set(db.collection(collectionName).doc(docId), data);
    count++;
    if (count % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  await batch.commit();
  console.log(`Migrated ${count} docs into "${collectionName}"`);
  return count;
}

async function migrateSettingsColors() {
  const file = path.join(DATA_DIR, "settings", "colors.json");
  if (!fs.existsSync(file)) {
    console.log("(skip) no settings/colors.json found");
    return;
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  await db.collection("settings").doc("colors").set(data);
  console.log("Migrated settings/colors");
}

(async () => {
  await migrateCollection("classes");
  await migrateCollection("series");
  await migrateSettingsColors();
  console.log("Done.");
  process.exit(0);
})().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
