// Adapts Google transit steps to the same journey model as the built-in planner.
import { mtrLine } from './transit.js?v=dev';
import { appendWalk, requestTransitProvider, routeOperator, scheduledJourney, scheduledRide } from './transit-provider.js?v=dev';

const location = (value) => {
  const { latitude: lat, longitude: lng } = value?.latLng ?? {};
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
};
const points = (step) => step.polyline?.geoJsonLinestring?.coordinates?.map(([lng, lat]) => ({ lat, lng }))
  ?? [location(step.startLocation), location(step.endLocation)].filter(Boolean);
const minutes = (duration) => typeof duration === 'string' && /^\d+(\.\d+)?s$/.test(duration)
  ? Number(duration.slice(0, -1)) / 60 : null;

function rideStep(step, db) {
  const details = step.transitDetails, times = details?.stopDetails, line = details?.transitLine;
  if (!line) return null;
  const stop = (value) => {
    const coordinates = location(value?.location);
    return value?.name && coordinates ? { name: value.name, location: coordinates } : null;
  };
  const agency = (line.agencies ?? []).map(({ name }) => name).join(' ');
  const number = line.nameShort || line.name;
  const op = routeOperator(agency, number, line.vehicle?.type);
  const route = (op === 'mtr' && mtrLine(number)) || number;
  return scheduledRide(db, {
    op, vehicleType: line.vehicle?.type, route, board: stop(times?.departureStop), alight: stop(times?.arrivalStop),
    departure: Date.parse(times?.departureTime), arrival: Date.parse(times?.arrivalTime),
    headsign: details.headsign, count: details.stopCount, points: points(step),
  });
}

function fareCents(route) {
  const money = route.travelAdvisory?.transitFare;
  if (money?.currencyCode !== 'HKD') return null;
  const units = Number(money.units ?? 0), nanos = money.nanos ?? 0;
  return Number.isSafeInteger(units) && units >= 0 && Number.isInteger(nanos) && nanos >= 0 && nanos < 1_000_000_000
    ? Math.round(units * 100 + nanos / 10_000_000) : null;
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
        appendWalk(legs, points(step), step.distanceMeters, minutes(step.staticDuration), 'google');
      } else {
        return [];
      }
    }
    return scheduledJourney(legs, { departure, arriveBy, now, provider: 'google' })
      .map((journey) => ({ ...journey, fareCents: fareCents(route) }));
  });
}

export const requestGoogleTransit = (from, to, options) => requestTransitProvider('api/transit', from, to, options, 6000);
