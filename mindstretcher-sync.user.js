// ==UserScript==
// @name         Mind Stretcher -> Teaching Ledger Sync
// @namespace    shraddha-teaching-ledger
// @version      1.1
// @description  Reads your Dash schedule + attendance and writes classes straight into your Teaching Ledger (Firestore). No copy-paste.
// @match        https://dash.mindstretcher.com/teacher/my-schedule/*
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // ---------------- Firebase config (public web config, not secret) ----------------
  var FIREBASE_API_KEY = "YOUR_FIREBASE_API_KEY";
  var FIREBASE_PROJECT_ID = "shraddha-income-tracker";

  // ---------------- Mind Stretcher gross hourly rate tables ----------------
  // index 0 = class size 1 ... index 19 = size 20 (clamp above 20 to index 19)
  var MINDSTRETCHER_RATES = {
    preprimary: {
      weekday: [20,21,22,32,33,34,37,38,39,40,41,44,46,48,50,55,58,61,64,67],
      weekend: [25,26,27,38,39,40,43,44,45,46,47,49,51,53,55,60,63,66,69,72]
    },
    p1_p4: {
      weekday: [24,25,26,29,30,31,36,37,38,39,40,45,47,49,51,58,61,64,67,73],
      weekend: [27,28,29,32,33,34,38,39,40,41,42,49,51,53,55,62,66,70,74,78]
    },
    p5_p6: {
      weekday: [27,28,29,34,35,36,40,41,42,43,44,50,52,54,56,63,66,69,72,75],
      weekend: [30,31,32,37,38,39,43,44,45,46,47,54,56,58,60,67,71,75,79,83]
    },
    p5_p6_writing: {
      weekday: [30,31,32,37,38,39,43,44,45,46,47,54,56,58,60,66,69,72,75,78],
      weekend: [33,34,35,40,41,42,48,49,50,51,52,59,61,63,65,72,76,80,84,88]
    },
    secondary: {
      weekday: [30,31,32,37,38,39,44,45,46,47,48,55,57,59,61,68,72,76,80,84],
      weekend: [35,36,37,42,43,44,49,51,52,53,54,60,62,64,66,73,77,81,85,89]
    }
  };

  function levelFromTitle(title) {
    var t = title.trim();
    if (/^(K\d|N\d)/i.test(t)) return "preprimary";
    var m = t.match(/^P(\d{1,2})\b/i);
    if (m) {
      var n = parseInt(m[1], 10);
      if (n >= 1 && n <= 4) return "p1_p4";
      if (n === 5 || n === 6) return /writing/i.test(t) ? "p5_p6_writing" : "p5_p6";
    }
    if (/^S\d/i.test(t)) return "secondary";
    if (/^OL\b/i.test(t)) return "secondary"; // O-Level = Sec 4
    return null;
  }

  function rateFor(level, weekend, size) {
    var table = MINDSTRETCHER_RATES[level];
    if (!table) return null;
    var arr = weekend ? table.weekend : table.weekday;
    var idx = Math.min(Math.max(size, 1), 20) - 1;
    return arr[idx];
  }

  // ---------------- date helpers ----------------
  function pad(n) { return String(n).padStart(2, "0"); }
  function addDaysToDateStr(dateStr, n) {
    var p = dateStr.split("-").map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    d.setDate(d.getDate() + n);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function mondayOnOrBefore(dateStr) {
    var p = dateStr.split("-").map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    var dow = (d.getDay() + 6) % 7; // 0=Mon
    d.setDate(d.getDate() - dow);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function firstOfPrevMonth(dateStr) {
    var p = dateStr.split("-").map(Number);
    var d = new Date(p[0], p[1] - 1, 1); // first of this month
    d.setMonth(d.getMonth() - 1); // first of last month
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-01";
  }
  // "Sat 9:00 AM - 11:00 AM" -> {weekday:"Sat", start:"09:00", end:"11:00", hours:2}
  function parseMeta(meta) {
    var m = meta.match(/(\w{3})\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)/i);
    if (!m) return null;
    function to24(t) {
      var mm = t.trim().match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
      var h = parseInt(mm[1], 10), min = mm[2], ap = mm[3].toUpperCase();
      if (ap === "PM" && h !== 12) h += 12;
      if (ap === "AM" && h === 12) h = 0;
      return pad(h) + ":" + min;
    }
    var start = to24(m[2]), end = to24(m[3]);
    var sh = parseInt(start.split(":")[0], 10) + parseInt(start.split(":")[1], 10) / 60;
    var eh = parseInt(end.split(":")[0], 10) + parseInt(end.split(":")[1], 10) / 60;
    return { weekday: m[1], start: start, hours: Math.round((eh - sh) * 100) / 100 };
  }
  var WEEKDAY_COL = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

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

  // Previously-synced Mind Stretcher classes still marked active (deletedAt == null).
  // Used to detect sessions that vanished from Dash (cancelled/rescheduled) so we can
  // soft-delete them the same way the ledger UI does.
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
              { fieldFilter: { field: { fieldPath: "org" }, op: "EQUAL", value: { stringValue: "mindstretcher" } } },
              { fieldFilter: { field: { fieldPath: "source" }, op: "EQUAL", value: { stringValue: "synced-mindstretcher" } } }
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
      var date = fields.date && fields.date.stringValue;
      if (deletedAt || !date) return; // already deleted, skip
      out.push({ id: id, date: date });
    });
    return out;
  }

  // ---------------- Dash scraping ----------------
  async function fetchScheduleWeek(weekStart) {
    var res = await fetch("https://dash.mindstretcher.com/teacher/my-schedule/?week_start=" + weekStart, {
      credentials: "same-origin"
    });
    var html = await res.text();
    var doc = new DOMParser().parseFromString(html, "text/html");

    var dayDates = {}; // col index -> "YYYY-MM-DD"
    doc.querySelectorAll(".table-zoom-my-schedule thead th").forEach(function (th, i) {
      if (i === 0) return; // time column
      dayDates[i - 1] = addDaysToDateStr(weekStart, i - 1);
    });

    var sessions = [];
    doc.querySelectorAll(".table-zoom-my-schedule tbody tr").forEach(function (tr) {
      var cells = tr.querySelectorAll("td.td-zoom-my-schedule-cell");
      cells.forEach(function (td, i) {
        var card = td.querySelector(".card-zoom-my-schedule-session");
        if (!card) return;
        var title = card.getAttribute("data-session-title") || "";
        var meta = card.getAttribute("data-session-meta") || "";
        var sessionId = card.getAttribute("data-session-id");
        var parsedMeta = parseMeta(meta);
        if (!sessionId || !parsedMeta) return;
        sessions.push({
          sessionId: sessionId,
          title: title,
          date: dayDates[i],
          weekday: parsedMeta.weekday,
          startTime: parsedMeta.start,
          durationHours: parsedMeta.hours
        });
      });
    });
    return sessions;
  }

  async function fetchAttendance(sessionId) {
    var res = await fetch("https://dash.mindstretcher.com/teacher/my-schedule/session/" + sessionId + "/panel/", {
      credentials: "same-origin",
      headers: { "HX-Request": "true", "X-Requested-With": "XMLHttpRequest" }
    });
    var html = await res.text();
    var doc = new DOMParser().parseFromString(html, "text/html");
    var totalBadge = doc.querySelector(".attendance-student-count-badge");
    var total = totalBadge ? parseInt(totalBadge.textContent.trim(), 10) : null;
    var makeupCount = doc.querySelectorAll(".attendance-badge-makeup").length;
    return { total: total, makeupCount: makeupCount };
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

        var today = todayStr();
        var startMonday = mondayOnOrBefore(firstOfPrevMonth(today)); // always covers all of last month
        var horizon = addDaysToDateStr(today, 84); // 12 weeks forward
        var weeks = [];
        for (var w = startMonday; w <= horizon; w = addDaysToDateStr(w, 7)) weeks.push(w);

        var written = 0, skippedUnknownLevel = [], skippedNoAttendance = 0;
        var seenDocIds = {}; // every session currently on Dash in the synced window, so we can detect removals

        for (var wi = 0; wi < weeks.length; wi++) {
          say("Reading week " + (wi + 1) + "/" + weeks.length + "…");
          var sessions = await fetchScheduleWeek(weeks[wi]);
          sessions.forEach(function (s) { seenDocIds["mindstretcher_" + s.sessionId] = true; });
          for (var si = 0; si < sessions.length; si++) {
            var s = sessions[si];
            var level = levelFromTitle(s.title);
            if (!level) {
              skippedUnknownLevel.push(s.title);
              continue;
            }
            var att;
            try {
              att = await fetchAttendance(s.sessionId);
            } catch (e) {
              skippedNoAttendance++;
              continue;
            }
            if (att.total === null) { skippedNoAttendance++; continue; }
            var billableSize = Math.max(0, att.total - att.makeupCount);
            var weekend = s.weekday === "Sat" || s.weekday === "Sun";
            var rate = rateFor(level, weekend, billableSize);
            var income = Math.round(rate * s.durationHours * 100) / 100;

            await writeClassDoc("mindstretcher_" + s.sessionId, {
              org: "mindstretcher",
              date: s.date,
              startTime: s.startTime,
              durationHours: s.durationHours,
              level: level,
              weekdayOrWeekend: weekend ? "weekend" : "weekday",
              studentCount: billableSize,
              classLabel: s.title,
              rate: rate,
              income: income,
              source: "synced-mindstretcher",
              seriesId: null,
              deletedAt: null,
              createdAt: Date.now()
            });
            written++;
          }
        }

        say("Done. " + written + " classes synced.");
        if (skippedUnknownLevel.length) {
          say(skippedUnknownLevel.length + " skipped (unrecognized level): " + Array.from(new Set(skippedUnknownLevel)).join(", "));
        }
        if (skippedNoAttendance) say(skippedNoAttendance + " skipped (couldn't read attendance).");

        say("Checking for classes removed from Dash…");
        var removed = 0;
        try {
          var activeSynced = await fetchActiveSyncedDocs();
          for (var ai = 0; ai < activeSynced.length; ai++) {
            var doc = activeSynced[ai];
            // Only touch docs inside the window we just scanned; leave older history alone.
            if (doc.date < startMonday || doc.date > horizon) continue;
            if (seenDocIds[doc.id]) continue;
            await writeClassDoc(doc.id, { deletedAt: Date.now() });
            removed++;
          }
          say(removed + " classes removed (no longer on Dash).");
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
