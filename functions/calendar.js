// Mirrors ledger classes into a Google Calendar. Each class becomes one event whose id is derived
// from the class's doc id, so writes are idempotent and a class always maps to the same event.
const { GoogleAuth } = require("google-auth-library");

const LEDGER_START = "2026-08-01"; // the ledger has no classes before this
const TIME_ZONE = "Asia/Singapore";
const SOURCE = "teaching-ledger";   // tag on every event this code owns, so it never touches anything else
const API = "https://www.googleapis.com/calendar/v3";

// Short names in event titles; custom centres use their "short" field, else their full name.
const ORG_SHORT = { mindstretcher: "MS", ottodot: "Otto", mastermaths: "MM", bluetree: "BT", primeplus: "PP" };
// Same defaults as the app: these centres are always online.
const ORG_DEFAULT_MODE = { ottodot: "online", primeplus: "online" };
// Same colours as the TimeTree labels: Peacock (blue) for regular classes, Lavender (purple) for relief.
const REGULAR_COLOR_ID = "7";
const RELIEF_COLOR_ID = "1";
// BestMinds marking deadlines are all-day events in Tangerine, so they stand apart from classes.
const MARKING_COLOR_ID = "6";
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

function markingEventIdFor(batchId) {
  return "tm" + Buffer.from(batchId, "utf8").toString("hex");
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
  let label = c.org === "ottodot" ? (parseOttodotLabel(c.rawLabel) || c.classLabel) : c.classLabel;
  // Just the class: "P5 Science (GEP/High Achiever)" → "P5 Science".
  if (label) label = label.replace(/\s*\(.*?\)\s*/g, " ").replace(/English And Language Arts/i, "English").trim();
  if (label) bits.push(label);
  let name = bits.join(" ");
  if (c.description && /trial/i.test(c.description)) name += " (trial)";
  return name;
}

function slotKey(c, date) {
  return [c.org, date, c.startTime || "", c.org === "ottodot" ? c.rawLabel || "" : ""].join("|");
}
// Set of slotKeys for live classes, used to spot weekly classes.
function slotsOf(classes) {
  return new Set(classes.filter((c) => !c.deletedAt).map((c) => slotKey(c, c.date)));
}
// Uses Dash's RELIEF tag when the MS sync recorded it. Otherwise Mind Stretcher counts as relief, and
// elsewhere a class is regular if it repeats weekly in the same slot.
function isRegular(c, slots) {
  if (typeof c.relief === "boolean") return !c.relief;
  if (c.org === "mindstretcher") return false;
  if (c.seriesId) return true;
  return [-7, 7].some((days) => slots.has(slotKey(c, addMinutes(c.date, "00:00", days * 24 * 60).slice(0, 10))));
}

