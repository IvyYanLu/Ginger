import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseDuration, parseCutoff, parseBusy, parseWindows, inWindows, windowsLabel, pickupOptions, pickupSettings, prepAt, localToUtc, wallClock } from "../lib/pickup.js";
import { location, env } from "./fixtures/catalog.js";

const settings = pickupSettings({ ...env, BUSY_PREP_TIME: "FRI-SAT 17:00-19:00 PT30M", PICKUP_CUTOFF: "MON-THU:10,FRI-SAT:15,SUN:10", SCHEDULE_DAYS: "3" });
const at = (iso) => Date.parse(iso);
const opts = (iso) => pickupOptions(location, settings, at(iso));
const labels = (o) => o.slots.map((s) => s.label);

describe("parsers", () => {
  test("parseDuration", () => {
    assert.equal(parseDuration("PT20M"), 20);
    assert.equal(parseDuration("PT1H15M"), 75);
    assert.equal(parseDuration("PT1H"), 60);
    assert.equal(parseDuration("20"), 20);
    assert.equal(parseDuration("", 25), 25);
    assert.equal(parseDuration("PT"), 20);
  });
  test("parseCutoff", () => {
    assert.deepEqual(parseCutoff("MON-FRI:10,SAT-SUN:15"), { MON: 10, TUE: 10, WED: 10, THU: 10, FRI: 10, SAT: 15, SUN: 15 });
    assert.deepEqual(parseCutoff("fri-mon:5"), { FRI: 5, SAT: 5, SUN: 5, MON: 5 });
    assert.deepEqual(parseCutoff("MON-THU:10,FRI-SAT:15,SUN:10"), { MON: 10, TUE: 10, WED: 10, THU: 10, FRI: 15, SAT: 15, SUN: 10 });
    assert.deepEqual(parseCutoff(""), {});
  });
  test("parseBusy", () => {
    assert.deepEqual(parseBusy("FRI-SAT 17:00-19:00 PT30M; SUN 12:00-13:00 PT25M; junk"), [
      { days: ["FRI", "SAT"], from: 1020, to: 1140, minutes: 30 },
      { days: ["SUN"], from: 720, to: 780, minutes: 25 },
    ]);
  });
});

describe("time zones", () => {
  test("localToUtc in EST and EDT", () => {
    assert.equal(new Date(localToUtc(2026, 11, 27, 18 * 60, "America/New_York")).toISOString(), "2026-11-27T23:00:00.000Z");
    assert.equal(new Date(localToUtc(2026, 7, 10, 18 * 60, "America/New_York")).toISOString(), "2026-07-10T22:00:00.000Z");
  });
  test("wallClock", () => assert.deepEqual(wallClock(at("2026-11-28T02:40:00Z"), "America/New_York"), { y: 2026, mo: 11, d: 27, dow: "FRI", min: 21 * 60 + 40 }));
});

describe("busy prep", () => {
  const p = (iso) => prepAt(at(iso), "America/New_York", 20, settings.busy);
  test("Fri 5pm–7pm is 30, edges", () => {
    assert.equal(p("2026-11-27T21:59:00Z"), 20); // 4:59pm
    assert.equal(p("2026-11-27T22:00:00Z"), 30); // 5:00pm
    assert.equal(p("2026-11-27T23:59:00Z"), 30); // 6:59pm
    assert.equal(p("2026-11-28T00:00:00Z"), 20); // 7:00pm
  });
  test("Thursday is not busy", () => assert.equal(p("2026-11-26T22:30:00Z"), 20));
});

