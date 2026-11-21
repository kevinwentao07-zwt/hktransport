// Regular term-time EdUHK shuttles.
export const EDUHK_TIMETABLE = 'https://www.eduhk.hk/eo/system/files/2026-11/TW%20Shuttle%20Schedule%2020261116%20%281%29.pdf';
export const EDUHK_TRANSPORT = 'https://www.eduhk.hk/eo/transportation';
export const EDUHK_UNIVERSITY = 'https://www.eduhk.hk/eo/types-transport/university-station-shuttle-bus-services';

const LAST_REGULAR_DATE = '20270630'; // The school publishes a separate limited summer service.
const HK_OFFSET = 8 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;

// Hong Kong general holidays for this timetable's coverage:
// https://www.1823.gov.hk/common/ical/en.json
const holidays = new Set([
  '20261001', '20261019', '20261225', '20261226', '20270101', '20270206', '20270208', '20270209',
  '20270326', '20270327', '20270329', '20270405', '20270501', '20270513', '20270609',
]);

// Approximate pins for the boarding areas named in the timetable.
const stops = {
  'eduhk-tai-wai-b': { name: { zh: '大圍站公共運輸交匯處（B出口）', en: 'Tai Wai Station PTI (Exit B)' }, location: { lat: 22.37286, lng: 114.18005 } },
  'eduhk-campus-b1b2': { name: { zh: '教大大埔校園 B1–B2 座避車處', en: 'EdUHK Tai Po Campus B1–B2 Layby' }, location: { lat: 22.46668, lng: 114.19358 } },
  'eduhk-tai-wai-eg': { name: { zh: '大圍積運街（港鐵 E／G 出口）', en: 'Chik Wan Street, Tai Wai (MTR Exit E/G)' }, location: { lat: 22.37218, lng: 114.17800 } },
  'eduhk-university-b': { name: { zh: '港鐵大學站公共運輸交匯處（B出口）', en: 'University Station PTI (Exit B)' }, location: { lat: 22.41272, lng: 114.21079 } },
  'eduhk-campus-a': { name: { zh: '教大大埔校園 A 座入口廣場', en: 'EdUHK Tai Po Campus Block A Entrance Plaza' }, location: { lat: 22.46625, lng: 114.19368 } },
};

const minutes = (hours) => Object.entries(hours).flatMap(([hour, times]) => times.map((minute) => Number(hour) * 60 + minute));

const timetable = {
  'eduhk-tai-wai-in': {
    route: 'EdUHK Tai Wai', effective: '20261116', journeyMinutes: 35,
    stops: ['eduhk-tai-wai-b', 'eduhk-campus-b1b2'],
    weekdays: minutes({ 7: [30, 45], 8: [0, 10, 20, 30, 45], 9: [0, 15, 30, 45], 10: [0, 10], 17: [30, 40, 50], 18: [0] }),
  },
  'eduhk-tai-wai-out': {
    route: 'EdUHK Tai Wai', effective: '20261116', journeyMinutes: 35,
    stops: ['eduhk-campus-b1b2', 'eduhk-tai-wai-eg'],
    weekdays: minutes({ 17: [10, 20, 25, 30, 35, 45], 18: [10, 20, 25, 30, 35, 45], 21: [0, 5, 10, 15, 20, 30, 40] }),
  },
  // MyEdUHK inbound timetable effective 28 September 2026, supplied as a screenshot.
  // The crossed-out CUHK Medical Centre special trips are omitted.
  'eduhk-university-in': {
    route: 'EdUHK University', effective: '20260928', journeyMinutes: 20,
    stops: ['eduhk-university-b', 'eduhk-campus-a'],
    weekdays: minutes({
      7: [40, 45, 50, 55], 8: [0, 5, 10, 12, 15, 20, 22, 25, 30, 35, 40, 45, 50, 55],
      9: [0, 5, 10, 15, 20, 30, 40, 50, 55], 10: [0, 5, 10, 15, 20, 30, 40, 50],
      11: [0, 10, 20, 30, 40, 50], 12: [0, 5, 10, 15, 20, 30, 40, 50],
      13: [0, 10, 20, 30, 45], 14: [0, 15, 30, 45], 15: [0, 10, 20, 30, 40, 50],
      16: [0, 10, 20, 30, 40, 50], 17: [0, 10, 20, 30, 35, 40, 45, 50, 55],
      18: [0, 5, 10, 15, 20, 25, 30, 40, 50], 19: [0, 10, 20, 30, 45], 20: [0, 15, 30, 45],
      21: [0, 10, 20, 30, 40, 50], 22: [0, 15, 30, 45], 23: [0],
    }),
    // The first eligible Saturday is 3 October, when the additional trips begin.
    saturdays: minutes({
      8: [0, 10, 15, 20, 30, 40, 50], 9: [0, 5, 10, 15, 20, 30, 40, 50],
      10: [0, 15, 30, 45], 11: [0, 15, 30, 45], 12: [0, 10, 20, 30, 40, 50],
      13: [0, 10, 20, 30, 40, 50], 14: [0, 15, 30, 45], 15: [0, 15, 30, 45],
      16: [0, 10, 20, 30, 40, 50], 17: [0, 10, 20, 30, 40, 50], 18: [0, 10, 20, 30, 40, 50], 19: [0],
    }),
  },
};

const routes = Object.fromEntries(Object.entries(timetable).map(([key, direction]) => [key, {
  key, route: direction.route, operators: ['eduhk'], serviceType: '1',
  orig: stops[direction.stops[0]].name, dest: stops[direction.stops[1]].name,
  stops: { eduhk: direction.stops }, bound: {},
  journeyMinutes: direction.journeyMinutes, // Estimates, since road travel varies.
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
  if (!weekday || date < direction.effective || date > LAST_REGULAR_DATE || holidays.has(date)) return null;
  const departures = weekday === 6 ? direction.saturdays : direction.weekdays;
  if (!departures) return null;
  const midnight = Math.floor((readyAt + HK_OFFSET) / DAY) * DAY - HK_OFFSET;
  const minute = departures.find((value) => midnight + value * 60_000 >= readyAt - 1);
  return minute == null ? null : midnight + minute * 60_000;
}