// The event a class should have, or null if it shouldn't be on the calendar
// (deleted, before the ledger starts, or on a trip where you're not working).
function eventFor(c, leaves, orgs, slots) {
  if (!c || c.deletedAt || !c.date || c.date < LEDGER_START) return null;
  if (leaves.some((l) => !l.working && c.date >= l.start && c.date <= l.end)) return null;
  const custom = orgs[c.org];
  const centre = ORG_SHORT[c.org] || (custom && (custom.short || custom.label)) || "Class";
  const usual = ORG_DEFAULT_MODE[c.org] || (custom && custom.mode) || null;
  const mode = c.mode || usual;
  // Only spelled out when it isn't obvious from the centre: Otto online or MC physical needs no label.
  const where = mode === "physical" && c.place ? c.place
    : mode === usual ? null
    : mode === "online" ? "Online" : mode === "physical" ? "Physical" : null;
  const event = {
    summary: [centre, className(c), where].filter(Boolean).join(" "),
    location: mode === "online" ? "Online" : (mode === "physical" && c.place) || "",
    colorId: isRegular(c, slots) ? REGULAR_COLOR_ID : RELIEF_COLOR_ID,
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

// A marking batch's event: all day on its due date, ticked once it's finished.
function markingEventFor(b) {
  if (!b || b.deletedAt || !b.due) return null;
  return {
    summary: [b.doneDate ? "✓" : "", "BM marking", b.scripts + " scripts", b.label].filter(Boolean).join(" "),
    location: "",
    colorId: MARKING_COLOR_ID,
    status: "confirmed",
    extendedProperties: { private: { source: SOURCE } },
    start: { date: b.due },
    end: { date: nextDay(b.due) }
  };
}

async function syncBatch(cal, batchId, data) {
  const event = markingEventFor(data);
  if (event) await cal.upsert(markingEventIdFor(batchId), event);
  else await cal.remove(markingEventIdFor(batchId));
}

// Compares only the fields eventFor sets, against an event as Google returns it.
function sameEvent(want, have) {
  const when = (x) => x ? (x.date || (x.dateTime || "").slice(0, 19)) : "";
  const haveStart = have.start && have.start.dateTime ? toLocal(have.start.dateTime) : when(have.start);
  const haveEnd = have.end && have.end.dateTime ? toLocal(have.end.dateTime) : when(have.end);
  return want.summary === have.summary && (want.colorId || "") === (have.colorId || "") &&
    (want.location || "") === (have.location || "") &&
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
    // For events known not to exist yet: one call instead of a failed PUT plus a POST.
    async insert(id, event) {
      try {
        await client.request({ url: base, method: "POST", data: Object.assign({ id }, event) });
      } catch (e) {
        if (!e.response || e.response.status !== 409) throw e; // id was used before (deleted event): reuse it
        await client.request({ url: base + "/" + id, method: "PUT", data: event });
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

// One class changed: create, update or remove its event. The same slot a week either side is
// refreshed too, since a class appearing or disappearing can make those regular or relief.
async function syncClass(db, cal, classId, data, before) {
  const c = data || before;
  if (!c || !c.org) return;
  const [{ leaves, orgs }, orgSnap] = await Promise.all([loadContext(db), db.collection("classes").where("org", "==", c.org).get()]);
  const all = orgSnap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  const slots = slotsOf(all);
  const event = eventFor(data, leaves, orgs, slots);
  if (event) await cal.upsert(eventIdFor(classId), event);
  else await cal.remove(eventIdFor(classId));
  if (!c.date) return;
  const near = new Set([-7, 7].map((days) => slotKey(c, addMinutes(c.date, "00:00", days * 24 * 60).slice(0, 10))));
  for (const n of all) {
    if (n.id === classId || !near.has(slotKey(n, n.date))) continue;
    const e = eventFor(n, leaves, orgs, slots);
    if (e) await cal.upsert(eventIdFor(n.id), e);
  }
}

// Runs async jobs a few at a time (Google rate-limits bursts; failed calls are retried by the client).
async function runPool(jobs, size) {
  let next = 0;
  async function worker() {
    while (next < jobs.length) await jobs[next++]();
  }
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, worker));
}

// Brings the whole calendar in line with the ledger. Only events tagged as ours are ever changed.
async function reconcile(db, cal, log = () => {}) {
  const [classSnap, markingSnap, ctx, existing] = await Promise.all([
    db.collection("classes").get(), db.collection("marking").get(), loadContext(db), cal.listOurs()
  ]);
  const want = new Map();
  const slots = slotsOf(classSnap.docs.map((d) => d.data()));
  classSnap.docs.forEach((d) => {
    const event = eventFor(d.data(), ctx.leaves, ctx.orgs, slots);
    if (event) want.set(eventIdFor(d.id), event);
  });
  markingSnap.docs.forEach((d) => {
    const event = markingEventFor(d.data());
    if (event) want.set(markingEventIdFor(d.id), event);
  });
  const have = new Map(existing.filter((e) => e.status !== "cancelled").map((e) => [e.id, e]));
  let added = 0, updated = 0, removed = 0;
  const jobs = [];
  for (const [id, event] of want) {
    const current = have.get(id);
    if (current && sameEvent(event, current)) continue;
    if (current) { updated++; jobs.push(() => cal.upsert(id, event)); }
    else { added++; jobs.push(() => cal.insert(id, event)); }
  }
  for (const id of have.keys()) {
    if (want.has(id)) continue;
    removed++;
    jobs.push(() => cal.remove(id));
  }
  await runPool(jobs, 4);
  log({ wanted: want.size, added, updated, removed });
  return { wanted: want.size, added, updated, removed };
}

module.exports = { createClient, calendarApi, syncClass, syncBatch, reconcile, eventFor, eventIdFor, markingEventFor, LEDGER_START };
