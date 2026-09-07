const { GoogleAuth } = require("google-auth-library");
const path = require("path");

(async () => {
  const auth = new GoogleAuth({
    keyFile: path.join(__dirname, "serviceAccountKey.json"),
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const projectId = "shraddha-income-tracker";

  // First-time projects need Identity Platform "initialized" before a config exists.
  try {
    const initRes = await client.request({
      url: `https://identitytoolkit.googleapis.com/v2/projects/${projectId}/identityPlatform:initializeAuth`,
      method: "POST",
      data: {},
    });
    console.log("Initialized Identity Platform auth.");
  } catch (e) {
    console.log("(initializeAuth error):", e.response ? JSON.stringify(e.response.data) : e.message);
  }

  const url = `https://identitytoolkit.googleapis.com/v2/projects/${projectId}/config?updateMask=signIn.anonymous.enabled`;
  const res = await client.request({
    url,
    method: "PATCH",
    data: { signIn: { anonymous: { enabled: true } } },
  });
  console.log("Anonymous auth enabled:", JSON.stringify(res.data.signIn, null, 2));
})().catch((err) => {
  console.error("Failed:", err.response ? JSON.stringify(err.response.data, null, 2) : err.message);
  process.exit(1);
});
