// Mirrors ledger classes into a Google Calendar. Each class becomes one event whose id is derived
// from the class's doc id, so writes are idempotent and a class always maps to the same event.
const { GoogleAuth } = require("google-auth-library");

const LEDGER_START = "2026-08-01"; // the ledger has no classes before this
const TIME_ZONE = "Asia/Singapore";
const SOURCE = "teaching-ledger";   // tag on every event this code owns, so it never touches anything else
const API = "https://www.googleapis.com/calendar/v3";

const ORG_LABELS = {
  mindstretcher: "Mind Stretcher", ottodot: "Ottodot", mastermaths: "Mastermaths",
  bluetree: "Bluetree", primeplus: "PrimePlus"
};
// Google Calendar's fixed event colours, picked to sit close to each centre's colour in the app.
const ORG_COLOR_IDS = { mindstretcher: "9", ottodot: "6", mastermaths: "2", bluetree: "7", primeplus: "5" };
const CUSTOM_COLOR_ID = "8";
const PRIMEPLUS_LABELS = { "1-1": "1-to-1", "pri": "Primary group", "sec": "Secondary group" };
const OTTODOT_SUBJECT_LABELS = { SCI: "Sci", MATH: "Math", ENG: "Eng" };

function parseOttodotLabel(raw) {
  if (!raw) return null;
  const m = raw.match(/^([A-Za-z]+\d+)\d{4}-([A-Za-z]+)-/);
  if (!m) return null;
  const subj = m[2].toUpperCase();
  return m[1].toUpperCase() + " " + (OTTODOT_SUBJECT_LABELS[subj] || subj.charAt(0) + subj.slice(1).toLowerCase());
}

// Calendar event ids may only use 0-9 and a-v, so the class id is hex-encoded.
function eventIdFor(classId) {
  return "tl" + Buffer.from(classId, "utf8").toString("hex");
}

function pad(n) { return String(n).padStart(2, "0"); }
function addMinutes(date, time, minutes) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi) + minutes * 60000);
  return t.getUTCFullYear() + "-" + pad(t.getUTCMonth() + 1) + "-" + pad(t.getUTCDate()) +
    "T" + pad(t.getUTCHours()) + ":" + pad(t.getUTCMinutes()) + ":00";
}
function nextDay(date) { return addMinutes(date, "00:00", 24 * 60).slice(0, 10); }

function className(c) {
  const bits = [];
  const label = c.org === "ottodot" ? (parseOttodotLabel(c.rawLabel) || c.classLabel) : c.classLabel;
  if (label) bits.push(label);
  if (c.org === "primeplus" && c.category) bits.push(PRIMEPLUS_LABELS[c.category] || c.category);
  let name = bits.join(" · ");
  if (c.description && /trial/i.test(c.description)) name += " (trial)";
  return name;
}

// The event a class should have, or null if it shouldn't be on the calendar
// (deleted, before the ledger starts, or on a trip where you're not working).
function eventFor(c, leaves, orgs) {
  if (!c || c.deletedAt || !c.date || c.date < LEDGER_START) return null;
  if (leaves.some((l) => !l.working && c.date >= l.start && c.date <= l.end)) return null;
  const custom = orgs[c.org];
  const centre = ORG_LABELS[c.org] || (custom && custom.label) || "Class";
  const name = className(c);
  const event = {
    summary: name ? centre + " · " + name : centre,
    colorId: ORG_COLOR_IDS[c.org] || CUSTOM_COLOR_ID,
    status: "confirmed",
    extendedProperties: { private: { source: SOURCE } }
  };
  if (c.startTime) {
    const mins = Math.round((Number(c.durationHours) || 1) * 60);
    event.start = { dateTime: addMinutes(c.date, c.startTime, 0), timeZone: TIME_ZONE };
    event.end = { dateTime: addMinutes(c.date, c.startTime, mins), timeZone: TIME_ZONE };
  } else {
    event.start = { date: c.date };
    event.end = { date: nextDay(c.date) };
  }
  return event;
}