describe("pickupOptions (Fri 2026-11-27, America/New_York)", () => {
  test("busy Friday 5:30pm: ASAP 30 min, first slot 6pm, last 9:45pm, then Sat and Sun", () => {
    const o = opts("2026-11-27T22:30:00Z");
    assert.deepEqual(o.asap, { available: true, minutes: 30 });
    assert.deepEqual(o.slots[0], { at: "2026-11-27T23:00:00.000Z", label: "Today 6pm" });
    const l = labels(o);
    assert.equal(l[l.indexOf("Tomorrow 11am") - 1], "Today 9:45pm"); // Fri closes 10pm
    assert.ok(!l.includes("Today 10pm"));
    assert.ok(l.includes("Tomorrow 9:45pm") && !l.includes("Tomorrow 10pm"));
    assert.equal(l.find((x) => x.startsWith("Sun")), "Sun 12pm");
    assert.equal(l.findLast((x) => x.startsWith("Sun")), "Sun 9:20pm"); // Sun closes 9:30pm
    assert.ok(!l.some((x) => x.startsWith("Mon")), "only today + 2 days");
  });
  test("lunch: 2:30pm is the last lunch pickup (no cutoff mid-day)", () => {
    const o = opts("2026-11-27T17:00:00Z"); // 12:00pm
    assert.deepEqual(o.asap, { available: true, minutes: 20 });
    const l = labels(o);
    assert.equal(l[0], "Today 12:30pm");
    assert.equal(l[l.indexOf("Today 2:30pm") + 1], "Today 4pm");
  });
  test("2:25pm: ASAP unavailable during the break, next slot 4pm", () => {
    const o = opts("2026-11-27T19:25:00Z");
    assert.equal(o.asap.available, false);
    assert.deepEqual(labels(o).slice(0, 2), ["Today 4pm", "Today 4:15pm"]);
  });
  test("before opening: schedule from 11am (opening)", () => {
    const o = opts("2026-11-27T14:00:00Z"); // 9am
    assert.equal(o.asap.available, false);
    assert.deepEqual(labels(o).slice(0, 3), ["Today 11am", "Today 11:15am", "Today 11:30am"]);
  });
  test("Saturday 9:40pm: past last pickup, next is Sunday 12pm", () => {
    const o = opts("2026-11-29T02:40:00Z");
    assert.equal(o.asap.available, false);
    assert.equal(labels(o)[0], "Tomorrow 12pm");
  });
  test("ASAP needs now + prep within the window", () => {
    assert.equal(opts("2026-11-27T02:00:00Z").asap.available, true);  // Thu 9:00pm + 20 = 9:20
    assert.equal(opts("2026-11-27T02:01:00Z").asap.available, false); // Thu 9:01pm
    assert.equal(opts("2026-11-28T02:25:00Z").asap.available, true);  // Fri 9:25pm + 20 = 9:45
    assert.equal(opts("2026-11-28T02:26:00Z").asap.available, false); // Fri 9:26pm
  });
  test("summer time (EDT)", () => {
    const o = pickupOptions(location, settings, at("2026-07-10T21:30:00Z")); // Fri 5:30pm EDT
    assert.deepEqual(o.slots[0], { at: "2026-07-10T22:00:00.000Z", label: "Today 6pm" });
  });
  test("no business hours: nothing available", () => {
    assert.deepEqual(pickupOptions({ timezone: "America/New_York" }, settings, at("2026-11-27T17:00:00Z")), { asap: { available: false, minutes: 20 }, slots: [] });
  });
});

describe("lunch windows", () => {
  const tz = "America/New_York";
  test("parseWindows, label, inclusive end", () => {
    const w = parseWindows("MON-SUN 11:00-14:30");
    assert.deepEqual(w, [{ days: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"], from: 660, to: 870 }]);
    assert.equal(windowsLabel(w), "daily 11am–2:30pm");
    assert.equal(windowsLabel(parseWindows("MON-FRI 11:00-14:30; SAT 12:00-15:00")), "Mon–Fri 11am–2:30pm, Sat 12pm–3pm");
    assert.deepEqual(parseWindows(""), []);
    assert.deepEqual(parseWindows("XYZ 11:00-14:30"), []);
    assert.equal(inWindows(at("2026-11-27T19:30:00Z"), tz, w), true);  // 2:30pm
    assert.equal(inWindows(at("2026-11-27T19:31:00Z"), tz, w), false); // 2:31pm
    assert.equal(inWindows(at("2026-11-27T15:59:00Z"), tz, w), false); // 10:59am
  });
  const lunchSettings = pickupSettings({ ...env, BUSY_PREP_TIME: "FRI-SAT 17:00-19:00 PT30M", PICKUP_CUTOFF: "MON-THU:10,FRI-SAT:15,SUN:10", LUNCH_HOURS: "MON-SUN 11:00-14:30" });
  test("slots and ASAP are flagged; Sunday lunch starts at opening (12pm)", () => {
    const o = pickupOptions(location, lunchSettings, at("2026-11-27T17:00:00Z")); // Fri 12:00pm
    assert.equal(o.lunchLabel, "daily 11am–2:30pm");
    assert.deepEqual(o.asap, { available: true, minutes: 20, lunch: true }); // 12:20pm
    const by = Object.fromEntries(o.slots.map((s) => [s.label, s.lunch]));
    assert.equal(by["Today 2:30pm"], true);
    assert.equal(by["Today 4pm"], false);
    assert.equal(by["Tomorrow 11am"], true);
    assert.equal(by["Tomorrow 2:45pm"], false);
    assert.equal(by["Sun 12pm"], true);
    assert.equal(o.slots.filter((s) => s.lunch && s.label.startsWith("Sun"))[0].label, "Sun 12pm");
  });
  test("dinner ASAP is not lunch", () => {
    assert.equal(pickupOptions(location, lunchSettings, at("2026-11-27T22:30:00Z")).asap.lunch, false);
  });
  test("ASAP at 2:10pm lands at 2:30pm: still lunch", () => {
    assert.deepEqual(pickupOptions(location, lunchSettings, at("2026-11-27T19:10:00Z")).asap, { available: true, minutes: 20, lunch: true });
  });
});
