// ==UserScript==
// @name         Ottodot Airtable -> Teaching Ledger Sync
// @namespace    shraddha-teaching-ledger
// @version      1.1
// @description  Reads your Ottodot Airtable schedule and writes classes straight into your Teaching Ledger (Firestore). No copy-paste.
// @match        https://airtable.com/apptZFP6ejwcRA6Il/*
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // ---------------- Firebase config (public web config, not secret) ----------------
  var FIREBASE_API_KEY = "YOUR_FIREBASE_API_KEY";
  var FIREBASE_PROJECT_ID = "shraddha-income-tracker";

  // ---------------- Ottodot rate ----------------
  var OTTODOT_RATE = 35; // flat gross hourly rate, matches computeIncome() in the ledger app

  // Must match the "Relief Teacher (if any)" foreignRowDisplayName exactly (case/whitespace
  // insensitive) when it's you covering your own class — anything else means you weren't
  // the one teaching, so that class isn't billable to you.
  var MY_NAME = "Your Name";

  // This table has no DST and a fixed offset; used to turn the UTC "Class Start"
  // timestamp into a local "HH:MM" without pulling in a timezone library.
  var CLASS_START_UTC_OFFSET_HOURS = 8; // Asia/Singapore

  // ---------------- date/time helpers ----------------
  function pad(n) { return String(n).padStart(2, "0"); }
  function localTimeFromUtcIso(iso) {
    var d = new Date(iso);
    var totalMinutes = (d.getUTCHours() * 60 + d.getUTCMinutes()) + CLASS_START_UTC_OFFSET_HOURS * 60;
    totalMinutes = ((totalMinutes % 1440) + 1440) % 1440;
    var h = Math.floor(totalMinutes / 60), m = totalMinutes % 60;
    return pad(h) + ":" + pad(m);
  }
  function hoursBetween(startIso, endIso) {
    var ms = new Date(endIso).getTime() - new Date(startIso).getTime();
    return Math.round((ms / 3600000) * 100) / 100;
  }
  function normalizeName(s) { return String(s || "").replace(/\s+/g, " ").trim().toLowerCase(); }

  // ---------------- Firebase auth (anonymous, REST) ----------------
  var idToken = null;
  async function ensureAuth() {
    if (idToken) return idToken;
    var res = await fetch(
      "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" + FIREBASE_API_KEY,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }) }
    );
    var data = await res.json();
    if (!data.idToken) throw new Error("Firebase auth failed: " + JSON.stringify(data));
    idToken = data.idToken;
    return idToken;
  }

  function toFirestoreFields(obj) {
    var fields = {};
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (v === null || v === undefined) fields[k] = { nullValue: null };
      else if (typeof v === "number") fields[k] = { doubleValue: v };
      else if (typeof v === "boolean") fields[k] = { booleanValue: v };
      else fields[k] = { stringValue: String(v) };
    });
    return fields;
  }

  async function writeClassDoc(docId, data) {
    var token = await ensureAuth();
    var url =
      "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID +
      "/databases/(default)/documents/classes/" + encodeURIComponent(docId) +
      "?" +
      Object.keys(data).map(function (k) { return "updateMask.fieldPaths=" + encodeURIComponent(k); }).join("&");
    var res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ fields: toFirestoreFields(data) })
    });
    if (!res.ok) throw new Error("Firestore write failed (" + res.status + "): " + (await res.text()));
  }

  // Previously-synced Ottodot classes still marked active (deletedAt == null).
  // Used to detect rows that vanished from Airtable so we can soft-delete them
  // the same way the ledger UI does.
  async function fetchActiveSyncedDocs() {
    var token = await ensureAuth();
    var url =
      "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID +
      "/databases/(default)/documents:runQuery";
    var body = {
      structuredQuery: {
        from: [{ collectionId: "classes" }],
        where: {
          compositeFilter: {
            op: "AND",
            filters: [
              { fieldFilter: { field: { fieldPath: "org" }, op: "EQUAL", value: { stringValue: "ottodot" } } },
              { fieldFilter: { field: { fieldPath: "source" }, op: "EQUAL", value: { stringValue: "synced-ottodot" } } }
            ]
          }
        }
      }
    };
    var res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error("Firestore query failed (" + res.status + "): " + (await res.text()));
    var rows = await res.json();
    var out = [];
    rows.forEach(function (row) {
      if (!row.document) return;
      var id = row.document.name.split("/").pop();
      var fields = row.document.fields || {};
      var deletedAt = fields.deletedAt && (fields.deletedAt.doubleValue || fields.deletedAt.integerValue);
      if (deletedAt) return; // already deleted, skip
      var date = fields.date && fields.date.stringValue;
      out.push({ id: id, date: date });
    });
    return out;
  }

  // ---------------- Airtable shared-view data ----------------
  // Pulls the accessPolicy + view id straight out of the page's own bootstrap
  // script, so we never hardcode a token that could expire or rotate.
  function extractAirtableContext() {
    var scripts = document.querySelectorAll("script:not([src])");
    for (var i = 0; i < scripts.length; i++) {
      var t = scripts[i].textContent;
      var idx = t.indexOf("accessPolicy=");
      if (idx === -1) continue;
      var rest = t.slice(idx + "accessPolicy=".length);
      var end = rest.search(/["'\\]/);
      var encoded = end === -1 ? rest : rest.slice(0, end);
      try {
        var accessPolicy = JSON.parse(decodeURIComponent(encoded));
        var viewAction = accessPolicy.allowedActions.find(function (a) { return a.action === "readSharedViewData"; });
        if (!viewAction) continue;
        return { accessPolicy: accessPolicy, viewId: viewAction.modelIdSelector };
      } catch (e) { continue; }
    }
    return null;
  }

  function randRequestId() {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    var s = "req";
    for (var i = 0; i < 17; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  async function fetchAirtableRows() {
    var ctx = extractAirtableContext();
    if (!ctx) throw new Error("Couldn't find Airtable's access token on this page — reload the page and try again.");
    var params = { shouldUseNestedResponseFormat: true };
    var url =
      "https://airtable.com/v0.3/view/" + ctx.viewId + "/readSharedViewData" +
      "?stringifiedObjectParams=" + encodeURIComponent(JSON.stringify(params)) +
      "&requestId=" + randRequestId() +
      "&accessPolicy=" + encodeURIComponent(JSON.stringify(ctx.accessPolicy));
    var headers = {
      "x-user-locale": "en",
      "x-airtable-application-id": ctx.accessPolicy.applicationId,
      "X-Requested-With": "XMLHttpRequest",
      "x-airtable-inter-service-client": "webClient",
      "x-time-zone": Intl.DateTimeFormat().resolvedOptions().timeZone
    };
    var res = await fetch(url, { method: "get", headers: headers, credentials: "same-origin" });
    if (!res.ok) throw new Error("Airtable fetch failed (" + res.status + ")");
    var data = await res.json();
    if (data.msg !== "SUCCESS") throw new Error("Airtable returned: " + JSON.stringify(data).slice(0, 200));
    return data.data.table;
  }

  function findColumnId(columns, wantedName) {
    var wanted = normalizeName(wantedName);
    var col = columns.find(function (c) { return normalizeName(c.name) === wanted; });
    return col ? col.id : null;
  }

  // ---------------- UI ----------------
  function makeUi() {
    var box = document.createElement("div");
    box.style.cssText =
      "position:fixed;bottom:20px;right:20px;z-index:99999;background:#1B2420;color:#fff;" +
      "font-family:sans-serif;border-radius:12px;padding:14px 16px;box-shadow:0 8px 24px rgba(0,0,0,.3);width:280px;";
    box.innerHTML =
      '<div style="font-weight:700;margin-bottom:8px;">Teaching Ledger Sync</div>' +
      '<button id="tl-sync-btn" style="width:100%;padding:10px;border:none;border-radius:8px;background:#7C3FA0;color:#fff;font-weight:700;cursor:pointer;">Sync to Ledger</button>' +
      '<div id="tl-sync-status" style="margin-top:8px;font-size:12px;opacity:.85;white-space:pre-wrap;max-height:160px;overflow-y:auto;"></div>';
    document.body.appendChild(box);
    return {
      button: box.querySelector("#tl-sync-btn"),
      status: box.querySelector("#tl-sync-status")
    };
  }

  function run() {
    var ui = makeUi();
    ui.button.addEventListener("click", async function () {
      ui.button.disabled = true;
      ui.button.textContent = "Syncing…";
      var log = [];
      function say(msg) {
        log.push(msg);
        ui.status.textContent = log.slice(-8).join("\n");
      }

      try {
        await ensureAuth();
        say("Signed in.");

        say("Reading Airtable schedule…");
        var table = await fetchAirtableRows();
        var classCodeColId = findColumnId(table.columns, "Class Code");
        var dateColId = findColumnId(table.columns, "Date");
        var startColId = findColumnId(table.columns, "Class Start");
        var endColId = findColumnId(table.columns, "Class End");
        var reliefColId = findColumnId(table.columns, "Relief Teacher (if any)");
        if (!classCodeColId || !dateColId || !startColId || !endColId) {
          throw new Error("Couldn't find expected columns (Class Code / Date / Class Start / Class End) — the table layout may have changed.");
        }

        var written = 0, skipped = 0, coveredByRelief = 0, zeroDuration = 0;
        var seenDocIds = {};
        // Airtable only ever shows today onward, never past sessions — track the
        // earliest date it actually returned so reconciliation below never treats
        // history (dates before this) as "removed".
        var minDateSeen = null;

        for (var ri = 0; ri < table.rows.length; ri++) {
          var row = table.rows[ri];
          var cv = row.cellValuesByColumnId;
          var codeCell = cv[classCodeColId];
          var date = cv[dateColId];
          var startIso = cv[startColId];
          var endIso = cv[endColId];
          var rawLabel = codeCell && codeCell[0] && codeCell[0].foreignRowDisplayName;

          if (!rawLabel || !date || !startIso || !endIso) { skipped++; continue; }
          if (minDateSeen === null || date < minDateSeen) minDateSeen = date;

          // If someone else covered this class, it's not billable to me — skip
          // writing it, and don't mark it "seen" so the reconciliation pass below
          // soft-deletes it if it was already synced (e.g. a relief teacher got
          // assigned after the first sync).
          var reliefCell = reliefColId ? cv[reliefColId] : null;
          var reliefName = reliefCell && reliefCell[0] && reliefCell[0].foreignRowDisplayName;
          if (reliefName && normalizeName(reliefName) !== normalizeName(MY_NAME)) {
            coveredByRelief++;
            continue;
          }

          var durationHours = hoursBetween(startIso, endIso);

          // Class Start == Class End means Airtable's Duration field was never
          // filled in for this row — bad source data, not a real 0-hour class.
          // Skip it (and don't mark it "seen") rather than silently syncing $0,
          // so it doesn't look like a legitimately-zero class and reconciliation
          // removes it if it was already synced before the gap was noticed.
          if (durationHours <= 0) {
            zeroDuration++;
            continue;
          }

          var income = Math.round(OTTODOT_RATE * durationHours * 100) / 100;
          var docId = "ottodot_" + rawLabel + "_" + date;
          seenDocIds[docId] = true;

          await writeClassDoc(docId, {
            org: "ottodot",
            date: date,
            startTime: localTimeFromUtcIso(startIso),
            durationHours: durationHours,
            rawLabel: rawLabel,
            rate: OTTODOT_RATE,
            income: income,
            source: "synced-ottodot",
            seriesId: null,
            deletedAt: null,
            createdAt: Date.now()
          });
          written++;
        }

        say("Done. " + written + " classes synced.");
        if (skipped) say(skipped + " rows skipped (missing code/date/time).");
        if (coveredByRelief) say(coveredByRelief + " classes excluded (covered by a relief teacher).");
        if (zeroDuration) say(zeroDuration + " classes skipped (Airtable has no Duration set — fix in Airtable and re-sync).");

        say("Checking for classes removed from Airtable…");
        var removed = 0;
        try {
          if (minDateSeen === null) {
            say("Skipped removal check (no rows read, so nothing to compare against).");
          } else {
            var activeSynced = await fetchActiveSyncedDocs();
            for (var ai = 0; ai < activeSynced.length; ai++) {
              var doc = activeSynced[ai];
              // Never touch history: Airtable itself never shows dates before
              // minDateSeen, so a missing doc there just means it's in the past,
              // not that it was removed.
              if (!doc.date || doc.date < minDateSeen) continue;
              if (seenDocIds[doc.id]) continue;
              await writeClassDoc(doc.id, { deletedAt: Date.now() });
              removed++;
            }
            say(removed + " classes removed (no longer in Airtable).");
          }
        } catch (e) {
          say("Warning: couldn't check for removed classes: " + e.message);
        }
      } catch (err) {
        say("Error: " + err.message);
        console.error(err);
      } finally {
        ui.button.disabled = false;
        ui.button.textContent = "Sync to Ledger";
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
