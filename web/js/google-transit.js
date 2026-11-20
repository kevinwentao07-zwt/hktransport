// Adapts Google transit steps to the same journey model as the built-in planner.
import { journeyID, meters, mtrLine, normalizePlace, walkMinutes } from './transit.js?v=dev';

const location = (value) => {
  const { latitude: lat, longitude: lng } = value?.latLng ?? {};
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
};
const points = (step) => step.polyline?.geoJsonLinestring?.coordinates?.map(([lng, lat]) => ({ lat, lng }))
  ?? [location(step.startLocation), location(step.endLocation)].filter(Boolean);
const minutes = (duration) => typeof duration === 'string' && /^\d+(\.\d+)?s$/.test(duration)
  ? Number(duration.slice(0, -1)) / 60 : null;

function operator(line) {
  const agencies = (line.agencies ?? []).map(({ name }) => name).join(' ');
  if (/Light Rail|輕鐵/i.test(line.name) || (/MTR|港鐵/i.test(agencies) && line.vehicle?.type === 'TRAM')) return 'lightRail';
  if (/MTR|港鐵/i.test(agencies) && mtrLine(line.nameShort ?? line.name)) return 'mtr';
  if (/minibus|小巴/i.test(agencies)) return 'gmb';
  if (/Kowloon Motor Bus|KMB|Long Win|九巴|龍運/i.test(agencies)) return 'kmb';
  if (/Citybus|城巴/i.test(agencies)) return 'ctb';
  if (/Lantao Bus|Lantau Bus|嶼巴|大嶼山巴士/i.test(agencies)) return 'nlb';
  return 'transit';
}

/** A Google ride can use local ETAs only when its operator and ordered stop pair match. */
function matchRide(db, op, number, board, alight, count) {
  const nearby = op === 'mtr' ? 300 : 140;
  const stopDistance = (id, place) => {
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
    if (route.route.toUpperCase() !== number.toUpperCase() || !stops) continue;
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

function rideStep(step, db) {
  const details = step.transitDetails, times = details?.stopDetails, line = details?.transitLine;
  const stop = (value) => value?.name && location(value.location) && { name: value.name, location: location(value.location) };
  const board = stop(times?.departureStop), alight = stop(times?.arrivalStop);
  const departure = Date.parse(times?.departureTime), arrival = Date.parse(times?.arrivalTime);
  if (!board || !alight || !line || !Number.isFinite(departure) || !Number.isFinite(arrival) || arrival < departure) return null;
  const op = operator(line), route = (op === 'mtr' && mtrLine(line.nameShort ?? line.name)) || line.nameShort || line.name;
  if (!route) return null;
  const local = matchRide(db, op, route, board, alight, details.stopCount);
  const headsign = details.headsign || alight.name;
  const stopKey = (place) => `${place.name}@${place.location.lat},${place.location.lng}`;
  return {
    type: 'ride', op, route, dest: { zh: headsign, en: headsign }, stopCount: details.stopCount,
    boardName: board.name, alightName: alight.name, boardStopID: stopKey(board), alightStopID: stopKey(alight),
    boardLocation: board.location, alightLocation: alight.location, googlePoints: points(step),
    googleDeparture: departure, rideMinutes: (arrival - departure) / 60_000, transferMinutes: 0, ...local,
  };
}

export function googleJourneys(routes, db, departure, arriveBy = null, now = departure) {
  return routes.flatMap((route) => {
    const legs = [];
    for (const step of route.legs?.flatMap((leg) => leg.steps ?? []) ?? []) {
      if (step.travelMode === 'TRANSIT') {
        const ride = rideStep(step, db);
        if (!ride) return [];
        legs.push(ride);
      } else if (step.travelMode === 'WALK') {
        const line = points(step);
        const distance = step.distanceMeters ?? (line.length >= 2 ? meters(line[0], line.at(-1)) : 0);
        const duration = minutes(step.staticDuration) ?? walkMinutes(distance);
        const previous = legs.at(-1);
        if (previous?.type === 'walk') {
          previous.meters += distance;
          previous.minutes += duration;
          previous.googlePoints.push(...line);
        } else {
          legs.push({ type: 'walk', meters: distance, minutes: duration, walkFromMap: true, googlePoints: line });
        }
      } else {
        return [];
      }
    }
    const firstRide = legs.findIndex((leg) => leg.type === 'ride');
    if (firstRide < 0) return [];
    const walkToFirst = legs.slice(0, firstRide).reduce((sum, leg) => sum + leg.minutes * 60_000, 0);
    const start = arriveBy == null ? departure : Math.max(now, legs[firstRide].googleDeparture - walkToFirst);
    let clock = start;
    for (const [i, leg] of legs.entries()) {
      if (leg.type === 'walk') {
        leg.targetName = legs[i + 1]?.boardName;
        clock += leg.minutes * 60_000;
      } else {
        // Google reports walking in seconds and may round the boarding time separately.
        if (clock > leg.googleDeparture + 30_000) return [];
        leg.waitMinutes = Math.max(0, (leg.googleDeparture - clock) / 60_000);
        clock = Math.max(clock, leg.googleDeparture) + leg.rideMinutes * 60_000;
      }
    }
    const journey = { legs, departure: start, arriveBy, byGoogle: true };
    // Keep a Google and an independently planned journey distinct if both are offered.
    return [{ ...journey, id: `google:${journeyID(journey)}` }];
  });
}

export async function requestGoogleTransit(from, to, { preference, mode, at, lang, signal }) {
  try {
    const response = await fetch('api/transit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, preference, mode, at, lang }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
    });
    const result = response.ok ? await response.json() : null;
    return Array.isArray(result?.routes) ? result.routes : [];
  } catch {
    return [];
  }
}