// Compares only the fields eventFor sets, against an event as Google returns it.
function sameEvent(want, have) {
  const when = (x) => x ? (x.date || (x.dateTime || "").slice(0, 19)) : "";
  const haveStart = have.start && have.start.dateTime ? toLocal(have.start.dateTime) : when(have.start);
  const haveEnd = have.end && have.end.dateTime ? toLocal(have.end.dateTime) : when(have.end);
  return want.summary === have.summary && (want.colorId || "") === (have.colorId || "") &&
    when(want.start) === haveStart && when(want.end) === haveEnd;
}
// Google returns times with an offset (e.g. 2026-11-03T18:10:00+08:00); Singapore has no DST.
function toLocal(dateTime) {
  const t = new Date(new Date(dateTime).getTime() + 8 * 3600000);
  return t.toISOString().slice(0, 19);
}

function createClient(keyFile) {
  const auth = new GoogleAuth({ keyFile, scopes: ["https://www.googleapis.com/auth/calendar"] });
  let client = null;
  async function request(opts, attempt = 0) {
    client = client || await auth.getClient();
    try {
      return await client.request(opts);
    } catch (e) {
      const status = e.response && e.response.status;
      const reason = JSON.stringify((e.response && e.response.data) || "");
      if (attempt < 5 && (status === 429 || status >= 500 || (status === 403 && /rateLimit/i.test(reason)))) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        return request(opts, attempt + 1);
      }
      throw e;
    }
  }
  return { request };
}

function calendarApi(client, calendarId) {
  const base = API + "/calendars/" + encodeURIComponent(calendarId) + "/events";
  return {
    async upsert(id, event) {
      try {
        // PUT also brings back an event that was deleted earlier.
        await client.request({ url: base + "/" + id, method: "PUT", data: event });
      } catch (e) {
        if (!e.response || e.response.status !== 404) throw e;
        await client.request({ url: base, method: "POST", data: Object.assign({ id }, event) });
      }
    },
    async remove(id) {
      try {
        await client.request({ url: base + "/" + id, method: "DELETE" });
      } catch (e) {
        if (!e.response || (e.response.status !== 404 && e.response.status !== 410)) throw e;
      }
    },
    async listOurs() {
      const out = [];
      let pageToken = null;
      do {
        const params = new URLSearchParams({ privateExtendedProperty: "source=" + SOURCE, maxResults: "2500" });
        if (pageToken) params.set("pageToken", pageToken);
        const res = await client.request({ url: base + "?" + params });
        out.push(...(res.data.items || []));
        pageToken = res.data.nextPageToken;
      } while (pageToken);
      return out;
    }
  };
}

async function loadContext(db) {
  const [leaveSnap, orgSnap] = await Promise.all([db.collection("leaves").get(), db.collection("orgs").get()]);
  const orgs = {};
  orgSnap.docs.forEach((d) => { orgs[d.id] = d.data(); });
  return { leaves: leaveSnap.docs.map((d) => d.data()), orgs };
}

// One class changed: create, update or remove its event.
async function syncClass(db, cal, classId, data) {
  const { leaves, orgs } = await loadContext(db);
  const event = eventFor(data, leaves, orgs);
  if (event) await cal.upsert(eventIdFor(classId), event);
  else await cal.remove(eventIdFor(classId));
}

// Brings the whole calendar in line with the ledger. Only events tagged as ours are ever changed.
async function reconcile(db, cal, log = () => {}) {
  const [classSnap, ctx, existing] = await Promise.all([db.collection("classes").get(), loadContext(db), cal.listOurs()]);
  const want = new Map();
  classSnap.docs.forEach((d) => {
    const event = eventFor(d.data(), ctx.leaves, ctx.orgs);
    if (event) want.set(eventIdFor(d.id), event);
  });
  const have = new Map(existing.filter((e) => e.status !== "cancelled").map((e) => [e.id, e]));
  let added = 0, updated = 0, removed = 0;
  for (const [id, event] of want) {
    const current = have.get(id);
    if (current && sameEvent(event, current)) continue;
    await cal.upsert(id, event);
    current ? updated++ : added++;
  }
  for (const id of have.keys()) {
    if (want.has(id)) continue;
    await cal.remove(id);
    removed++;
  }
  log({ wanted: want.size, added, updated, removed });
  return { wanted: want.size, added, updated, removed };
}

module.exports = { createClient, calendarApi, syncClass, reconcile, eventFor, eventIdFor, LEDGER_START };
