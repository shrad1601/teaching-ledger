// Deploys firestore.rules directly via the Firebase Rules API, bypassing the
// Firebase CLI's Service Usage pre-check (which this service account's role
// doesn't have permission for, even though Firestore itself is already enabled).
const { GoogleAuth } = require("google-auth-library");
const fs = require("fs");
const path = require("path");

const PROJECT_ID = "shraddha-income-tracker";

(async () => {
  const auth = new GoogleAuth({
    keyFile: path.join(__dirname, "serviceAccountKey.json"),
    scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/firebase"],
  });
  const client = await auth.getClient();
  const rulesContent = fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8");

  // 1. Create a new ruleset
  const createRes = await client.request({
    url: `https://firebaserules.googleapis.com/v1/projects/${PROJECT_ID}/rulesets`,
    method: "POST",
    data: {
      source: {
        files: [{ name: "firestore.rules", content: rulesContent }],
      },
    },
  });
  const rulesetName = createRes.data.name; // projects/{p}/rulesets/{id}
  console.log("Created ruleset:", rulesetName);

  // 2. Point the firestore release at it (create or update)
  const releaseName = `projects/${PROJECT_ID}/releases/cloud.firestore`;
  try {
    await client.request({
      url: `https://firebaserules.googleapis.com/v1/projects/${PROJECT_ID}/releases/cloud.firestore?updateMask=rulesetName`,
      method: "PATCH",
      data: { release: { name: releaseName, rulesetName } },
    });
    console.log("Updated existing release to new ruleset.");
  } catch (e) {
    if (e.response && e.response.status === 404) {
      await client.request({
        url: `https://firebaserules.googleapis.com/v1/projects/${PROJECT_ID}/releases`,
        method: "POST",
        data: { name: releaseName, rulesetName },
      });
      console.log("Created new release pointing to ruleset.");
    } else {
      throw e;
    }
  }
  console.log("Firestore rules deployed.");
})().catch((err) => {
  console.error("Failed:", err.response ? JSON.stringify(err.response.data) : err.message);
  process.exit(1);
});
