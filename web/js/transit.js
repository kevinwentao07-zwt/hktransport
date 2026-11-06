// Route data, the RAPTOR search and journey maths. No DOM, so it also runs in
// the worker and in Node tests. A port of RoutePlanner.swift and friends.

export const OPERATORS = ['kmb', 'ctb', 'nlb', 'gmb', 'lightRail', 'mtr'];

export const OP_COLORS = {
  kmb: '#e3242b', ctb: '#ffd100', nlb: '#1ca39c', gmb: '#3dad4a', lightRail: '#f29900', mtr: '#6e8cd6',
};
export const OP_LABELS = { kmb: 'KMB·LWB', ctb: 'CTB', nlb: 'NLB', gmb: 'GMB', lightRail: 'LRT', mtr: 'MTR' };

const MTR_LINES = {
  AEL: ['Airport Express', '機場快綫', '#00888a'], TCL: ['Tung Chung Line', '東涌綫', '#f7941d'],
  DRL: ['Disneyland Resort Line', '迪士尼綫', '#e868a2'], EAL: ['East Rail Line', '東鐵綫', '#53b7e8'],
  TML: ['Tuen Ma Line', '屯馬綫', '#ab4205'], TWL: ['Tsuen Wan Line', '荃灣綫', '#ed1d24'],
  KTL: ['Kwun Tong Line', '觀塘綫', '#00a040'], ISL: ['Island Line', '港島綫', '#007dc5'],
  TKL: ['Tseung Kwan O Line', '將軍澳綫', '#8b3d96'], SIL: ['South Island Line', '南港島綫', '#b5bd00'],
};

/** What riders call a route: "東鐵綫" rather than the MTR's "EAL". */
export function lineName(op, route, lang) {
  const line = op === 'mtr' ? MTR_LINES[route] : null;
  return line ? line[lang === 'zh' ? 1 : 0] : route;
}
export const lineColor = (op, route) => (op === 'mtr' && MTR_LINES[route]?.[2]) || OP_COLORS[op] || '#888';
export const RETURN_COLOR = '#7c4dff'; // Stands apart from every operator's colour.
export const nameText = (name, lang) => (lang === 'zh' ? name?.zh : name?.en) || name?.zh || name?.en || '';

// MARK: Tuning

export const SETTINGS = {
  walkMetersPerMinute: 75,
  walkDetour: 1.3, // Straight lines understate streets, footbridges and crossings.
  footpathRadius: 250,
  stationFootpathRadius: 450, // MTR coordinates are station centres.
  accessRadius: 700,
  fallbackAccessRadius: 1500,
  walkOnlyRadius: 1500,
  transferMinutes: 2,
  mtrInterchangeMinutes: 3,
  maxTransitLegs: 3,
  maxWaitMinutes: 90,
};
export const walkMinutes = (meters) => (meters * SETTINGS.walkDetour) / SETTINGS.walkMetersPerMinute;

const SPEED_KMH = { kmb: 17, ctb: 17, nlb: 20, gmb: 20, lightRail: 18, mtr: 38 };
const HEADWAY = { kmb: 15, ctb: 15, nlb: 20, gmb: 10, lightRail: 6, mtr: 4 };
const dwell = (op) => (op === 'mtr' ? 0.5 : 0.4);

export function meters(a, b) {
  const lat1 = (a.lat * Math.PI) / 180, lat2 = (b.lat * Math.PI) / 180;
  const x = (((b.lng - a.lng) * Math.PI) / 180) * Math.cos((lat1 + lat2) / 2);
  return 6371000 * Math.hypot(x, lat2 - lat1);
}
const validLocation = (l) => l && Number.isFinite(l.lat) && Number.isFinite(l.lng);

// MARK: Database

/** "0535" -> 335 */
export function minuteOfDay(text) {
  if (typeof text !== 'string' || !/^\d{4}$/.test(text)) return null;
  const value = Number(text), hours = Math.floor(value / 100), minutes = value % 100;
  return hours <= 47 && minutes <= 59 ? hours * 60 + minutes : null;
}

/** `{"287": {"0535": ["0705", "900"]}}`: every 900 s from 05:35 to 07:05. No headway is one departure. */
export function parseFrequency(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const days = {};
  for (const [day, bands] of Object.entries(raw)) {
    if (!bands || typeof bands !== 'object') continue;
    days[day] = Object.entries(bands).flatMap(([start, value]) => {
      const startMinute = minuteOfDay(start);
      if (startMinute == null) return [];
      const headway = Number(value?.[1]);
      return [{ start: startMinute, end: minuteOfDay(value?.[0]), headway: headway > 0 ? headway : null }];
    }).sort((a, b) => a.start - b.start);
  }
  return Object.keys(days).length ? days : null;
}

/** Keeps supported routes, and makes the loosely typed fields consistent. */
export function normalizeDB(raw) {
  const routes = {};
  for (const [key, route] of Object.entries(raw.routeList ?? {})) {
    const operators = (route.co ?? []).filter((op) => OPERATORS.includes(op) && route.stops?.[op]);
    if (!operators.length) continue;
    const jt = Number(route.jt);
    routes[key] = {
      key, route: String(route.route), operators, orig: route.orig, dest: route.dest,
      serviceType: String(route.serviceType ?? '1'), stops: route.stops, bound: route.bound ?? {},
      gtfsId: route.gtfsId == null ? null : String(route.gtfsId),
      nlbId: route.nlbId == null ? null : String(route.nlbId),
      journeyMinutes: jt > 0 ? jt : null, frequency: parseFrequency(route.freq),
    };
  }
  return { routes, stops: raw.stopList ?? {}, serviceDayMap: raw.serviceDayMap ?? {}, holidays: raw.holidays ?? [] };
}

const compare = (a, b) => a.localeCompare(b, 'en', { numeric: true });

