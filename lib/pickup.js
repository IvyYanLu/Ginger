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
// "17:00-19:00" -> [1020, 1140], or null when either end isn't H:MM / HH:MM.
// Hours 0-23 (24:00 allowed as an end of day), minutes 0-59.
const TIME = /^(\d{1,2}):(\d{2})$/;
const okTime = (t) => { const m = TIME.exec(t ?? ""); return !!m && Number(m[2]) < 60 && (Number(m[1]) < 24 || t.endsWith("24:00")); };
const range = (s) => { const [a, b, extra] = s.split("-"); return extra === undefined && okTime(a) && okTime(b) ? [hhmm(a), hhmm(b)] : null; };

// PICKUP_CUTOFF "MON-THU:10,FRI-SAT:15,SUN:10" -> { MON: 10, …, FRI: 15, SAT: 15, SUN: 10 }. Minutes
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

// Rules "DAYS HH:MM-HH:MM[ EXTRA]" separated by ";". build(days, from, to, extra)
// returns the rule, or a falsy value for an invalid one (warned and skipped).
function parseRules(s, setting, example, parts, build) {
  const out = [];
  for (const r of (s ?? "").split(";").map((x) => x.trim()).filter(Boolean)) {
    const p = r.split(/\s+/);
    const t = p.length === parts && range(p[1]);
    const rule = t && build(dayRange(p[0]), t[0], t[1], p[2]);
    if (rule) out.push(rule);
    else console.warn(`${setting}: ignoring "${r}" (expected e.g. "${example}")`);
  }
  return out;
}

// BUSY_PREP_TIME "FRI-SAT 17:00-19:00 PT30M; SUN 12:00-13:00 PT25M"
export function parseBusy(s) {
  return parseRules(s, "BUSY_PREP_TIME", "FRI-SAT 17:00-19:00 PT30M", 3, (days, from, to, dur) => {
    const minutes = parseDuration(dur, null);
    return days.length && minutes != null && { days, from, to, minutes };
  });
}

// LUNCH_HOURS "MON-SUN 11:00-14:30" -> [{ days, from, to }] (minutes). Several
// windows separated by ";". Lunch-only items can be picked up inside them.
export function parseWindows(s) {
  return parseRules(s, "LUNCH_HOURS", "MON-SUN 11:00-14:30", 2, (days, from, to) => days.length && to > from && { days, from, to });
}
// Inclusive of the end: a 2:30pm pickup is still lunch.
export function inWindows(ms, tz, wins) {
  const w = wallClock(ms, tz);
  return wins.some((r) => r.days.includes(w.dow) && w.min >= r.from && w.min <= r.to);
}
// [{ days: all 7, 11:00–14:30 }] -> "daily 11am–2:30pm"
export function windowsLabel(wins) {
  const dayLabel = (d) => d.length === 7 ? "daily" : d.length === 1 ? cap(d[0]) : `${cap(d[0])}–${cap(d.at(-1))}`;
  const t = (m) => formatTime(`${Math.floor(m / 60)}:${m % 60}`);
  return wins.map((w) => `${dayLabel(w.days)} ${t(w.from)}–${t(w.to)}`).join(", ");
}
const cap = (d) => d[0] + d.slice(1).toLowerCase();

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
    lunch: parseWindows(env.LUNCH_HOURS),
  };
}

// -> { asap: { available, minutes }, slots: [{ at: ISO, label }] }
// With lunch windows set, ASAP and each slot also carry lunch: true/false
// (whether that pickup time is in a lunch window), and lunchLabel describes them.
// Slots: every quarter hour from each period's opening time, plus the last
// pickup time (closing minus cutoff on the day's final period), never earlier
// than now + prep. Owner's rule: the first scheduled pickup is the opening time
// itself (the kitchen preps scheduled orders before opening). Days: today plus the next (days - 1) calendar days.
export function pickupOptions(location, settings, now = Date.now()) {
  const tz = location?.timezone || "America/New_York";
  const periods = location?.business_hours?.periods ?? [];
  const { base, busy, cutoff, days, lunch = [] } = settings;
  const lunchAt = (t) => (lunch.length ? { lunch: inWindows(t, tz, lunch) } : {});
  const prepNow = prepAt(now, tz, base, busy);
  const earliestNow = now + prepNow * MIN;
  const today = wallClock(now, tz);
  const todayUtc = Date.UTC(today.y, today.mo - 1, today.d);
  const slots = new Map();
  let asap = false;

  // k = -1: yesterday's periods that run past midnight may still be open.
  for (let k = -1; k < days; k++) {
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
        // Label from the slot's own local date (a 12:30am slot is tomorrow).
        const w = wallClock(t, tz);
        const dd = Math.round((Date.UTC(w.y, w.mo - 1, w.d) - todayUtc) / 86_400_000);
        const label = `${dd === 0 ? "Today" : dd === 1 ? "Tomorrow" : cap(w.dow)} ${clock(t, tz)}`;
        slots.set(t, { at: new Date(t).toISOString(), label, ...lunchAt(t) });
      }
    });
  }
  return {
    asap: { available: asap, minutes: prepNow, ...lunchAt(earliestNow) },
    ...(lunch.length && { lunchLabel: windowsLabel(lunch) }),
    slots: [...slots.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
  };
}

// The weekday whose hours apply at instant now: yesterday while one of
// yesterday's periods runs past midnight and hasn't ended yet, else today.
export function businessDay(location, now = Date.now()) {
  const tz = location?.timezone || "America/New_York";
  const w = wallClock(now, tz);
  const yest = DOW[(DOW.indexOf(w.dow) + 6) % 7];
  const open = (location?.business_hours?.periods ?? []).some((p) => {
    if (p.day_of_week !== yest) return false;
    const s = hhmm(p.start_local_time), e = hhmm(p.end_local_time);
    return e <= s && w.min < e;
  });
  return open ? yest : w.dow;
}

function clock(ms, tz) {
  const w = wallClock(ms, tz);
  return formatTime(`${Math.floor(w.min / 60)}:${w.min % 60}`);
}
