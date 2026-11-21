// Regular term-time Tai Wai shuttle. Transcribed from EdUHK's timetable revised 9 November 2026.
export const EDUHK_TIMETABLE = 'https://www.eduhk.hk/eo/system/files/2026-11/TW%20Shuttle%20Schedule%2020261116%20%281%29.pdf';
export const EDUHK_TRANSPORT = 'https://www.eduhk.hk/eo/transportation';

const EFFECTIVE = '20261116';
const LAST_REGULAR_DATE = '20270630'; // The school publishes a separate limited summer service.
const HK_OFFSET = 8 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;

// Hong Kong general holidays for this timetable's coverage:
// https://www.1823.gov.hk/common/ical/en.json
const holidays = new Set([
  '20261225', '20261226', '20270101', '20270206', '20270208', '20270209',
  '20270326', '20270327', '20270329', '20270405', '20270501', '20270513', '20270609',
]);

// Approximate pins for the boarding areas named in the timetable.
const stops = {
  'eduhk-tai-wai-b': { name: { zh: '大圍站公共運輸交匯處（B出口）', en: 'Tai Wai Station PTI (Exit B)' }, location: { lat: 22.37286, lng: 114.18005 } },
  'eduhk-campus-b1b2': { name: { zh: '教大大埔校園 B1–B2 座避車處', en: 'EdUHK Tai Po Campus B1–B2 Layby' }, location: { lat: 22.46668, lng: 114.19358 } },
  'eduhk-tai-wai-eg': { name: { zh: '大圍積運街（港鐵 E／G 出口）', en: 'Chik Wan Street, Tai Wai (MTR Exit E/G)' }, location: { lat: 22.37218, lng: 114.17800 } },
};

const minutes = (hours) => Object.entries(hours).flatMap(([hour, times]) => times.map((minute) => Number(hour) * 60 + minute));

const timetable = {
  'eduhk-tai-wai-in': {
    stops: ['eduhk-tai-wai-b', 'eduhk-campus-b1b2'],
    minutes: minutes({ 7: [30, 45], 8: [0, 10, 20, 30, 45], 9: [0, 15, 30, 45], 10: [0, 10], 17: [30, 40, 50], 18: [0] }),
  },
  'eduhk-tai-wai-out': {
    stops: ['eduhk-campus-b1b2', 'eduhk-tai-wai-eg'],
    minutes: minutes({ 17: [10, 20, 25, 30, 35, 45], 18: [10, 20, 25, 30, 35, 45], 21: [0, 5, 10, 15, 20, 30, 40] }),
  },
};

const routes = Object.fromEntries(Object.entries(timetable).map(([key, direction]) => [key, {
  key, route: 'EdUHK Tai Wai', operators: ['eduhk'], serviceType: '1',
  orig: stops[direction.stops[0]].name, dest: stops[direction.stops[1]].name,
  stops: { eduhk: direction.stops }, bound: {},
  journeyMinutes: 35, // Planning allowance. The school publishes departure times, and road travel varies.
}]));

export const includesEdUHK = (journey) => journey.legs.some((leg) => leg.op === 'eduhk');

export function withEdUHKShuttle(db) {
  return { ...db, stops: { ...db.stops, ...stops }, routes: { ...db.routes, ...routes } };
}

/** The first published departure on the rider's Hong Kong calendar day. */
export function eduhkDeparture(routeKey, readyAt) {
  const direction = timetable[routeKey];
  if (!direction || !Number.isFinite(readyAt)) return null;
  const day = new Date(readyAt + HK_OFFSET);
  const weekday = day.getUTCDay();
  const date = day.toISOString().slice(0, 10).replaceAll('-', '');
  if (!weekday || weekday === 6 || date < EFFECTIVE || date > LAST_REGULAR_DATE || holidays.has(date)) return null;
  const midnight = Math.floor((readyAt + HK_OFFSET) / DAY) * DAY - HK_OFFSET;
  return direction.minutes.map((minute) => midnight + minute * 60_000).find((time) => time >= readyAt - 1) ?? null;
}