/** Drops operator stop codes such as "(YT611)". */
export const cleanStopName = (name) => (name ?? '').replace(/\s*[(（][A-Za-z]{1,5}[0-9]{1,6}[A-Za-z0-9-]*[)）]\s*$/, '').trim();
export const stopName = (id, db, lang) => cleanStopName(nameText(db.stops[id]?.name, lang)) || id;

// MARK: Network

class SpatialGrid {
  static size = 0.005; // About 550 m.
  constructor(locations) {
    this.cells = new Map();
    locations.forEach((location, index) => {
      const key = this.key(this.cell(location.lat), this.cell(location.lng));
      if (!this.cells.has(key)) this.cells.set(key, []);
      this.cells.get(key).push(index);
    });
  }
  cell(value) { return Math.floor(value / SpatialGrid.size); }
  key(x, y) { return `${x}:${y}`; }
  near(location, radius, locations) {
    if (!validLocation(location) || radius <= 0) return [];
    const cx = this.cell(location.lat), cy = this.cell(location.lng), reach = Math.ceil(radius / 500);
    const found = [];
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        for (const stop of this.cells.get(this.key(cx + dx, cy + dy)) ?? []) {
          const distance = meters(location, locations[stop]);
          if (distance <= radius) found.push({ stop, meters: distance });
        }
      }
    }
    return found.sort((a, b) => a.meters - b.meters || a.stop - b.stop);
  }
}

export function buildNetwork(db) {
  const stopIDs = [], stopIndex = new Map(), locations = [], patterns = [];
  for (const key of Object.keys(db.routes).sort()) {
    const route = db.routes[key], op = route.operators[0], ids = route.stops[op];
    if (!ids || ids.length < 2) continue;
    const stopLocations = ids.map((id) => db.stops[id]?.location);
    if (!stopLocations.every(validLocation)) continue;

    const cumulative = [0];
    for (let i = 1; i < stopLocations.length; i++) {
      cumulative.push(cumulative[i - 1] + meters(stopLocations[i - 1], stopLocations[i]));
    }
    const total = cumulative.at(-1);
    // Spread the published journey time over the route by distance.
    const offsets = route.journeyMinutes && total > 0
      ? cumulative.map((m) => (route.journeyMinutes * m) / total)
      : cumulative.map((m, index) => (m / 1000 / SPEED_KMH[op]) * 60 + index * dwell(op));

    const indices = ids.map((id, position) => {
      if (!stopIndex.has(id)) {
        stopIndex.set(id, stopIDs.length);
        stopIDs.push(id);
        locations.push(stopLocations[position]);
      }
      return stopIndex.get(id);
    });
    patterns.push({
      routeKey: key, route: route.route, op, dest: route.dest, stops: indices, offsets,
      frequency: route.frequency, routeID: `${op}|${route.route}`,
    });
  }

  const patternsAtStop = stopIDs.map(() => []);
  const isStation = stopIDs.map(() => false);
  patterns.forEach((pattern, p) => {
    pattern.stops.forEach((stop, position) => {
      if (pattern.op === 'mtr') isStation[stop] = true;
      // Nobody boards at the last stop.
      if (position < pattern.stops.length - 1) patternsAtStop[stop].push({ pattern: p, position });
    });
  });

  const grid = new SpatialGrid(locations);
  const searchRadius = Math.max(SETTINGS.footpathRadius, SETTINGS.stationFootpathRadius);
  const footpaths = locations.map((location, stop) => grid.near(location, searchRadius, locations).flatMap((near) => {
    if (near.stop === stop) return [];
    const limit = isStation[stop] || isStation[near.stop] ? SETTINGS.stationFootpathRadius : SETTINGS.footpathRadius;
    return near.meters <= limit ? [{ to: near.stop, meters: near.meters }] : [];
  }));

  return {
    stopIDs, stopIndex, locations, isStation, patterns, patternsAtStop, footpaths, grid,
    serviceDayMap: db.serviceDayMap, holidays: new Set(db.holidays),
    near: (location, radius) => grid.near(location, radius, locations),
  };
}

// MARK: Service times

/** The departure expressed the way the timetable data is keyed: Hong Kong time, holidays as Sunday. */
export function serviceClock(date, holidays = new Set()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return {
    weekday: holidays.has(`${parts.year}${parts.month}${parts.day}`) ? 0 : weekday,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute) + Number(parts.second) / 60,
  };
}

function covers(t, start, end) {
  const s = start % 1440, e = end % 1440;
  return s <= e ? t >= s && t < e : t >= s || t < e; // Bands such as 23:40 -> 01:00 cross midnight.
}

/** Expected wait from timetable bands, or null when nothing runs soon. */
export function waitFromBands(bands, t, maxWait) {
  let nextStart = Infinity;
  for (const band of bands) {
    if (band.headway && band.end != null && covers(t, band.start, band.end)) return band.headway / 60 / 2;
    let delta = band.start - t;
    if (delta < 0) delta += 1440;
    nextStart = Math.min(nextStart, delta);
  }
  return nextStart <= maxWait ? nextStart : null;
}

class WaitEstimator {
  constructor(network, clock) {
    this.network = network;
    this.clock = clock;
    this.cache = new Map();
  }
  wait(p, position, minutesAfterDeparture) {
    const pattern = this.network.patterns[p];
    if (!pattern.frequency) return HEADWAY[pattern.op] / 2;
    let t = (this.clock.minuteOfDay + minutesAfterDeparture - pattern.offsets[position]) % 1440;
    if (t < 0) t += 1440;
    return waitFromBands(this.bands(p), t, SETTINGS.maxWaitMinutes);
  }
  bands(p) {
    if (this.cache.has(p)) return this.cache.get(p);
    const bands = Object.entries(this.network.patterns[p].frequency).flatMap(([day, list]) => {
      const flags = this.network.serviceDayMap[day];
      // Unknown service-day ids are assumed to run.
      return !flags || flags[this.clock.weekday] === '1' || flags[this.clock.weekday] === 1 ? list : [];
    });
    this.cache.set(p, bands);
    return bands;
  }
}

