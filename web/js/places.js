// Finding places: the Government's location search for landmarks and buildings,
// and Photon (OpenStreetMap) for shops, neither of which needs a key. Google goes through the
// site's server, which holds the key and its limits.
import { meters } from './transit.js?v=dev';

const HK_BBOX = '113.82,22.13,114.45,22.58';
export const inHongKong = (l) => l.lat >= 22.13 && l.lat <= 22.58 && l.lng >= 113.82 && l.lng <= 114.45;

export const HONG_KONG = { lat: 22.35, lng: 114.15 };

const googleAnswers = new Map();

/** Places from Google, or null at the limit. A repeat in the same visit costs nothing. */
export async function googleSearch(query, center, radius, lang, details = false) {
  const key = [query, center.lat, center.lng, radius, lang, details].join('|');
  if (googleAnswers.has(key)) return googleAnswers.get(key);
  try {
    const response = await fetch('api/places', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, lat: center.lat, lng: center.lng, radius, lang, details }),
      signal: AbortSignal.timeout(16_000),
    });
    if (!response.ok) return null;
    const places = (await response.json()).places.filter((place) => inHongKong(place.location) && place.status !== 'CLOSED_PERMANENTLY');
    googleAnswers.set(key, places);
    return places;
  } catch {
    return null;
  }
}

const walks = new Map();
const walkKey = (from, to) => [from.lat, from.lng, to.lat, to.lng].join();

/** The walking line Google gave for this stretch, once it has arrived. */
export const knownWalk = (from, to) => walks.get(walkKey(from, to))?.points ?? null;

/** Asks Google once per stretch per visit. Without an answer the map keeps its straight line. */
export function googleWalk(from, to) {
  const key = walkKey(from, to);
  if (walks.has(key)) return walks.get(key).done;
  const walk = { points: null };
  walk.done = fetch('api/walk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: { lat: from.lat, lng: from.lng }, to: { lat: to.lat, lng: to.lng } }),
    signal: AbortSignal.timeout(16_000),
  }).then((response) => (response.ok ? response.json() : null)).then((answer) => {
    if (answer?.points?.length) walk.points = [from, ...answer.points, to];
  }).catch(() => {});
  walks.set(key, walk);
  return walk.done;
}

/** Hong Kong 1980 Grid to WGS84: inverse transverse Mercator, then the published datum shift. */
export function hk80ToWgs84(easting, northing) {
  const a = 6378388, f = 1 / 297, e2 = 2 * f - f * f, rad = Math.PI / 180;
  const lat0 = (22 + 18 / 60 + 43.68 / 3600) * rad, lng0 = (114 + 10 / 60 + 42.8 / 3600) * rad;
  const arc = (phi) => a * ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi
    - ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi)
    + ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi)
    - ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const mu = (northing - 819069.8 + arc(lat0)) / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
    + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu);
  const s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
  const nu = a / Math.sqrt(1 - e2 * s * s), rho = (a * (1 - e2)) / (1 - e2 * s * s) ** 1.5;
  const d = (easting - 836694.05) / nu, psi = nu / rho;
  const lat = phi - (t * nu * d * d) / (2 * rho) + (t * nu * d ** 4 * (4 * psi ** 2 + 9 * psi * (1 - t * t) - 12 * t * t)) / (24 * rho);
  const lng = lng0 + (d - (d ** 3 * (psi + 2 * t * t)) / 6) / c;
  return { lat: lat / rad - 5.5 / 3600, lng: lng / rad + 8.8 / 3600 };
}

async function json(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

export async function governmentSearch(text) {
  const found = await json(`https://www.map.gov.hk/gs/api/v1.0.0/locationSearch?q=${encodeURIComponent(text)}`);
  return (Array.isArray(found) ? found : []).map((item) => ({
    name: item.nameZH || item.nameEN, nameEn: item.nameEN, address: item.addressZH?.replace(/\s+/g, ' ').trim() ?? '',
    district: item.districtZH ?? '', location: hk80ToWgs84(item.x, item.y),
  })).filter((item) => inHongKong(item.location));
}

const photonItem = (feature) => {
  const p = feature.properties ?? {}, [lng, lat] = feature.geometry?.coordinates ?? [];
  return {
    name: p.name ?? '', kind: p.osm_value ?? '', district: p.district ?? '',
    address: [p.street, p.housenumber, p.locality].filter(Boolean).join(' '), location: { lat, lng },
  };
};

export async function photonSearch(text, center, radius) {
  const bias = center ? `&lat=${center.lat}&lon=${center.lng}` : '';
  const found = await json(`https://photon.komoot.io/api/?q=${encodeURIComponent(text)}&limit=12&bbox=${HK_BBOX}${bias}`);
  const items = (found?.features ?? []).map(photonItem).filter((item) => item.name && inHongKong(item.location));
  return center && radius ? items.filter((item) => meters(center, item.location) <= radius) : items;
}

/** The district around a position: {zh, en}. Sends the position to Photon, only when "nearby" is asked for. */
export async function districtAt(location) {
  const found = await json(`https://photon.komoot.io/reverse?lat=${location.lat}&lon=${location.lng}`);
  const district = found?.features?.[0]?.properties?.district;
  if (!district) return null;
  const match = district.match(/^(\S*區)\s*(.*)$/);
  return match ? { zh: match[1], en: match[2] } : { zh: district, en: district };
}

/** The best single match for free text, or null. */
export async function lookupPlace(text) {
  const wanted = text.trim().toLowerCase();
  const government = await governmentSearch(text);
  const exact = government.find((item) => item.name?.toLowerCase() === wanted || item.nameEn?.toLowerCase() === wanted);
  if (exact) return { name: exact.name, location: exact.location };
  const [shop] = await photonSearch(text);
  if (shop) return { name: shop.name, location: shop.location };
  const [first] = government;
  return first ? { name: first.name, location: first.location } : null;
}

export function withinArea(places, area) {
  return places.map((place) => ({ ...place, meters: meters(area.center, place.location) }))
    .filter((place) => place.meters <= area.radius && (!area.district || !place.district || place.district.includes(area.district)))
    .sort((a, b) => a.meters - b.meters);
}

const NEARBY = ['附近', '呢度', '呢頭', '這裡', '這裏', '这里', '我身邊', '就近', 'nearby', 'near me', 'around here'];
const AREA_SUFFIXES = ['附近', '一帶', '一带', '周邊', '周边', '周圍', '周围', '嗰邊', '那邊'];
export const isNearby = (text) => !text.trim() || NEARBY.includes(text.trim().toLowerCase());
export function cleanArea(text) {
  const value = text.trim();
  const suffix = AREA_SUFFIXES.find((word) => value.endsWith(word) && value.length > word.length);
  return (suffix ? value.slice(0, -suffix.length) : value).trim();
}
