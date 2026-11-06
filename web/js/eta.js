// Per-operator arrival fetchers. A port of ETAService.swift.
import { trainServes } from './transit.js?v=dev';

const text = (value) => (value == null ? '' : String(value));
const int = (value) => (value === '' || value == null || Number.isNaN(Number(value)) ? null : Number(value));
const rows = (value) => (Array.isArray(value) ? value : []);
const EMPTY = { zh: '', en: '' };

/** NLB and MTR return "yyyy-MM-dd HH:mm:ss" in Hong Kong time. */
export function parseDate(value) {
  if (!value) return null;
  const local = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}+08:00` : value;
  const time = Date.parse(local);
  return Number.isNaN(time) ? null : time;
}

const busETA = (row, co) => ({ date: parseDate(text(row.eta)), remark: { en: text(row.rmk_en), zh: text(row.rmk_tc) }, dest: { en: text(row.dest_en), zh: text(row.dest_tc) }, co });
const notice = (message, co) => ({ date: null, remark: { en: message, zh: message }, dest: EMPTY, co });

/** Route data and the feeds can disagree on sequence numbers, so use the closest. */
function nearestSeq(list, target) {
  const seqs = list.map((row) => int(row.seq)).filter((seq) => seq != null);
  if (!seqs.length) return list;
  const best = seqs.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
  return list.filter((row) => int(row.seq) === best);
}

export function parseKMB(json, bound, seq, stopId, stops) {
  let matching = nearestSeq(rows(json.data).filter((row) => text(row.dir) === bound), seq + 1);
  // Circular route: the terminus appears twice, keep the requested visit.
  if (stops[0] === stops.at(-1) && stopId === stops[0]) matching = matching.filter((row) => int(row.seq) === seq + 1);
  return matching.map((row) => busETA(row, 'kmb'));
}

export function parseCTB(json, bound, seq) {
  const matching = rows(json.data).filter((row) => text(row.dir) && bound.includes(text(row.dir)));
  return nearestSeq(matching, seq + 1).map((row) => busETA(row, 'ctb'));
}

export function parseNLB(json) {
  const etas = rows(json.estimatedArrivals).filter((row) => text(row.estimatedArrivalTime)).map((row) => {
    const scheduled = text(row.departed) !== '1' || text(row.noGPS) === '1';
    const variant = text(row.routeVariantName);
    return { date: parseDate(text(row.estimatedArrivalTime)), remark: scheduled ? { en: 'Scheduled', zh: '預定班次' } : EMPTY, dest: { en: variant, zh: variant }, co: 'nlb' };
  });
  return !etas.length && text(json.message) ? [notice(text(json.message), 'nlb')] : etas;
}

export function parseGMB(json, bound, seq) {
  const routeSeq = bound === 'O' ? 1 : bound === 'I' ? 2 : null;
  if (!routeSeq) return [];
  return rows(json.data).filter((row) => int(row.route_seq) === routeSeq && int(row.stop_seq) === seq + 1).flatMap((row) => {
    if (row.enabled !== true) return [{ date: null, remark: { en: text(row.description_en), zh: text(row.description_tc) }, dest: EMPTY, co: 'gmb' }];
    return rows(row.eta).map((eta) => ({ date: parseDate(text(eta.timestamp)), remark: { en: text(eta.remarks_en), zh: text(eta.remarks_tc) }, dest: EMPTY, co: 'gmb' }));
  });
}

export function parseLightRail(json, route, dest, now) {
  const platforms = json.platform_list;
  if (!Array.isArray(platforms)) return [];
  if (platforms.every((p) => (int(p.end_service_status) ?? 0) !== 0)) {
    return [{ date: null, remark: { en: "This stop's service for today has ended", zh: '此站今日服務已經終止' }, dest: EMPTY, co: 'lightRail' }];
  }
  return platforms.flatMap((platform) => {
    const id = text(platform.platform_id);
    return rows(platform.route_list).filter((train) => (route === text(train.route_no) || route === text(train.additionalInfo1))
      && (text(train.dest_ch) === dest.zh || text(train.dest_en).includes('Circular')) && int(train.stop) === 0)
      .map((train) => {
        // "3 min" -> 3; "Arriving", "Departing" and "-" -> 0.
        const minutes = parseInt(text(train.time_en), 10) || 0;
        const cars = '▭'.repeat(Math.max(0, int(train.train_length) ?? 0));
        return { date: now + minutes * 60_000, remark: { en: `Platform ${id} - ${cars}`, zh: `${id}號月台 - ${cars}` }, dest: EMPTY, co: 'lightRail' };
      });
  });
}

export function parseMTR(json, line, stopId, bound, stops) {
  if (int(json.status) === 0) {
    const message = text(json.message).replace('Please click here for more information.', '').trim();
    return message ? [notice(message, 'mtr')] : [];
  }
  const station = json.data?.[`${line}-${stopId}`];
  return rows(station?.[bound.endsWith('UT') ? 'UP' : 'DOWN']).map((train) => {
    const platform = text(train.plat), dest = text(train.dest);
    return { date: parseDate(text(train.time)), remark: { en: `Platform ${platform}`, zh: `${platform}號月台` }, dest: stops[dest]?.name ?? { en: dest, zh: dest }, co: 'mtr' };
  });
}

/** Joint routes return one list per operator. Notices are kept only when no real time exists. */
export function mergeETAs(lists) {
  const all = lists.flat(), timed = all.filter((eta) => eta.date != null);
  return timed.length ? timed.sort((a, b) => a.date - b.date) : all;
}

async function get(url) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchOperator(op, route, seq, db, lang) {
  const stops = route.stops[op];
  if (!stops || seq >= stops.length) return [];
  const stopId = stops[seq], bound = route.bound[op] ?? '', no = encodeURIComponent(route.route), e = encodeURIComponent;
  switch (op) {
    case 'kmb': return parseKMB(await get(`https://data.etabus.gov.hk/v1/transport/kmb/eta/${e(stopId)}/${no}/${e(route.serviceType)}`), bound, seq, stopId, stops);
    case 'ctb': return parseCTB(await get(`https://rt.data.gov.hk/v2/transport/citybus/eta/CTB/${e(stopId)}/${no}`), bound, seq);
    case 'nlb': return route.nlbId ? parseNLB(await get(`https://rt.data.gov.hk/v2/transport/nlb/stop.php?action=estimatedArrivals&routeId=${e(route.nlbId)}&stopId=${e(stopId)}&language=${lang}`)) : [];
    case 'gmb': return route.gtfsId ? parseGMB(await get(`https://data.etagmb.gov.hk/eta/route-stop/${e(route.gtfsId)}/${e(stopId)}`), bound, seq) : [];
    case 'lightRail': return parseLightRail(await get(`https://rt.data.gov.hk/v1/transport/mtr/lrt/getSchedule?station_id=${e(stopId.slice(2))}&with_special=1`), route.route, route.dest, Date.now());
    case 'mtr': return parseMTR(await get(`https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line=${no}&sta=${e(stopId)}`), route.route, stopId, bound, db.stops);
    default: return [];
  }
}

