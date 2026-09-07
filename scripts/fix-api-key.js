const { GoogleAuth } = require("google-auth-library");
const path = require("path");

const PROJECT_NUMBER = "1086782070038";
const KNOWN_KEY_STRING = "YOUR_FIREBASE_API_KEY";

(async () => {
  const auth = new GoogleAuth({
    keyFile: path.join(__dirname, "serviceAccountKey.json"),
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const base = `https://apikeys.googleapis.com/v2/projects/${PROJECT_NUMBER}/locations/global/keys`;

  const listRes = await client.request({ url: base });
  const keys = listRes.data.keys || [];
  console.log(`Found ${keys.length} key(s).`);

  let target = null;
  for (const k of keys) {
    try {
      const ksRes = await client.request({ url: `https://apikeys.googleapis.com/v2/${k.name}/keyString` });
      if (ksRes.data.keyString === KNOWN_KEY_STRING) {
        target = k;
        break;
      }
    } catch (e) {
      console.log("  (couldn't read keyString for", k.name, ")");
    }
  }

  if (!target) {
    console.error("Could not find the key matching the known key string.");
    process.exit(1);
  }

  console.log("Target key:", target.name, target.displayName);
  console.log("Current restrictions:", JSON.stringify(target.restrictions, null, 2));

  // Clear all restrictions (this key is used from arbitrary origins: the Tampermonkey
  // script on dash.mindstretcher.com, plus our own hosted site). Security is enforced
  // by Firestore rules (auth != null) and the app's own passcode gate, not by referrer.
  const patchRes = await client.request({
    url: `https://apikeys.googleapis.com/v2/${target.name}?updateMask=restrictions`,
    method: "PATCH",
    data: { restrictions: {} },
  });
  console.log("Patch submitted. Operation:", patchRes.data.name || JSON.stringify(patchRes.data));
})().catch((err) => {
  console.error("Failed:", err.response ? JSON.stringify(err.response.data, null, 2) : err.message);
  process.exit(1);
});
