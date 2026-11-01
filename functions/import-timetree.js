// One-off: copies a TimeTree export (.ics) into the Google Calendar, keeping each label's colour
// (as the closest Google colour) and the reminders. Safe to re-run: every event gets an id from its
// TimeTree UID, so a second run updates instead of duplicating.
//   node import-timetree.js ~/Downloads/timetree-for-google.ics [--dry-run]
// Uses scripts/serviceAccountKey.json and CALENDAR_ID from functions/.env, like resync-local.js.
const path = require("path");
const fs = require("fs");
const { createClient, calendarApi } = require("./calendar");

const SOURCE = "timetree-import"; // never touched by the ledger sync, which only changes "teaching-ledger" events
// TimeTree label colour → Google event colour.
const COLOR_IDS = {
  "#b38bdc": "1",  // purple → Lavender (relief classes)
  "#fb7f77": "4",  // coral → Flamingo
  "#948078": "8",  // taupe → Graphite
  "#212121": "9",  // black → Blueberry
  "#f35f8c": "3",  // pink → Grape
  "#47b2f7": "7",  // light blue → Peacock (regular classes)
  "#e73b3b": "11", // red → Tomato
  "#fdc02d": "5",  // yellow → Banana
  "#2ecc87": "2",  // green → Sage
  "#3dc2c8": "10"  // teal → Basil
};

function unescapeText(v) { return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1"); }

// "DTSTART;TZID=Asia/Singapore:20261103T181000" → Google start/end object.
function when(params, value) {
  if (/^\d{8}$/.test(value)) return { date: value.slice(0, 4) + "-" + value.slice(4, 6) + "-" + value.slice(6, 8) };
  const iso = value.slice(0, 4) + "-" + value.slice(4, 6) + "-" + value.slice(6, 8) + "T" +
    value.slice(9, 11) + ":" + value.slice(11, 13) + ":" + value.slice(13, 15);
  if (value.endsWith("Z")) return { dateTime: iso + "Z" };
  const tz = (params.match(/TZID=([^;:]+)/) || [])[1] || "Asia/Singapore";
  return { dateTime: iso, timeZone: tz };
}
function dayAfter(date) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
// "-PT10M" / "-PT1H" / "-P1D" → minutes before. Reminders after the start (TimeTree's "on the day at 9am"
// for all-day events) can't be expressed in Google, so they're dropped.
function triggerMinutes(t) {
  const m = t.match(/^-P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+S)?)?$/);
  if (!m) return null;
  return (Number(m[1] || 0) * 7 * 1440) + (Number(m[2] || 0) * 1440) + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
}

function parse(file) {
  const text = fs.readFileSync(file, "utf8").replace(/\r?\n[ \t]/g, "");
  const out = [];
  for (const block of text.match(/BEGIN:VEVENT\r?\n[\s\S]*?END:VEVENT/g) || []) {
    const alarms = block.match(/BEGIN:VALARM[\s\S]*?END:VALARM/g) || [];
    const body = block.replace(/BEGIN:VALARM[\s\S]*?END:VALARM\r?\n?/g, "");
    const ev = { recurrence: [], reminders: [] };
    for (const line of body.split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const key = line.slice(0, i), value = line.slice(i + 1);
      const name = key.split(";")[0];
      if (name === "UID") ev.uid = value;
      else if (name === "SUMMARY") ev.summary = unescapeText(value);
      else if (name === "DESCRIPTION") ev.description = unescapeText(value);
      else if (name === "LOCATION") ev.location = unescapeText(value);
      else if (name === "COLOR") ev.color = value.toLowerCase();
      else if (name === "DTSTART") ev.start = when(key, value);
      else if (name === "DTEND") ev.end = when(key, value);
      else if (name === "RRULE" || name === "EXDATE") ev.recurrence.push(line);
    }
    for (const a of alarms) {
      const t = (a.match(/TRIGGER[^:]*:(.+)/) || [])[1];
      const mins = t ? triggerMinutes(t.trim()) : null;
      if (mins !== null && !ev.reminders.includes(mins)) ev.reminders.push(mins);
    }
    out.push(ev);
  }
  return out;
}

function toGoogle(ev) {
  const event = {
    summary: ev.summary || "(no title)",
    start: ev.start,
    end: ev.end || (ev.start.date ? { date: dayAfter(ev.start.date) } : ev.start),
    status: "confirmed",
    extendedProperties: { private: { source: SOURCE } },
    reminders: ev.reminders.length
      ? { useDefault: false, overrides: ev.reminders.slice(0, 5).map((minutes) => ({ method: "popup", minutes })) }
      : { useDefault: false }
  };
  if (COLOR_IDS[ev.color]) event.colorId = COLOR_IDS[ev.color];
  if (ev.description) event.description = ev.description;
  if (ev.location) event.location = ev.location;
  if (ev.recurrence.length) event.recurrence = ev.recurrence;
  return event;
}

async function main() {
  const file = process.argv[2];
  if (!file) { console.error("Usage: node import-timetree.js <file.ics> [--dry-run]"); process.exit(1); }
  const events = parse(file).map((ev) => ({ id: "tt" + ev.uid.toLowerCase().replace(/[^0-9a-v]/g, ""), event: toGoogle(ev) }));
  const noColor = events.filter((e) => !e.event.colorId).length;
  console.log(events.length + " events, " + events.filter((e) => e.event.recurrence).length + " repeating, " +
    events.filter((e) => e.event.reminders.overrides).length + " with reminders, " + noColor + " without a colour");
  if (process.argv.includes("--dry-run")) {
    events.slice(0, 5).forEach((e) => console.log(JSON.stringify(e)));
    return;
  }
  const keyFile = path.join(__dirname, "..", "scripts", "serviceAccountKey.json");
  const env = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  const calendarId = (env.match(/^CALENDAR_ID=(.+)$/m) || [])[1].trim();
  const cal = calendarApi(createClient(keyFile), calendarId);
  let done = 0;
  for (const { id, event } of events) {
    await cal.upsert(id, event);
    if (++done % 50 === 0) console.log(done + " / " + events.length);
  }
  console.log("Imported " + done + " events.");
}
main().catch((e) => { console.error(e.response ? JSON.stringify(e.response.data) : e); process.exit(1); });
