import { mtrLine } from './transit.js?v=dev';
import { appendWalk, requestTransitProvider, routeOperator, scheduledJourney, scheduledRide } from './transit-provider.js?v=dev';

function location(value) {
  const { lat, lon: lng } = value ?? {};
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function stop(place) {
  const point = location(place);
  if (!point || !place.name) return null;
  const localID = place.stopId?.match(/_(?:KMB|CTB|NLB|GMB)-([A-Z0-9]+)$/i)?.[1]
    ?? place.parentId?.match(/_MTR-([A-Z]{3})$/)?.[1];
  return { name: place.name, location: point, id: place.stopId, localID };
}

function points(leg) {
  const fallback = [location(leg.from), location(leg.to)].filter(Boolean);
  const { points: encoded, precision } = leg.legGeometry ?? {};
  if (!encoded || (precision !== 5 && precision !== 6)) return fallback;
  const factor = 10 ** precision, result = [];
  let lat = 0, lng = 0, index = 0;
  const delta = () => {
    let value = 0, shift = 0;
    while (index < encoded.length && shift <= 30) {
      const byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) break;
      value |= (byte & 31) << shift;
      if (byte < 32) return value & 1 ? ~(value >>> 1) : value >>> 1;
      shift += 5;
    }
    return null;
  };
  while (index < encoded.length) {
    const x = delta(), y = delta();
    if (x == null || y == null) return fallback;
    lat += x;
    lng += y;
    const point = { lat: lat / factor, lng: lng / factor };
    if (Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) return fallback;
    result.push(point);
  }
  return result.length >= 2 ? result : fallback;
}

export function transitousJourneys(itineraries, db, departure, arriveBy = null, now = departure) {
  return itineraries.flatMap((itinerary) => {
    const legs = [];
    for (const leg of itinerary.legs ?? []) {
      if (leg.mode === 'WALK') {
        if (!Number.isFinite(leg.duration) || leg.duration < 0) return [];
        appendWalk(legs, points(leg), leg.distance, leg.duration / 60, 'transitous');
        continue;
      }
      if (leg.cancelled || !leg.tripId || leg.from?.cancelled || leg.to?.cancelled) return [];
      const stops = [leg.from, ...(leg.intermediateStops ?? []), leg.to].map(stop).filter(Boolean);
      const number = leg.routeShortName || leg.routeLongName;
      const op = routeOperator(leg.agencyName ?? '', number, leg.mode);
      const ride = scheduledRide(db, {
        op, vehicleType: leg.mode, route: (op === 'mtr' && mtrLine(number)) || number, board: stop(leg.from), alight: stop(leg.to),
        departure: Date.parse(leg.startTime), arrival: Date.parse(leg.endTime), headsign: leg.headsign,
        count: stops.length - 1, points: points(leg), stops, platform: leg.from?.track,
      });
      if (!ride) return [];
      if (ride.routeKey) {
        ride.boardName = undefined;
        ride.alightName = undefined;
      }
      legs.push(ride);
    }
    const journeys = scheduledJourney(legs, { departure, arriveBy, now, provider: 'transitous' });
    for (const journey of journeys) {
      for (const [index, leg] of journey.legs.entries()) {
        if (leg.type === 'walk') leg.to = journey.legs[index + 1]?.routeKey ? journey.legs[index + 1].boardStopID : null;
      }
    }
    return journeys;
  });
}

export const requestTransitous = (from, to, options) => requestTransitProvider('api/transitous', from, to, options, 5000);
