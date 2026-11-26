// Pickup times: prep time, busy windows, closing cutoffs and scheduled slots.
// Pure functions; all clock math is done in the location's IANA time zone.
import { formatTime } from "./square.js";

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const STEP_MIN = 15;
const MIN = 60_000;

// "PT20M" / "PT1H" / "PT1H15M" -> minutes. Falls back on anything else.
export function parseDuration(s, fallback = 20) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec((s ?? "").trim());
  if (!m || (!m[1] && !m[2])) return fallback;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}
export const toDuration = (min) => `PT${min}M`;

// "MON-FRI" -> ["MON",…,"FRI"]; "SAT" -> ["SAT"]. Ranges wrap (FRI-MON).
function dayRange(s) {
  const [a, b = a] = s.trim().toUpperCase().split("-");
  const i = DOW.indexOf(a), j = DOW.indexOf(b);
  if (i < 0 || j < 0) return [];
  const out = [];
  for (let k = i; ; k = (k + 1) % 7) { out.push(DOW[k]); if (k === j) break; }
  return out;
}
const hhmm = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + (m || 0); };

// PICKUP_CUTOFF "MON-FRI:10,SAT-SUN:15" -> { MON: 10, …, SUN: 15 }. Minutes
// before each day's final closing time when the last pickup is offered.
export function parseCutoff(s) {
  const out = {};
  for (const part of (s ?? "").split(",")) {
    const [days, min] = part.split(":");
    if (!min) continue;
    for (const d of dayRange(days)) out[d] = Number(min) || 0;
  }
  return out;
}

// BUSY_PREP_TIME "FRI-SAT 17:00-19:00 PT30M; SUN 12:00-13:00 PT25M"
export function parseBusy(s) {
  return (s ?? "").split(";").map((r) => r.trim().split(/\s+/)).filter((p) => p.length === 3).map(([days, times, dur]) => {
    const [from, to] = times.split("-");
    return { days: dayRange(days), from: hhmm(from), to: hhmm(to), minutes: parseDuration(dur, null) };
  }).filter((r) => r.days.length && r.minutes != null);
}

// --- time zone helpers ------------------------------------------------------
const fmtCache = new Map();
function partsAt(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}
// Local wall clock at an instant: date, weekday and minutes since midnight.
export function wallClock(ms, tz) {
  const p = partsAt(ms, tz);
  return { y: p.y, mo: p.mo, d: p.d, dow: DOW[new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay()], min: p.h * 60 + p.mi };
}
const offsetAt = (ms, tz) => {
  const p = partsAt(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
};
// Local date + minutes since midnight (may exceed 1440) -> UTC ms.
export function localToUtc(y, mo, d, minutes, tz) {
  const guess = Date.UTC(y, mo - 1, d, 0, minutes);
  const t = guess - offsetAt(guess, tz);
  const off2 = offsetAt(t, tz);
  return guess - off2; // re-check across a DST change
}

// Prep minutes for an order placed (or started) at instant ms.
export function prepAt(ms, tz, base, busy) {
  const w = wallClock(ms, tz);
  const rule = busy.find((r) => r.days.includes(w.dow) && w.min >= r.from && w.min < r.to);
  return rule ? rule.minutes : base;
}

export function pickupSettings(env = {}) {
  return {
    base: parseDuration(env.PREP_TIME, 20),
    busy: parseBusy(env.BUSY_PREP_TIME),
    cutoff: parseCutoff(env.PICKUP_CUTOFF),
    days: Math.max(1, Number(env.SCHEDULE_DAYS) || 3),
  };
}

// -> { asap: { available, minutes }, slots: [{ at: ISO, label }] }
// Slots: every quarter hour from each period's opening time, plus the last
// pickup time (closing minus cutoff on the day's final period), never earlier
// than now + prep. Owner's rule: the first scheduled pickup is the opening time
// itself (the kitchen preps scheduled orders before opening). Days: today plus the next (days - 1) calendar days.
export function pickupOptions(location, settings, now = Date.now()) {
  const tz = location?.timezone || "America/New_York";
  const periods = location?.business_hours?.periods ?? [];
  const { base, busy, cutoff, days } = settings;
  const prepNow = prepAt(now, tz, base, busy);
  const earliestNow = now + prepNow * MIN;
  const today = wallClock(now, tz);
  const slots = new Map();
  let asap = false;

  for (let k = 0; k < days; k++) {
    const dt = new Date(Date.UTC(today.y, today.mo - 1, today.d + k));
    const [y, mo, d, dow] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), DOW[dt.getUTCDay()]];
    const dayPeriods = periods.filter((p) => p.day_of_week === dow)
      .map((p) => { const s = hhmm(p.start_local_time); let e = hhmm(p.end_local_time); if (e <= s) e += 1440; return { s, e }; })
      .sort((a, b) => a.s - b.s);
    dayPeriods.forEach(({ s, e }, i) => {
      if (i === dayPeriods.length - 1) e -= cutoff[dow] ?? 0;
      const startMs = localToUtc(y, mo, d, s, tz);
      const endMs = localToUtc(y, mo, d, e, tz);
      if (endMs <= startMs) return;
      if (now >= startMs && earliestNow <= endMs) asap = true;
      const cands = [endMs];
      for (let m = Math.ceil(s / STEP_MIN) * STEP_MIN; m < e; m += STEP_MIN) cands.push(localToUtc(y, mo, d, m, tz));
      for (const t of cands) {
        if (t < startMs || t > endMs || t < earliestNow) continue;
        const label = `${k === 0 ? "Today" : k === 1 ? "Tomorrow" : dow[0] + dow.slice(1).toLowerCase()} ${clock(t, tz)}`;
        slots.set(t, { at: new Date(t).toISOString(), label });
      }
    });
  }
  return {
    asap: { available: asap, minutes: prepNow },
    slots: [...slots.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
  };
}

function clock(ms, tz) {
  const w = wallClock(ms, tz);
  return formatTime(`${Math.floor(w.min / 60)}:${w.min % 60}`);
}