/** Arrivals at stop `seq`, optionally for one operator of a joint route. */
export async function fetchETA(route, seq, db, lang, onlyOperator = null) {
  const operators = onlyOperator ? [onlyOperator] : route.operators;
  const results = await Promise.allSettled(operators.map((op) => fetchOperator(op, route, seq, db, lang)));
  const lists = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!lists.length) throw results[0]?.reason ?? new Error('No data');
  return mergeETAs(lists);
}

const MOST_SAMPLED_STOPS = 8;

/**
 * Arrivals along a whole route, as [{position, times}]. KMB answers for every stop at once; the
 * others are asked at a handful of stops spread along the route.
 */
export async function routeArrivals(route, op, db, lang) {
  const stops = route.stops[op];
  if (op === 'kmb') {
    const response = await fetch(`https://data.etabus.gov.hk/v1/transport/kmb/route-eta/${encodeURIComponent(route.route)}/${route.serviceType}`);
    const bound = route.bound?.kmb;
    const byStop = new Map();
    for (const row of rows((await response.json()).data)) {
      const time = parseDate(text(row.eta)), position = int(row.seq) - 1;
      if (time == null || text(row.dir) !== bound) continue;
      byStop.set(position, [...(byStop.get(position) ?? []), time]);
    }
    return [...byStop].map(([position, times]) => ({ position, times }));
  }
  const count = Math.min(MOST_SAMPLED_STOPS, stops.length - 1);
  const positions = [...new Set(Array.from({ length: count }, (_, index) => Math.round((index * (stops.length - 2)) / Math.max(1, count - 1))))];
  const answers = await Promise.allSettled(positions.map((position) => fetchETA(route, position, db, lang, op)));
  return answers.flatMap((answer, index) => (answer.status === 'fulfilled'
    ? [{ position: positions[index], times: answer.value.map((eta) => eta.date).filter((date) => date != null) }] : []));
}

/** Live departures for a planned ride; shared per plan so a stop is only asked once. */
export function liveArrivalCache(db, lang) {
  const tasks = new Map();
  return (ride) => {
    const key = `${ride.routeKey}|${ride.op}|${ride.boardPosition}|${ride.alightPosition}`;
    if (!tasks.has(key)) {
      tasks.set(key, (async () => {
        const route = db.routes[ride.routeKey];
        if (!route) return null;
        try {
          const etas = await fetchETA(route, ride.boardPosition, db, lang, ride.op);
          const departures = etas.filter((eta) => eta.date != null && trainServes(eta.dest, ride, db))
            .map((eta) => ({ date: eta.date, platform: ride.op === 'mtr' ? eta.remark : null }));
          return departures.length ? departures : null;
        } catch {
          return null;
        }
      })());
    }
    return tasks.get(key);
  };
}
