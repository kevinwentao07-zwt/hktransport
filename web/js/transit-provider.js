// Provider itineraries use one journey model, including live arrival matching.
import { journeyID, meters, mtrLine, normalizePlace, walkMinutes } from './transit.js?v=dev';

export function routeOperator(agencies, number, vehicle) {
  if (/Light Rail|輕鐵/i.test(agencies + " " + number) || (/MTR|港鐵/i.test(agencies) && vehicle === 'TRAM')) return 'lightRail';
  if (/MTR|港鐵/i.test(agencies) && mtrLine(number)) return 'mtr';
  if (/minibus|小巴/i.test(agencies)) return 'gmb';
  if (/Kowloon Motor Bus|KMB|Long Win|九巴|龍運/i.test(agencies)) return 'kmb';
  if (/Citybus|城巴/i.test(agencies)) return 'ctb';
  if (/Lantao Bus|Lantau Bus|嶼巴|大嶼山巴士/i.test(agencies)) return 'nlb';
  return 'transit';
}

/** A provider ride can use local ETAs only when its operator and ordered stop pair match. */
function matchRide(db, op, number, board, alight, count) {
  const nearby = op === 'mtr' ? 300 : 140;
  const localNumber = op === 'gmb' ? number.replace(/^(?:HKI|KLN|NT)-/i, '') : number;
  const stopDistance = (id, place) => {
    if (place.localID && id === place.localID) return 0;
    const stop = db.stops[id];
    if (!stop?.location) return Infinity;
    const distance = meters(stop.location, place.location);
    if (distance > nearby) return Infinity;
    const exact = [stop.name.zh, stop.name.en].some((name) => name && normalizePlace(name) === normalizePlace(place.name));
    return distance + (exact ? 0 : 30);
  };
  let best = null, score = Infinity;
  for (const route of Object.values(db.routes)) {
    const stops = route.stops[op];
    if (route.route.toUpperCase() !== localNumber.toUpperCase() || !stops) continue;
    let start = Infinity, boardPosition = -1;
    for (const [position, id] of stops.entries()) {
      const finish = stopDistance(id, alight);
      const cost = start + finish + (count == null ? 0 : Math.abs(position - boardPosition - count) * 20);
      if (cost < score) {
        score = cost;
        best = { routeKey: route.key, boardPosition, alightPosition: position, boardStopID: stops[boardPosition], alightStopID: id };
      }
      const distance = stopDistance(id, board);
      if (distance < start) {
        start = distance;
        boardPosition = position;
      }
    }
  }
  return best;
}

export function scheduledRide(db, { op, route, board, alight, departure, arrival, headsign, count, points, stops, platform }) {
  if (!board || !alight || !route || !Number.isFinite(departure) || !Number.isFinite(arrival) || arrival < departure) return null;
  const local = matchRide(db, op, route, board, alight, count);
  const direction = headsign || alight.name;
  const localRoute = local && db.routes[local.routeKey];
  const last = localRoute?.dest;
  const localDirection = last && (normalizePlace(direction) === normalizePlace(last.en ?? '') || normalizePlace(direction) === normalizePlace(last.zh ?? '')) ? last : null;
  const stopKey = (place) => place.id ?? `${place.name}@${place.location.lat},${place.location.lng}`;
  return {
    type: 'ride', op, route: localRoute?.route ?? route, dest: localDirection ?? { zh: direction, en: direction }, stopCount: count,
    boardName: board.name, alightName: alight.name, boardStopID: stopKey(board), alightStopID: stopKey(alight),
    boardLocation: board.location, alightLocation: alight.location, routePoints: points,
    providerStops: stops, scheduledPlatform: platform,
    scheduledDeparture: departure, rideMinutes: (arrival - departure) / 60_000, transferMinutes: 0, ...local,
  };
}

export function appendWalk(legs, line, distance, duration, source) {
  const metersWalked = distance ?? (line.length >= 2 ? meters(line[0], line.at(-1)) : 0);
  const walking = duration ?? walkMinutes(metersWalked);
  const previous = legs.at(-1);
  if (previous?.type === 'walk') {
    previous.meters += metersWalked;
    previous.minutes += walking;
    previous.routePoints.push(...line);
  } else {
    legs.push({ type: 'walk', meters: metersWalked, minutes: walking, walkFromMap: true, walkSource: source, routePoints: [...line] });
  }
}

export function scheduledJourney(legs, { departure, arriveBy, now, provider }) {
  const firstRide = legs.findIndex((leg) => leg.type === 'ride');
  if (firstRide < 0) return [];
  const accessTime = legs.slice(0, firstRide).reduce((sum, leg) => sum + leg.minutes * 60_000, 0);
  const start = arriveBy == null ? departure : Math.max(now, legs[firstRide].scheduledDeparture - accessTime);
  let clock = start;
  for (const [i, leg] of legs.entries()) {
    if (leg.type === 'walk') {
      leg.targetName = legs[i + 1]?.boardName;
      clock += leg.minutes * 60_000;
    } else {
      // Providers may round the boarding time separately from walking seconds.
      if (clock > leg.scheduledDeparture + 30_000) return [];
      leg.waitMinutes = Math.max(0, (leg.scheduledDeparture - clock) / 60_000);
      clock = Math.max(clock, leg.scheduledDeparture) + leg.rideMinutes * 60_000;
    }
  }
  const journey = { legs, departure: start, arriveBy, provider };
  return [{ ...journey, id: `${provider}:${journeyID(journey)}` }];
}

export async function requestTransitProvider(endpoint, from, to, { preference, mode, at, lang, signal }, timeout) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, preference, mode, at, lang }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    });
    const result = response.ok ? await response.json() : null;
    return Array.isArray(result?.routes) ? result.routes : [];
  } catch {
    return [];
  }
}