// MARK: Journeys

export const rides = (journey) => journey.legs.filter((leg) => leg.type === 'ride');
export const totalMinutes = (journey) => journey.legs.reduce((total, leg) => total
  + (leg.type === 'walk' ? leg.minutes : leg.transferMinutes + leg.waitMinutes + leg.rideMinutes), 0);
export const walkingMeters = (journey) => journey.legs.reduce((total, leg) => total + (leg.type === 'walk' ? leg.meters : 0), 0);
const walkingMinutes = (journey) => journey.legs.reduce((total, leg) => total + (leg.type === 'walk' ? leg.minutes : 0), 0);
export const transfers = (journey) => Math.max(0, rides(journey).length - 1);
export const journeyID = (journey) => rides(journey).map((r) => `${r.op}|${r.route}@${r.boardStopID}>${r.alightStopID}`).join(',') || 'walk';

/** Lower is better. Weights are in "minutes the rider would trade". */
export function score(journey, preference) {
  const minutes = totalMinutes(journey), changes = transfers(journey);
  if (preference === 'fewerTransfers') return minutes + changes * 12;
  if (preference === 'lessWalking') return minutes + walkingMinutes(journey) * 1.5 + changes * 3;
  return minutes + changes * 2;
}

export function rank(journeys, preference, limit) {
  // One option per first vehicle: "EAL then walk" and "EAL then ISL" are the same decision.
  const seen = new Set();
  const unique = [...journeys].sort((a, b) => score(a, preference) - score(b, preference)).filter((journey) => {
    const first = rides(journey)[0];
    const key = first ? `${first.op}|${first.route}` : 'walk';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!unique.length) return [];
  const best = score(unique[0], preference);
  return unique.filter((journey) => score(journey, preference) <= best + 20).slice(0, limit);
}

/** Round-based transit routing (RAPTOR): round k finds the fastest way to every stop using k vehicles. */
export function search(network, origin, destination, departure, bannedFirstRoutes = new Set()) {
  let access = network.near(origin, SETTINGS.accessRadius);
  if (!access.length) access = network.near(origin, SETTINGS.fallbackAccessRadius);
  let egressList = network.near(destination, SETTINGS.accessRadius);
  if (!egressList.length) egressList = network.near(destination, SETTINGS.fallbackAccessRadius);
  if (!access.length || !egressList.length) return [];

  const n = network.stopIDs.length, rounds = Math.max(1, SETTINGS.maxTransitLegs);
  const estimator = new WaitEstimator(network, serviceClock(new Date(departure), network.holidays));
  const layer = (value) => Array.from({ length: rounds + 1 }, () => new Array(n).fill(value));
  const arrival = layer(Infinity), rideArrival = layer(Infinity), rideParent = layer(null), walkParent = layer(null);
  const best = new Array(n).fill(Infinity);
  const accessMeters = new Map();
  let marked = [];

  for (const { stop, meters: distance } of access) {
    const minutes = walkMinutes(distance);
    if (minutes >= arrival[0][stop]) continue;
    arrival[0][stop] = minutes;
    best[stop] = minutes;
    accessMeters.set(stop, distance);
    marked.push(stop);
  }
  const egress = new Map();
  for (const { stop, meters: distance } of egressList) egress.set(stop, Math.min(distance, egress.get(stop) ?? Infinity));

  const interchange = (round, stop, next) => {
    const ride = rideParent[round][stop];
    return !walkParent[round][stop] && ride && network.patterns[ride.pattern].op === 'mtr' && next.op === 'mtr'
      ? SETTINGS.mtrInterchangeMinutes : SETTINGS.transferMinutes;
  };

  const journeys = [];
  for (let k = 1; k <= rounds && marked.length; k++) {
    // Each pattern is scanned once, from its earliest marked stop.
    const queue = new Map();
    for (const stop of new Set(marked)) {
      for (const visit of network.patternsAtStop[stop]) {
        if (k === 1 && bannedFirstRoutes.has(network.patterns[visit.pattern].routeID)) continue;
        const existing = queue.get(visit.pattern);
        if (existing === undefined || visit.position < existing) queue.set(visit.pattern, visit.position);
      }
    }

    const improved = [];
    for (const [p, start] of [...queue].sort((a, b) => a[0] - b[0])) {
      const pattern = network.patterns[p];
      let base = Infinity, boardPosition = -1, boardTransfer = 0, boardWait = 0;
      for (let i = start; i < pattern.stops.length; i++) {
        const stop = pattern.stops[i];
        if (boardPosition >= 0) {
          const time = base + pattern.offsets[i];
          if (time < best[stop]) {
            best[stop] = time;
            arrival[k][stop] = time;
            rideArrival[k][stop] = time;
            rideParent[k][stop] = { pattern: p, board: boardPosition, alight: i, transfer: boardTransfer, wait: boardWait };
            walkParent[k][stop] = null;
            improved.push(stop);
          }
        }
        if (i >= pattern.stops.length - 1 || arrival[k - 1][stop] === Infinity) continue;
        const previous = arrival[k - 1][stop];
        const transfer = k === 1 ? 0 : interchange(k - 1, stop, pattern);
        const wait = estimator.wait(p, i, previous + transfer);
        if (wait == null) continue;
        const candidate = previous + transfer + wait - pattern.offsets[i];
        if (candidate < base) {
          base = candidate;
          boardPosition = i;
          boardTransfer = transfer;
          boardWait = wait;
        }
      }
    }

    // Walking interchanges always start from a vehicle, never chain walks.
    const walked = [];
    for (const stop of improved) {
      const from = rideArrival[k][stop];
      for (const path of network.footpaths[stop]) {
        const time = from + walkMinutes(path.meters);
        if (time < best[path.to]) {
          best[path.to] = time;
          arrival[k][path.to] = time;
          walkParent[k][path.to] = { from: stop, meters: path.meters };
          walked.push(path.to);
        }
      }
    }
    marked = [...improved, ...walked];

    let bestEnd = Infinity, endStop = -1;
    for (const [stop, distance] of egress) {
      if (arrival[k][stop] === Infinity) continue;
      const time = arrival[k][stop] + walkMinutes(distance);
      if (time < bestEnd || (time === bestEnd && stop < endStop)) {
        bestEnd = time;
        endStop = stop;
      }
    }
    const previousBest = journeys.length ? totalMinutes(journeys.at(-1)) : Infinity;
    if (endStop < 0 || bestEnd >= previousBest - 0.5) continue;
    const journey = reconstruct(network, k, endStop, egress.get(endStop) ?? 0, accessMeters, departure, rideParent, walkParent);
    if (journey) journeys.push(journey);
  }
  return journeys;
}

function reconstruct(network, round, endStop, egressMeters, accessMeters, departure, rideParent, walkParent) {
  const legs = [{ type: 'walk', meters: egressMeters, minutes: walkMinutes(egressMeters), to: null }];
  let stop = endStop;
  for (let k = round; k > 0; k--) {
    const walk = walkParent[k][stop];
    if (walk) {
      legs.push({ type: 'walk', meters: walk.meters, minutes: walkMinutes(walk.meters), to: network.stopIDs[stop] });
      stop = walk.from;
    }
    const step = rideParent[k][stop];
    if (!step) return null;
    const pattern = network.patterns[step.pattern];
    legs.push({
      type: 'ride', routeKey: pattern.routeKey, route: pattern.route, op: pattern.op, dest: pattern.dest,
      boardPosition: step.board, alightPosition: step.alight,
      boardStopID: network.stopIDs[pattern.stops[step.board]], alightStopID: network.stopIDs[pattern.stops[step.alight]],
      transferMinutes: step.transfer, waitMinutes: step.wait,
      rideMinutes: pattern.offsets[step.alight] - pattern.offsets[step.board],
      liveDeparture: null, isProjected: false, livePlatform: null,
    });
    stop = pattern.stops[step.board];
  }
  if (!accessMeters.has(stop)) return null;
  const distance = accessMeters.get(stop);
  legs.push({ type: 'walk', meters: distance, minutes: walkMinutes(distance), to: network.stopIDs[stop] });
  // Drop zero-length walks, e.g. when the origin is exactly at a stop.
  return { legs: legs.reverse().filter((leg) => leg.type !== 'walk' || leg.meters >= 1), departure };
}

/** Several searches, each banning the first route of earlier answers, so options really differ. */
export function plan(network, origin, destination, departure, preference = 'fastest', limit = 5) {
  const found = [], banned = new Set();
  for (let i = 0; i < 4; i++) {
    const journeys = search(network, origin, destination, departure, banned);
    if (!journeys.length) break;
    found.push(...journeys);
    for (const journey of journeys) {
      const first = rides(journey)[0];
      if (first) banned.add(`${first.op}|${first.route}`);
    }
  }
  const direct = meters(origin, destination);
  if (direct <= SETTINGS.walkOnlyRadius) {
    found.push({ legs: [{ type: 'walk', meters: direct, minutes: walkMinutes(direct), to: null }], departure });
  }
  return rank(found, preference, limit);
}

// MARK: Live ETAs

export const MAX_PROJECTION_MINUTES = 60;

/**
 * The first departure the rider can catch. Rail feeds stop after about four
 * trains, so later legs continue the live headway instead of guessing.
 * `live` is [{date (ms), platform}].
 */
export function nextDeparture(live, atStop, projecting) {
  const sorted = [...live].sort((a, b) => a.date - b.date);
  // A bus "due now" is still catchable if we are a few seconds late.
  const next = sorted.find((departure) => departure.date >= atStop - 30_000);
  if (next) return { departure: next, isProjected: false };
  if (!projecting || sorted.length < 2) return null;
  const first = sorted[0], last = sorted.at(-1);
  const headway = (last.date - first.date) / (sorted.length - 1);
  if (headway <= 0) return null;
  const trains = Math.ceil((atStop - last.date) / headway);
  if (trains * headway > MAX_PROJECTION_MINUTES * 60_000) return null;
  return { departure: { date: last.date + trains * headway, platform: last.platform }, isProjected: true };
}

/** Re-times a journey with live arrivals; `arrivals(ride)` resolves to departures or null. */
export async function retime(journey, arrivals) {
  let clock = journey.departure;
  const legs = [];
  for (const leg of journey.legs) {
    if (leg.type === 'walk') {
      clock += leg.minutes * 60_000;
      legs.push(leg);
      continue;
    }
    const ride = { ...leg };
    const atStop = clock + ride.transferMinutes * 60_000;
    const live = await arrivals(ride);
    const next = live ? nextDeparture(live, atStop, ride.op === 'mtr' || ride.op === 'lightRail') : null;
    if (next) {
      ride.waitMinutes = Math.max(0, (next.departure.date - atStop) / 60_000);
      ride.liveDeparture = next.departure.date;
      ride.isProjected = next.isProjected;
      ride.livePlatform = next.departure.platform ?? null;
    } else {
      ride.liveDeparture = null;
      ride.isProjected = false;
      ride.livePlatform = null;
    }
    clock = atStop + (ride.waitMinutes + ride.rideMinutes) * 60_000;
    legs.push(ride);
  }
  return { legs, departure: journey.departure };
}

/** False for a train that ends before the rider's stop or takes the other branch. */
export function trainServes(terminus, ride, db) {
  if (ride.op !== 'mtr') return true;
  let isKnown = false;
  for (const route of Object.values(db.routes)) {
    if (route.route !== ride.route) continue;
    const ids = route.stops.mtr;
    const end = ids?.findIndex((id) => { const n = db.stops[id]?.name; return n && n.zh === terminus?.zh && n.en === terminus?.en; }) ?? -1;
    if (end < 0) continue;
    isKnown = true;
    const board = ids.indexOf(ride.boardStopID), alight = ids.indexOf(ride.alightStopID);
    if (board >= 0 && alight >= 0 && board < alight && alight <= end) return true;
  }
  return !isKnown; // An unknown terminus is no reason to drop a train.
}

// MARK: Journey path

/** Every stop the rider passes, from boarding to alighting. */
/** The closest point on one stretch of a line, with which way it runs. */
function pointOnStretch(line, index, location) {
  const scale = Math.cos((location.lat * Math.PI) / 180), a = line[index], b = line[index + 1];
  const east = (b.lng - a.lng) * scale, north = b.lat - a.lat, length = east * east + north * north;
  const part = length ? Math.max(0, Math.min(1, (((location.lng - a.lng) * scale * east) + ((location.lat - a.lat) * north)) / length)) : 0;
  const point = { lat: a.lat + (b.lat - a.lat) * part, lng: a.lng + (b.lng - a.lng) * part };
  return { index, location: point, meters: meters(point, location), heading: (Math.atan2(east, north) * 180) / Math.PI };
}

const MOST_METERS_OFF_LINE = 300, EVEN_PROGRESS_METERS = 60;

/**
 * Finds the best place on the line for every stop at once, always moving forward. Stops are only metres
 * from the opposite carriageway, so taking each one's nearest or first match would put return stops on
 * the way out. Near-ties lean toward even progress, for routes drawn along the same road both ways.
 */
function alignStops(line, along, stops) {
  const count = line.length - 1, total = along.at(-1) || 1, cameFrom = [];
  let previous = new Float64Array(count);
  stops.forEach(({ location, share }) => {
    const costs = new Float64Array(count), from = new Int32Array(count);
    let cheapest = Infinity, cheapestAt = 0;
    for (let index = 0; index < count; index++) {
      if (previous[index] < cheapest) {
        cheapest = previous[index];
        cheapestAt = index;
      }
      const away = Math.min(pointOnStretch(line, index, location).meters, MOST_METERS_OFF_LINE);
      costs[index] = cheapest + away + EVEN_PROGRESS_METERS * Math.abs(along[index] / total - share);
      from[index] = cheapestAt;
    }
    previous = costs;
    cameFrom.push(from);
  });
  let index = previous.indexOf(Math.min(...previous));
  const placed = new Array(stops.length);
  for (let stop = stops.length - 1; stop >= 0; stop--) {
    placed[stop] = index;
    index = cameFrom[stop][index];
  }
  return placed;
}

/**
 * A route's line with every stop placed along it, in order. A route can use a road twice, as circular
 * and out-and-back routes do, so places are found by progress along the line, never by what is nearest.
 */
export function routeTrack(line, stops) {
  if (!line || line.length < 2) return null;
  const along = [0];
  for (let index = 1; index < line.length; index++) along[index] = along[index - 1] + meters(line[index - 1], line[index]);
  const known = stops.flatMap((location, index) => (validLocation(location) ? [{ location, index, share: index / Math.max(1, stops.length - 1) }] : []));
  if (known.length < 2) return null;
  const passes = new Array(stops.length).fill(null);
  let reached = 0;
  alignStops(line, along, known).forEach((stretch, order) => {
    const { location, index } = known[order], pass = pointOnStretch(line, stretch, location);
    if (pass.meters > MOST_METERS_OFF_LINE) return;
    // Two stops can share a stretch, and a bus still only goes forward.
    reached = Math.max(reached, along[stretch] + meters(line[stretch], pass.location));
    passes[index] = { location: pass.location, at: reached };
  });
  return passes.filter(Boolean).length >= 2 ? { line, along, passes } : null;
}

/** How far along the line a fractional stop number is, between the stops that were placed. */
function distanceAt(track, position) {
  const { passes } = track;
  let before = Math.min(Math.floor(position), passes.length - 1), after = before + 1;
  while (before >= 0 && !passes[before]) before -= 1;
  while (after < passes.length && !passes[after]) after += 1;
  if (before < 0) return passes[after].at;
  if (after >= passes.length) return passes[before].at;
  return passes[before].at + ((passes[after].at - passes[before].at) * (position - before)) / (after - before);
}

function stretchAt(track, distance) {
  let low = 0, high = track.line.length - 2;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (track.along[middle] <= distance) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Where a fractional stop number is on the road, and which way the road runs there. */
export function placeOnTrack(track, position) {
  const distance = distanceAt(track, position), index = stretchAt(track, distance);
  const a = track.line[index], b = track.line[index + 1], length = track.along[index + 1] - track.along[index];
  const part = length ? Math.max(0, Math.min(1, (distance - track.along[index]) / length)) : 0;
  const east = (b.lng - a.lng) * Math.cos((a.lat * Math.PI) / 180), north = b.lat - a.lat;
  return {
    location: { lat: a.lat + (b.lat - a.lat) * part, lng: a.lng + (b.lng - a.lng) * part },
    heading: (Math.atan2(east, north) * 180) / Math.PI,
  };
}

/** The road between two fractional stop numbers. */
export function trackBetween(track, from, to) {
  const start = stretchAt(track, distanceAt(track, from)), end = stretchAt(track, distanceAt(track, to));
  return [placeOnTrack(track, from).location, ...track.line.slice(start + 1, end + 1), placeOnTrack(track, to).location];
}

const SECONDS_PER_STOP = 90;

/** A fractional stop number as a place on the map. */
function placeOnStops(stops, position, db) {
  const index = Math.min(Math.floor(position), stops.length - 2), part = position - index;
  const from = db.stops[stops[index]]?.location, to = db.stops[stops[index + 1]]?.location;
  if (!validLocation(from) || !validLocation(to)) return null;
  const east = (to.lng - from.lng) * Math.cos((from.lat * Math.PI) / 180), north = to.lat - from.lat;
  return {
    location: { lat: from.lat + (to.lat - from.lat) * part, lng: from.lng + (to.lng - from.lng) * part },
    heading: (Math.atan2(east, north) * 180) / Math.PI,
  };
}

const LOOP_CLOSES_WITHIN = 300;

/**
 * Where a circular route turns for home: the position of the stop it is signed for,
 * or else of its farthest stop. Null for a route that does not come back to its start.
 */
export function circularTurn(route, op, db) {
  const ids = route.stops[op] ?? [], places = ids.map((id) => db.stops[id]?.location);
  if (ids.length < 3 || op === 'mtr' || !places[0] || !places.at(-1)) return null;
  const isSigned = /循環|circular/i.test(`${route.dest?.zh} ${route.dest?.en}`);
  if (!isSigned && (ids.length < 4 || meters(places[0], places.at(-1)) > LOOP_CLOSES_WITHIN)) return null;
  const away = places.map((place) => (place ? meters(places[0], place) : 0));
  const farthest = away.indexOf(Math.max(...away));
  const signed = cleanStopName(route.dest?.zh ?? '').replace(/\s*[(（]循環線[)）]\s*/, '').trim();
  // A terminus can share its name with a stop beside the start, which is no turning point.
  const named = signed ? ids.flatMap((id, position) => (
    position && position < ids.length - 1 && away[position] >= away[farthest] / 2 && db.stops[id]?.name?.zh?.includes(signed) ? [position] : [])) : [];
  const turn = named.sort((a, b) => Math.abs(a - farthest) - Math.abs(b - farthest))[0] ?? farthest;
  return turn > 0 && turn < ids.length - 1 ? turn : null;
}

function secondsPerStop(route, stops) {
  return route.journeyMinutes ? (route.journeyMinutes * 60) / (stops.length - 1) : SECONDS_PER_STOP;
}

const SAME_GAP_MS = 20_000, LONGEST_GAP_MS = 20 * 60_000, MOST_STOPS_MISSED = 2;

/**
 * How long each stop to the next takes. The operator's times for different buses agree on it
 * to the second, so the gap most pairs of times share is the true one.
 */
function stopGaps(byStop, fallback) {
  return byStop.slice(0, -1).map((here, position) => {
    const gaps = here.flatMap(({ time }) => byStop[position + 1].map((next) => next.time - time))
      .filter((gap) => gap > 0 && gap < LONGEST_GAP_MS);
    const sharing = gaps.map((gap) => gaps.filter((other) => Math.abs(other - gap) <= SAME_GAP_MS));
    const most = Math.max(0, ...sharing.map((group) => group.length));
    const best = sharing.filter((group) => group.length === most)
      .sort((a, b) => Math.abs(a[0] - fallback) - Math.abs(b[0] - fallback))[0];
    return best ? best.reduce((sum, gap) => sum + gap, 0) / best.length : fallback;
  });
}

/**
 * Links the times at every stop into one timetable per bus: each continues as the next stop's time
 * it predicts. A time too far off to be a bus that has just passed the stop before is a bus still
 * behind it, so one the operator has timed unevenly: it joins the nearest bus not yet linked.
 */
function busTimetables(byStop, gaps, now) {
  const buses = [];
  let open = [];
  byStop.forEach((entries, position) => {
    const tolerance = Math.max(45_000, (gaps[position - 1] ?? 0) * 0.3);
    const fits = open.flatMap((bus) => entries.map((entry) => ({ bus, entry, miss: Math.abs(entry.time - bus.expected) })))
      .filter(({ miss }) => miss <= tolerance).sort((a, b) => a.miss - b.miss);
    const linked = new Map(), used = new Set();
    for (const { bus, entry } of fits) {
      if (linked.has(bus) || used.has(entry)) continue;
      linked.set(bus, entry);
      used.add(entry);
    }
    for (const entry of entries) {
      if (used.has(entry) || !position || entry.time - now <= gaps[position - 1]) continue;
      const bus = open.filter((candidate) => !linked.has(candidate))
        .sort((a, b) => Math.abs(entry.time - a.expected) - Math.abs(entry.time - b.expected))[0];
      if (!bus) continue;
      linked.set(bus, entry);
      used.add(entry);
    }
    const started = entries.filter((entry) => !used.has(entry)).map((entry) => {
      const bus = { stops: [], expected: 0, missed: 0 };
      linked.set(bus, entry);
      buses.push(bus);
      return bus;
    });
    open = [...open, ...started].filter((bus) => {
      const entry = linked.get(bus), gap = gaps[position] ?? 0;
      if (entry) {
        bus.stops.push({ position, ...entry });
        bus.expected = entry.time + gap;
        bus.missed = 0;
        return true;
      }
      bus.expected += gap;
      return ++bus.missed <= MOST_STOPS_MISSED;
    });
  });
  return buses;
}

/** Where a bus is at `now`: between the stops its times fall between. Null when off the route. */
function positionOf(stops, gaps, now) {
  const next = stops.findIndex(({ time }) => time > now);
  if (next < 0) return null;
  const after = stops[next], before = stops[next - 1];
  if (before) return before.position + ((after.position - before.position) * (now - before.time)) / (after.time - before.time);
  // No stop before this one lists it, so go back along the route by the time it still needs.
  let position = after.position, left = after.time - now;
  while (position > 0 && left >= gaps[position - 1]) left -= gaps[--position];
  if (position === 0) return null; // Not yet set off.
  return position - left / gaps[position - 1];
}

/** When a bus reaches a stop: its own time there, or else counted on from its nearest stop. */
function arrivalAt(stops, position, gaps) {
  const anchor = stops.findLast((stop) => stop.position <= position) ?? stops[0];
  const between = gaps.slice(Math.min(anchor.position, position), Math.max(anchor.position, position)).reduce((sum, gap) => sum + gap, 0);
  return { arrival: anchor.time + (anchor.position <= position ? between : -between), isLive: anchor.position === position };
}

/**
 * Every bus on a route. There is no public bus tracking, but the arrivals at all the stops together
 * give each bus's timetable, and that says where it is now. Times for buses that are only
 * timetabled are not followed. `arrivals` is [{position, times, planned}]; `boardPosition`, if any,
 * is where the rider gets on, and the bus that reaches it first is the next one.
 */
export function vehiclesOnRoute(arrivals, ride, db, now) {
  const route = db.routes[ride.routeKey], stops = route?.stops[ride.op];
  if (!stops || stops.length < 2) return [];
  const byStop = stops.map(() => []);
  for (const { position, times = [], planned = [] } of arrivals) {
    if (!byStop[position]) continue;
    byStop[position] = [...times.map((time) => ({ time, isPlanned: false })), ...planned.map((time) => ({ time, isPlanned: true }))].sort((a, b) => a.time - b.time);
  }
  const gaps = stopGaps(byStop, secondsPerStop(route, stops) * 1000);
  const board = ride.boardPosition ?? null;
  const vehicles = busTimetables(byStop, gaps, now).flatMap((bus) => {
    if (bus.stops.every((stop) => stop.isPlanned)) return [];
    const position = positionOf(bus.stops, gaps, now);
    const place = position == null ? null : placeOnStops(stops, position, db);
    if (!place) return [];
    const due = board != null && position < board ? arrivalAt(bus.stops, board, gaps) : { arrival: null, isLive: false };
    return [{ ...place, position, ...due, minutes: due.arrival == null ? null : Math.max(0, Math.floor((due.arrival - now) / 60_000)), color: lineColor(ride.op, ride.route), isMinibus: ride.op === 'gmb', isNext: false }];
  });
  const coming = vehicles.filter((vehicle) => vehicle.arrival != null).sort((a, b) => a.arrival - b.arrival)[0];
  if (coming) coming.isNext = true;
  return vehicles.sort((a, b) => b.position - a.position);
}

export function rideStopIDs(ride, db) {
  const all = db.routes[ride.routeKey]?.stops[ride.op];
  return all && ride.boardPosition <= ride.alightPosition && ride.alightPosition < all.length
    ? all.slice(ride.boardPosition, ride.alightPosition + 1) : [ride.boardStopID, ride.alightStopID];
}

export function journeyPath(journey, origin, destination, db) {
  let cursor = origin;
  const segments = [];
  for (const leg of journey.legs) {
    let segment;
    if (leg.type === 'walk') {
      const target = leg.to ? db.stops[leg.to]?.location : destination;
      if (!target) continue;
      segment = { mode: 'walk', points: [cursor, target], stopIDs: [] };
    } else {
      const ids = rideStopIDs(leg, db), isWhole = ids.length === leg.alightPosition - leg.boardPosition + 1;
      const onRoute = ids.map((id, index) => [id, isWhole ? leg.boardPosition + index : index ? leg.alightPosition : leg.boardPosition])
        .filter(([id]) => validLocation(db.stops[id]?.location));
      const stops = onRoute.map(([id]) => id);
      segment = { mode: 'ride', route: leg.route, routeKey: leg.routeKey, op: leg.op, points: stops.map((id) => db.stops[id].location), stopIDs: stops, positions: onRoute.map(([, position]) => position) };
    }
    if (!segment.points.length) continue;
    segments.push(segment);
    cursor = segment.points.at(-1);
  }
  return { origin, destination, segments };
}

function pathEdges(path) {
  return path.segments.flatMap((segment, index) => segment.points.slice(1).map((to, offset) => ({
    segment: index, toPoint: offset + 1, from: segment.points[offset], to,
  })));
}

function metersToEdge(here, edge) {
  const scale = Math.cos((here.lat * Math.PI) / 180);
  const x = (edge.to.lng - edge.from.lng) * scale, y = edge.to.lat - edge.from.lat;
  const px = (here.lng - edge.from.lng) * scale, py = here.lat - edge.from.lat;
  const length = x * x + y * y;
  const t = length > 0 ? Math.min(1, Math.max(0, (px * x + py * y) / length)) : 0;
  return meters(here, { lat: edge.from.lat + t * y, lng: edge.from.lng + t * (edge.to.lng - edge.from.lng) });
}

/** Where the rider is along a journey. `previous` stops a noisy fix from undoing progress. */
export function progressAt(path, here, accuracy = 0, previous = null) {
  const edges = pathEdges(path), first = previous?.edge ?? 0;
  if (first >= edges.length) return null;
  let best = first, bestMeters = Infinity;
  for (let i = first; i < edges.length; i++) {
    const distance = metersToEdge(here, edges[i]);
    if (distance < bestMeters) {
      best = i;
      bestMeters = distance;
    }
  }
  const hasArrived = meters(here, path.destination) <= Math.max(50, Math.min(accuracy, 100));
  const isOffRoute = !hasArrived && bestMeters > Math.max(200, accuracy);
  // Off the route the nearest edge means nothing, so stay where we were.
  const index = isOffRoute ? first : best, edge = edges[index];
  const stops = path.segments[edge.segment].stopIDs;
  const nextStop = stops.length
    ? Math.min(edge.toPoint + (meters(here, edge.to) <= 40 ? 1 : 0), stops.length - 1) : null;
  return { edge: index, segment: edge.segment, nextStop, metersFromRoute: bestMeters, isOffRoute, hasArrived };
}

/** One line telling the rider what to do now. */
export function instruction(path, progress, lang, name) {
  const t = (zh, en) => (lang === 'zh' ? zh : en);
  if (progress.hasArrived) return t('已到達目的地', 'You have arrived');
  if (progress.isOffRoute) {
    const distance = Math.round(progress.metersFromRoute);
    return t(`你目前不在路線上（相距約 ${distance} 米）`, `You're off the route (about ${distance} m away)`);
  }
  const segment = path.segments[progress.segment];
  if (segment.mode !== 'ride' || progress.nextStop == null) {
    const nextRide = path.segments.slice(progress.segment + 1).find((s) => s.stopIDs.length);
    const target = nextRide ? name(nextRide.stopIDs[0]) : t('目的地', 'your destination');
    return t(`步行前往 ${target}`, `Walk to ${target}`);
  }
  const stop = name(segment.stopIDs[progress.nextStop]);
  const left = segment.stopIDs.length - progress.nextStop;
  if (left <= 1) return t(`下一站 ${stop} 下車`, `Get off at the next stop, ${stop}`);
  const line = lineName(segment.op, segment.route, lang), alight = name(segment.stopIDs.at(-1));
  return t(`${line} · 下一站 ${stop} · 還有 ${left} 站到 ${alight} 下車`, `${line} · Next: ${stop} · ${left} stops to ${alight}`);
}

// MARK: Stop index

const clusterKey = (name) => name.zh || name.en?.toLowerCase() || '';
const visitOrder = (db) => (a, b) => {
  const ra = db.routes[a.routeKey], rb = db.routes[b.routeKey];
  return compare(ra.route, rb.route) || ra.serviceType.localeCompare(rb.serviceType) || a.seq - b.seq;
};

/** Every stop that can be boarded at, with same-named platforms within 100 m merged. */
export function buildStopIndex(db) {
  const visits = new Map();
  for (const route of Object.values(db.routes)) {
    for (const op of route.operators) {
      const ids = route.stops[op];
      // The final stop has no onward arrival to board.
      for (let seq = 0; seq < ids.length - 1; seq++) {
        if (!validLocation(db.stops[ids[seq]]?.location)) continue;
        if (!visits.has(ids[seq])) visits.set(ids[seq], []);
        visits.get(ids[seq]).push({ routeKey: route.key, seq, op });
      }
    }
  }
  const groups = new Map();
  for (const id of [...visits.keys()].sort()) {
    const stop = db.stops[id];
    const name = { zh: cleanStopName(stop.name?.zh), en: cleanStopName(stop.name?.en) };
    const platform = { id, name, location: stop.location, visits: visits.get(id) };
    const candidates = groups.get(clusterKey(name)) ?? [];
    const group = candidates.find((g) => g.every((p) => meters(p.location, platform.location) <= 100));
    if (group) group.push(platform);
    else candidates.push([platform]);
    groups.set(clusterKey(name), candidates);
  }
  return [...groups.values()].flat().map((platforms) => ({
    id: platforms[0].id, name: platforms[0].name,
    location: {
      lat: platforms.reduce((sum, p) => sum + p.location.lat, 0) / platforms.length,
      lng: platforms.reduce((sum, p) => sum + p.location.lng, 0) / platforms.length,
    },
    platforms: platforms.map((p) => p.location),
    visits: platforms.flatMap((p) => p.visits).sort(visitOrder(db)),
  }));
}

export const MODES = {
  all: () => true,
  bus: (visit) => ['kmb', 'ctb', 'nlb'].includes(visit.op),
  minibus: (visit) => visit.op === 'gmb',
  mtr: (visit) => visit.op === 'mtr',
  lightRail: (visit) => visit.op === 'lightRail',
};
export const siteHasMode = (site, mode) => site.visits.some(MODES[mode]);
export const primaryMode = (site) => ['mtr', 'lightRail', 'bus', 'minibus'].find((mode) => siteHasMode(site, mode)) ?? 'bus';

export function stopsNear(index, location, radius) {
  return index.flatMap((site) => {
    // Rank a station by its nearest boarding platform, not its centroid.
    const distance = Math.min(...site.platforms.map((p) => meters(location, p)));
    return distance <= radius ? [{ site, distance }] : [];
  }).sort((a, b) => a.distance - b.distance || a.site.id.localeCompare(b.site.id));
}

export const normalizePlace = (text) => {
  let value = text.toLowerCase().trim();
  for (const suffix of ['港鐵站', '站', ' station', ' mtr']) {
    if (value.endsWith(suffix) && value.length > suffix.length) {
      value = value.slice(0, -suffix.length);
      break;
    }
  }
  return value.trim();
};

const siteRank = (site) => (siteHasMode(site, 'mtr') ? 100000 : siteHasMode(site, 'lightRail') ? 50000 : 0) + site.visits.length;
const busiest = (sites) => sites.reduce((best, site) => (!best || siteRank(site) > siteRank(best) ? site : best), null);

/** A stop called exactly what was typed; a station beats a bus stop of the same name. */
export function exactSite(query, index) {
  const wanted = normalizePlace(query);
  if (!wanted) return null;
  return busiest(index.filter((s) => normalizePlace(s.name.zh) === wanted || normalizePlace(s.name.en) === wanted));
}

/** Stops whose name contains the text, nearest first, or the busiest first with no position. */
export function matchingSites(query, index, from, text = (site) => `${site.name.zh} ${site.name.en}`.toLowerCase(), limit = 8) {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [];
  const found = index.filter((site) => text(site).includes(wanted)).map((site) => ({
    site, distance: from ? Math.min(...site.platforms.map((p) => meters(from, p))) : null,
  }));
  found.sort((a, b) => (from ? a.distance - b.distance : b.site.visits.length - a.site.visits.length));
  return found.slice(0, limit);
}

export function partialSite(query, index) {
  const wanted = query.trim().toLowerCase();
  if (wanted.length < 2) return null;
  return busiest(index.filter((s) => s.name.zh.includes(wanted) || s.name.en.toLowerCase().includes(wanted)));
}

/** Route keys whose number starts with the search text, in natural order. */
export function searchRoutes(db, query, limit = 60) {
  const prefix = query.trim().toUpperCase();
  if (!prefix) return [];
  return Object.values(db.routes)
    .filter((route) => route.route.toUpperCase().startsWith(prefix) || lineName(route.operators[0], route.route, 'zh').includes(query.trim()))
    .sort((a, b) => compare(a.route, b.route) || a.serviceType.localeCompare(b.serviceType))
    .slice(0, limit);
}
