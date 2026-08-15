'use strict';

/**
 * Session context: the Asian range and the London / New York killzones.
 *
 * ICT session windows are defined in New York local time and shift with US
 * daylight saving, so hours are resolved through the IANA zone rather than a
 * fixed UTC offset. Hard-coding UTC-5 silently moves every window by an hour
 * for two-thirds of the year.
 */

const ZONE = 'America/New_York';

const WINDOWS = {
  asia: { start: 20, end: 24, label: 'Asian range (20:00-00:00 ET)' },
  london: { start: 2, end: 5, label: 'London killzone (02:00-05:00 ET)' },
  nyAm: { start: 7, end: 10, label: 'New York AM killzone (07:00-10:00 ET)' },
  nyPm: { start: 13, end: 16, label: 'New York PM session (13:00-16:00 ET)' },
};

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  hour: 'numeric',
  hour12: false,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** New York wall-clock parts for a unix timestamp. */
function nyParts(unixSeconds) {
  const parts = formatter.formatToParts(new Date(unixSeconds * 1000));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    // "24" appears at midnight in hour12:false; normalize it to 0.
    hour: Number(get('hour')) % 24,
    weekday: get('weekday'),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

const inWindow = (hour, { start, end }) => hour >= start && hour < end;

function windowFor(hour) {
  for (const [name, window] of Object.entries(WINDOWS)) {
    if (inWindow(hour, window)) return { name, ...window };
  }
  return null;
}

function analyze(bars, { now = null } = {}) {
  if (!bars.length) return null;

  const lastBar = bars[bars.length - 1];
  const reference = now ?? lastBar.time;
  const current = nyParts(reference);

  // Asian range for the most recent session present in the data. It spans
  // midnight ET, so bars from 20:00 onward belong to the *next* date's session.
  const asiaBars = [];
  let asiaDate = null;
  for (let i = bars.length - 1; i >= 0; i--) {
    const parts = nyParts(bars[i].time);
    if (!inWindow(parts.hour, WINDOWS.asia) && parts.hour >= 4) continue;
    const sessionDate = parts.hour >= WINDOWS.asia.start ? nextDate(parts.date) : parts.date;
    if (asiaDate === null) asiaDate = sessionDate;
    if (sessionDate !== asiaDate) break;
    if (parts.hour >= WINDOWS.asia.start || parts.hour < 4) asiaBars.push(bars[i]);
  }

  const asianRange = asiaBars.length
    ? {
        date: asiaDate,
        high: Math.max(...asiaBars.map((b) => b.high)),
        low: Math.min(...asiaBars.map((b) => b.low)),
        bars: asiaBars.length,
      }
    : null;
  if (asianRange) asianRange.size = asianRange.high - asianRange.low;

  const active = windowFor(current.hour);

  return {
    timezone: ZONE,
    nowHourEt: current.hour,
    weekday: current.weekday,
    activeSession: active ? active.name : 'outside_killzones',
    activeSessionLabel: active ? active.label : 'no killzone active',
    inKillzone: active ? active.name === 'london' || active.name === 'nyAm' : false,
    asianRange,
    windows: WINDOWS,
    // Mondays open with no prior-session context; Fridays close early.
    note: current.weekday === 'Sat' || current.weekday === 'Sun'
      ? 'weekend — FX is closed, levels are stale'
      : null,
  };
}

function nextDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

module.exports = { analyze, nyParts, WINDOWS, ZONE };
