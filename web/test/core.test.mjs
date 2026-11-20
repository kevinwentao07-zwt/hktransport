import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../js/transit.js';
import * as E from '../js/eta.js';
import * as A from '../js/ai.js';
import * as P from '../js/places.js';
import { toSimplified } from '../js/hans.js';

const raw = {
  routeList: {
    r1: { route: '1', co: ['kmb'], orig: { en: 'A', zh: '甲' }, dest: { en: 'C', zh: '丙' }, serviceType: '1', stops: { kmb: ['A', 'B', 'C'] }, bound: { kmb: 'O' }, jt: '20', freq: null },
    r2: { route: '2', co: ['kmb'], orig: { en: 'E', zh: '戊' }, dest: { en: 'F', zh: '己' }, serviceType: '1', stops: { kmb: ['E', 'F'] }, bound: { kmb: 'O' }, jt: '10' },
    night: { route: 'N1', co: ['kmb'], orig: { en: 'G', zh: '庚' }, dest: { en: 'H', zh: '辛' }, serviceType: '1', stops: { kmb: ['G', 'H'] }, bound: { kmb: 'O' }, jt: '10', freq: { 7: { 2300: ['0100', '600'] } } },
    m1: { route: 'XYL', co: ['mtr'], orig: { en: 'AAA', zh: '站一' }, dest: { en: 'BBB', zh: '站二' }, serviceType: '1', stops: { mtr: ['AAA', 'BBB'] }, bound: { mtr: 'UT' }, jt: null },
    m2: { route: 'ZZL', co: ['mtr'], orig: { en: 'BBB', zh: '站二' }, dest: { en: 'CCC', zh: '站三' }, serviceType: '1', stops: { mtr: ['BBB', 'CCC'] }, bound: { mtr: 'UT' }, jt: null },
  },
  stopList: {
    A: { name: { en: 'A', zh: '甲' }, location: { lat: 22.3, lng: 114.17 } }, B: { name: { en: 'B', zh: '乙' }, location: { lat: 22.31, lng: 114.17 } },
    C: { name: { en: 'C', zh: '丙' }, location: { lat: 22.32, lng: 114.17 } }, E: { name: { en: 'E', zh: '戊' }, location: { lat: 22.32, lng: 114.1704 } },
    F: { name: { en: 'F', zh: '己' }, location: { lat: 22.35, lng: 114.17 } }, G: { name: { en: 'G', zh: '庚' }, location: { lat: 22.4, lng: 114.1 } },
    H: { name: { en: 'H', zh: '辛' }, location: { lat: 22.42, lng: 114.1 } }, AAA: { name: { en: 'One', zh: '站一' }, location: { lat: 22.25, lng: 114.25 } },
    BBB: { name: { en: 'Two', zh: '站二' }, location: { lat: 22.27, lng: 114.25 } }, CCC: { name: { en: 'Three', zh: '站三' }, location: { lat: 22.29, lng: 114.25 } },
  },
  serviceDayMap: { 7: ['1', '1', '1', '1', '1', '1', '1'] }, holidays: [],
};
const db = T.normalizeDB(raw), network = T.buildNetwork(db);
const noon = Date.parse('2026-11-04T12:00:00+08:00');
const at = (id) => db.stops[id].location;
const close = (a, b, tolerance = 0.01) => assert.ok(Math.abs(a - b) <= tolerance, `${a} !~ ${b}`);

test('exploration stays near the destination, with sources matched to the right branch', () => {
  const center = { lat: 22.33, lng: 114.16 };
  const place = (id, offset, address, status) => ({
    id, name: 'Test Café', address, status, location: { ...center, lat: center.lat + offset / 111_000 },
  });
  const branch = place('one', 70, '10 Test Street');
  const other = place('two', 130, '18 Other Street');
  const source = { title: 'Test Café guide', snippet: 'Visit Test Café at 10 Test Street.' };
  const results = P.exploreResults([
    branch, place('duplicate', 88, '10 Test Street'), other,
    place('closed', 200, '20 Test Street', 'CLOSED_TEMPORARILY'), place('far', 900, '90 Test Street'),
  ], [source], center, 800);
  assert.deepEqual(results.map((item) => [item.id, item.source]), [['one', source], ['two', undefined]]);
});

test('exploration web searches use the selected category and language', () => {
  for (const [name, category, locale, query, language] of [
    ['銅鑼灣', 'food', 'zh-Hant', '銅鑼灣附近好吃的地方', 'zh-TW'],
    ['銅鑼灣', 'sights', 'zh-Hans', '铜锣湾附近好去处', 'zh-CN'],
    ['Central & Western District', 'food', 'en', 'places to eat near Central & Western District', 'en'],
    ['Mong Kok', 'sights', 'en', 'things to do near Mong Kok', 'en'],
  ]) {
    const url = new URL(P.exploreWebSearchURL(name, category, locale));
    assert.equal(url.searchParams.get('q'), query);
    assert.equal(url.searchParams.get('hl'), language);
  }
});

test('frequency keeps single departures and sorts bands', () => {
  assert.deepEqual(T.parseFrequency({ 1: { '0800': ['0900', '600'], '0700': null } })[1], [{ start: 420, end: null, headway: null }, { start: 480, end: 540, headway: 600 }]);
});
test('wait is half the headway, including across midnight', () => {
  const bands = [{ start: 23 * 60, end: 60, headway: 600 }];
  assert.equal(T.waitFromBands(bands, 23 * 60 + 30, 90), 5);
  assert.equal(T.waitFromBands(bands, 30, 90), 5);
  assert.equal(T.waitFromBands(bands, 22 * 60, 90), 60);
  assert.equal(T.waitFromBands(bands, 12 * 60, 90), null);
});
test('direct ride', () => {
  const journey = T.search(network, at('A'), at('C'), noon)[0];
  assert.deepEqual(T.rides(journey).map((r) => r.route), ['1']);
  assert.equal(T.rides(journey)[0].alightPosition, 2);
  close(T.totalMinutes(journey), 27.5);
});
test('transfer with a walk between stops', () => {
  const journey = T.search(network, at('A'), at('F'), noon)[0];
  assert.deepEqual(T.rides(journey).map((r) => r.route), ['1', '2']);
  assert.equal(journey.legs.length, 3);
  close(journey.legs[1].meters, 41, 3);
  assert.equal(journey.legs[1].to, 'E');
});
test('a route that is not running is skipped', () => {
  assert.equal(T.search(network, at('G'), at('H'), noon).length, 0);
  close(T.rides(T.search(network, at('G'), at('H'), Date.parse('2026-11-04T23:30:00+08:00'))[0])[0].waitMinutes, 5);
});
test('MTR interchange uses the station transfer time', () => {
  const journey = T.search(network, at('AAA'), at('CCC'), noon).at(-1);
  assert.equal(T.rides(journey)[1].transferMinutes, 3);
});
test('short trips offer a walk', () => assert.equal(T.journeyID(T.plan(network, at('C'), at('E'), noon)[0]), 'walk'));

test('live retiming uses the first catchable departure', async () => {
  const journey = T.search(network, at('A'), at('C'), noon)[0];
  const live = await T.retime(journey, async () => [{ date: noon - 300_000 }, { date: noon + 240_000 }]);
  assert.equal(T.rides(live)[0].liveDeparture, noon + 240_000);
  close(T.totalMinutes(live), 24);
  const offline = await T.retime(journey, async () => null);
  assert.equal(T.rides(offline)[0].liveDeparture, null);
});
test('rail beyond the live window continues the live headway', () => {
  const trains = [0, 3, 6, 9].map((m) => ({ date: noon + m * 60_000, platform: 'p' }));
  assert.equal(T.nextDeparture(trains, noon + 4 * 60_000, true).isProjected, false);
  const projected = T.nextDeparture(trains, noon + 20 * 60_000, true);
  assert.equal(projected.departure.date, noon + 21 * 60_000);
  assert.equal(projected.isProjected, true);
  assert.equal(T.nextDeparture(trains, noon + 20 * 60_000, false), null);
  assert.equal(T.nextDeparture([trains[0]], noon + 20 * 60_000, true), null);
  assert.equal(T.nextDeparture(trains, noon + 90 * 60_000, true), null);
});
test('short workings and the other branch are not caught', () => {
  const loc = (lat, lng = 114.17) => ({ lat, lng });
  const n = (x) => ({ en: x, zh: x });
  const branched = T.normalizeDB({ routeList: {
    main: { route: 'EAL', co: ['mtr'], orig: n('A'), dest: n('D'), stops: { mtr: ['A', 'B', 'C', 'D'] }, bound: { mtr: 'UT' } },
    branch: { route: 'EAL', co: ['mtr'], orig: n('A'), dest: n('E'), serviceType: '2', stops: { mtr: ['A', 'B', 'E'] }, bound: { mtr: 'UT' } },
  }, stopList: { A: { name: n('A'), location: loc(22.3) }, B: { name: n('B'), location: loc(22.31) }, C: { name: n('C'), location: loc(22.32) }, D: { name: n('D'), location: loc(22.33) }, E: { name: n('E'), location: loc(22.32, 114.18) } } });
  const ride = (stop) => ({ op: 'mtr', route: 'EAL', boardStopID: 'A', alightStopID: stop });
  assert.equal(T.trainServes(n('D'), ride('C'), branched), true);
  assert.equal(T.trainServes(n('B'), ride('C'), branched), false);
  assert.equal(T.trainServes(n('E'), ride('C'), branched), false);
  assert.equal(T.trainServes(n('E'), ride('B'), branched), true);
  assert.equal(T.trainServes(n('New'), ride('C'), branched), true);
});
test('MTR shows line names', () => {
  assert.equal(T.lineName('mtr', 'EAL', 'zh'), '東鐵綫');
  assert.equal(T.lineName('kmb', '1A', 'zh'), '1A');
  assert.equal(T.lineColor('mtr', 'TWL'), '#ed1d24');
});

const start = { lat: 22.2995, lng: 114.17 }, end = { lat: 22.3505, lng: 114.17 };
const path = T.journeyPath(T.search(network, start, end, noon)[0], start, end, db);
test('map path follows every stop and walk', () => {
  assert.deepEqual(path.segments.map((s) => s.mode), ['walk', 'ride', 'walk', 'ride', 'walk']);
  assert.deepEqual(path.segments.map((s) => s.stopIDs), [[], ['A', 'B', 'C'], [], ['E', 'F'], []]);
});
test('progress follows the trip stop by stop', () => {
  const text = (p) => T.instruction(path, p, 'zh', (id) => id);
  assert.equal(text(T.progressAt(path, { lat: 22.2997, lng: 114.17 })), '步行前往 A');
  const onBus = T.progressAt(path, { lat: 22.305, lng: 114.17 });
  assert.equal(text(onBus), '1 · 下一站 B · 還有 2 站到 C 下車');
  assert.equal(text(T.progressAt(path, at('B'), 0, onBus)), '下一站 C 下車');
  assert.equal(text(T.progressAt(path, { lat: 22.32, lng: 114.1702 }, 0, onBus)), '步行前往 E');
});
test('noisy fixes cannot undo progress; arrival and leaving the route', () => {
  const late = T.progressAt(path, { lat: 22.335, lng: 114.17 });
  const noisy = T.progressAt(path, at('A'), 0, late);
  assert.equal(noisy.isOffRoute, true);
  assert.equal(noisy.edge, late.edge);
  assert.equal(T.progressAt(path, end).hasArrived, true);
  const vague = { lat: 22.31, lng: 114.1735 };
  assert.equal(T.progressAt(path, vague).isOffRoute, true);
  assert.equal(T.progressAt(path, vague, 500).isOffRoute, false);
});
test('the map keeps only what is ahead, with later legs drawn light', () => {
  const walking = { lat: 22.2997, lng: 114.17 };
  const before = T.pathAhead(path, T.progressAt(path, walking), walking);
  assert.deepEqual(before.segments.map((s) => s.upcoming ?? false), [false, true, true, true, true]);
  assert.deepEqual(before.segments[1].stopIDs, ['A', 'B', 'C']);
  const riding = { lat: 22.305, lng: 114.17 };
  const onBus = T.pathAhead(path, T.progressAt(path, riding), riding);
  assert.deepEqual(onBus.segments.map((s) => s.mode), ['ride', 'walk', 'ride', 'walk']);
  assert.deepEqual(onBus.segments[0].stopIDs, ['B', 'C']);
  assert.equal(onBus.segments[0].lead, 1);
  close(onBus.segments[0].points[0].lat, 22.305, 1e-6);
  assert.equal(onBus.segments[0].upcoming, undefined);
  assert.equal(T.pathAhead(path, null, null), path);
  assert.deepEqual(T.pathAhead(path, T.progressAt(path, end), end).segments, []);
});
test('stop index covers every mode and prefers stations', () => {
  const index = T.buildStopIndex(db);
  assert.ok(index.some((s) => T.siteHasMode(s, 'mtr')) && index.some((s) => T.siteHasMode(s, 'bus')));
  assert.equal(T.exactSite('站一站', index).id, 'AAA');
  assert.equal(T.exactSite('沒有', index), null);
  assert.equal(T.partialSite('站', index), null);
  assert.equal(T.stopsNear(index, at('A'), 1200)[0].site.id, 'A');
});

test('ETA parsers', () => {
  assert.equal(E.parseDate('2026-10-29 12:03:00'), Date.parse('2026-10-29T12:03:00+08:00'));
  const kmb = E.parseKMB({ data: [{ dir: 'O', seq: 3, eta: '2026-10-29T12:03:00+08:00' }, { dir: 'I', seq: 3, eta: 'x' }] }, 'O', 2, 'X', ['A', 'B', 'X', 'D']);
  assert.equal(kmb.length, 1);
  assert.equal(E.parseCTB({ data: [{ dir: 'I', seq: 1, eta: '' }, { dir: 'O', seq: 1, eta: '' }] }, 'IO', 0).length, 2);
  const stops = { WKS: { name: { en: 'Wu Kai Sha', zh: '烏溪沙' } } };
  const mtr = E.parseMTR({ status: 1, data: { 'TML-TUM': { UP: [{ time: '2026-10-29 12:03:00', plat: '1', dest: 'WKS' }], DOWN: [{ time: '2026-10-29 12:04:00', plat: '2', dest: 'TUM' }] } } }, 'TML', 'TUM', 'UT', stops);
  assert.equal(mtr.length, 1);
  assert.equal(mtr[0].dest.zh, '烏溪沙');
  assert.equal(mtr[0].remark.zh, '1號月台');
  assert.equal(E.parseGMB({ data: [{ route_seq: 1, stop_seq: 2, enabled: true, eta: [{ timestamp: '2026-10-29T12:03:00+08:00' }] }] }, 'O', 1).length, 1);
  assert.equal(E.parseNLB({ estimatedArrivals: [], message: 'none' })[0].remark.zh, 'none');
  const lrt = E.parseLightRail({ platform_list: [{ platform_id: 1, end_service_status: 0, route_list: [{ route_no: '505', dest_ch: '三聖', time_en: '3 min', stop: 0, train_length: 2 }] }] }, '505', { zh: '三聖' }, noon);
  assert.equal(lrt[0].date, noon + 180_000);
  assert.equal(E.mergeETAs([[{ date: null }], [{ date: 2 }, { date: 1 }]]).map((e) => e.date).join(), '1,2');
});

test('offline parser', () => {
  assert.deepEqual(A.parseTrip('由旺角去理大'), { origin: '旺角', destination: '理大', preference: 'lessWalking' });
  assert.deepEqual(A.parseTrip('去機場最快'), { origin: null, destination: '機場', preference: 'fastest' });
  assert.deepEqual(A.parseTrip('沙田到中環 唔想轉車'), { origin: '沙田', destination: '中環', preference: 'fewerTransfers' });
  assert.deepEqual(A.parseTrip('from Mong Kok to Central'), { origin: 'Mong Kok', destination: 'Central', preference: 'lessWalking' });
  assert.deepEqual(A.parseTrip('我的位置去九龍塘少行路'), { origin: null, destination: '九龍塘', preference: 'lessWalking' });
  assert.equal(A.parseTrip('   '), null);
});
test('follow-ups change only what was mentioned', () => {
  const current = { origin: '旺角', destination: '中環', preference: 'fastest' };
  assert.deepEqual(A.parseFollowUp('少行路', current), { ...current, preference: 'lessWalking' });
  assert.deepEqual(A.parseFollowUp('去機場', current), { origin: '旺角', destination: '機場', preference: 'fastest' });
  assert.equal(A.parseFollowUp('我的位置去機場', current).origin, null);
});
test('wishes', () => {
  assert.equal(A.parseWish('我想吃螺狮粉').want, '螺狮粉');
  assert.deepEqual(A.parseWish('想買手機').searchTerms, ['手機']);
  assert.equal(A.parseWish('去機場'), null);
});
test('AI replies', () => {
  assert.deepEqual(A.decodeChat('{"origin":null,"destination":"理大","preference":"fastest"}').trip, { origin: null, destination: '理大', preference: 'fastest' });
  const wish = A.decodeChat('```json\n{"kind":"discover","want":"螺螄粉","searchTerms":["a","b","c","d","e"],"area":null,"question":null,"options":["旺角"]}\n```').wish;
  assert.equal(wish.searchTerms.length, 4);
  assert.equal(wish.question, null);
  assert.deepEqual(wish.options, [], 'no question, so nothing to tap');
  const asking = A.decodeChat('{"kind":"discover","want":"美食","question":"想食咩菜？","options":["日本菜","火鍋"]}').wish;
  assert.equal(asking.question, '想食咩菜？');
  assert.deepEqual(asking.options, ['日本菜', '火鍋']);
  assert.equal(A.decodeChat('{"kind":"discover","want":" "}'), null);
  assert.equal(A.decodeChat('{"kind":"discover","want":"咖啡","query":"安靜 咖啡店"}').wish.query, '安靜 咖啡店');
  assert.equal(A.decodeChat('{"kind":"discover","want":"咖啡"}').wish.query, '咖啡');
  assert.equal(A.parseWish('我想吃螺狮粉').query, '螺狮粉');
  assert.match(A.searchMessage(null, '理大', 'fastest'), /Start: current location/);
});

test('HK grid converts to WGS84', () => {
  const langham = P.hk80ToWgs84(835408, 819931); // 朗豪坊
  close(langham.lat, 22.3177, 0.0008);
  close(langham.lng, 114.1684, 0.0008);
});
test('shops keep Google order, alternate between searches and appear once', () => {
  const shop = (id, lat) => ({ id, location: { lat, lng: 114.17 } });
  const area = { center: { lat: 22.33, lng: 114.17 }, radius: 2500 };
  assert.deepEqual(P.insideArea([shop('far', 22.5), shop('b', 22.34), shop('a', 22.331)], area).map((s) => s.id), ['b', 'a']);
  assert.deepEqual(P.mergeShops([shop('a'), shop('b'), shop('c')], [shop('b'), shop('d')], 9).map((s) => s.id), ['a', 'b', 'd', 'c']);
  assert.equal(P.mergeShops([shop('a'), shop('b')], [shop('c')], 2).length, 2);
  assert.equal(A.decodeChat('{"kind":"discover","want":"拉麵","query":"拉麵","queryEn":"ramen"}').wish.queryEn, 'ramen');
});
test('without the AI, searches go to Google and trips stay trips', () => {
  const wish = A.parseSearch('旺角有冇平啲嘅拉麵');
  assert.equal(wish.query, '旺角有冇平啲嘅拉麵');
  assert.equal(wish.anywhere, true);
  assert.equal(A.parseSearch('由旺角去理大'), null);
  assert.equal(A.parseSearch('去機場'), null);
  assert.equal(A.parseSearch('少行路'), null);
  assert.equal(A.parseSearch('  '), null);
});
test('Simplified Chinese', () => {
  assert.equal(toSimplified('銅鑼灣的平價拉麵'), '铜锣湾的平价拉面');
  assert.equal(toSimplified('荃灣綫 Tsuen Wan 2 號'), '荃湾线 Tsuen Wan 2 号');
  assert.equal(toSimplified('著名'), '著名');
  assert.equal(toSimplified('中環'), '中环');
});
test('a circular route turns at the stop it is signed for, or else its farthest', () => {
  const stop = (lat, zh) => ({ location: { lat, lng: 114.10 }, name: { zh } });
  const stops = { a: stop(22.30, '總站'), b: stop(22.315, '三門仔'), c: stop(22.32, '路口'), d: stop(22.31, '村'), e: stop(22.30, '總站') };
  const loop = { stops: { kmb: ['a', 'b', 'c', 'd', 'e'] }, orig: { zh: '總站' }, dest: { zh: '總站' } };
  const db = { stops };
  assert.equal(T.circularTurn(loop, 'kmb', db), 2);
  assert.equal(T.circularTurn({ ...loop, dest: { zh: '三門仔(循環線)' } }, 'kmb', db), 1);
  assert.equal(T.circularTurn({ ...loop, stops: { kmb: ['a', 'b', 'c', 'd'] } }, 'kmb', db), null);
  // Signed as circular, a route counts even when its two ends are a walk apart.
  assert.equal(T.circularTurn({ ...loop, stops: { kmb: ['a', 'b', 'c', 'd'] }, dest: { zh: '路口(循環線)' } }, 'kmb', db), 2);
  // A stop by the start sharing the terminus's name is not where it turns.
  const near = { ...stops, b: stop(22.3001, '碼頭') };
  assert.equal(T.circularTurn({ ...loop, dest: { zh: '碼頭' } }, 'kmb', { stops: near }), 2);
});
test('buses are found along the whole route from its arrivals', () => {
  const stop = (lat) => ({ location: { lat, lng: 114.10 } });
  const db = {
    routes: { r: { stops: { kmb: ['a', 'b', 'c', 'd', 'e'] }, journeyMinutes: 8 } }, // 2 minutes a stop.
    stops: { a: stop(22.30), b: stop(22.31), c: stop(22.32), d: stop(22.33), e: stop(22.34) },
  };
  const ride = { op: 'kmb', route: '1', routeKey: 'r', boardPosition: 3 };
  const min = 60_000;
  const at = (...rows) => rows.map((times, position) => ({ position, times: times.map((time) => time * min) }));
  // Stops are 2 minutes apart. One bus reaches d in 1 minute; the one behind it reaches c in 1.
  const two = at([], [], [1], [1, 3], [3, 5]);
  const vehicles = T.vehiclesOnRoute(two, ride, db, 0);
  assert.equal(vehicles.length, 2);
  close(vehicles[0].position, 2.5, 0.00001);
  assert.equal(vehicles[0].isNext, true);
  assert.equal(vehicles[0].minutes, 1);
  assert.equal(vehicles[0].isLive, true);
  close(vehicles[1].position, 1.5, 0.00001);
  assert.equal(vehicles[1].isNext, false);
  assert.equal(vehicles[1].minutes, 3); // The one after: its own time at the rider's stop.
  // A time already gone still places the bus: between the stops its times fall between.
  const past = T.vehiclesOnRoute(at([], [-4], [-1], [3], [5]), ride, db, 0);
  close(past[0].position, 2.25, 0.00001);
  // Choosing another stop only changes the times read off: the buses stay where they are.
  const later = T.vehiclesOnRoute(two, { ...ride, boardPosition: 4 }, db, 0);
  assert.deepEqual(later.map((vehicle) => vehicle.position), vehicles.map((vehicle) => vehicle.position));
  assert.deepEqual(later.map((vehicle) => vehicle.minutes), [3, 5]);
  // Past the rider's stop: no time to wait for, and it is not the next bus.
  const gone = T.vehiclesOnRoute(two, { ...ride, boardPosition: 1 }, db, 0);
  assert.deepEqual(gone.map((vehicle) => vehicle.minutes), [null, null]);
  assert.equal(gone.some((vehicle) => vehicle.isNext), false);
  // With no stop chosen every bus is still shown.
  assert.equal(T.vehiclesOnRoute(two, { ...ride, boardPosition: null }, db, 0).length, 2);
  // Stops take as long as the times say, not an even share of the journey: 6 minutes from c to d.
  const slow = T.vehiclesOnRoute(at([], [], [10, 20], [3, 16, 26], [5, 18, 28]), ride, db, 0);
  close(slow[0].position, 2.5, 0.00001);
  // Waiting at the start: not on the road yet. Timetable only: the operator is not following it.
  assert.deepEqual(T.vehiclesOnRoute(at([5], [7], [9], [11], [13]), ride, db, 0), []);
  const timetabled = [0, 1, 2, 3, 4].map((position) => ({ position, times: [], planned: [(position * 2 - 3) * min] }));
  assert.deepEqual(T.vehiclesOnRoute(timetabled, ride, db, 0), []);
  // A bus timed unevenly (later at c than at d) stays one bus, not two.
  const uneven = T.vehiclesOnRoute(at([], [1], [1, 6], [3, 4], [5, 6]), ride, db, 0);
  assert.equal(uneven.length, 2);
  assert.deepEqual(T.vehiclesOnRoute([{ position: 1, times: [] }], ride, db, 0), []);
  assert.deepEqual(T.vehiclesOnRoute(two, { ...ride, routeKey: 'none' }, db, 0), []);
});
test('KMB positions follow the stops, not the sequence, when a stop is missing from the route data', () => {
  const order = E.kmbPositions(['a', 'b', 'x', 'c', 'a'], ['a', 'b', 'c', 'a']);
  assert.deepEqual([...order], [[1, 0], [2, 1], [4, 2], [5, 3]]);
});
test('the advice on a plan comes from its own numbers', () => {
  const t = (zh, en) => en, line = (ride) => ride.route, min = 60_000;
  const ride = (route, liveDeparture = null, isProjected = false) => ({ type: 'ride', op: 'kmb', route, transferMinutes: 0, rideMinutes: 10, waitMinutes: 2, liveDeparture, isProjected });
  const walk = (meters) => ({ type: 'walk', minutes: meters / 80, meters });
  const quick = { legs: [walk(80), ride('1A', 3 * min)] }, slow = { legs: [walk(480), ride('2'), ride('6')] };
  const advice = T.planAdvice([quick, slow], t, line, 0);
  assert.match(advice, /^Best option: \d+ min, direct, 80 m on foot\. 1A leaves in 3 min\. /);
  assert.match(advice, /\d+ min faster, 1 fewer change, 400 m less walking\.$/);
  // A time worked out from the headway is no live departure, and with one option there is no comparing.
  assert.equal(T.planAdvice([{ legs: [ride('1A', 3 * min, true)] }], t, line, 0).includes('leaves'), false);
  assert.equal(T.planAdvice([quick], t, line, 0).includes('Against'), false);
  assert.equal(T.planAdvice([], t, line, 0), null);
});
test('the bus glides around a corner and turns to follow the road', () => {
  const start = { lat: 22.30, lng: 114.17 }, corner = { lat: 22.30, lng: 114.175 };
  const finish = { lat: 22.305, lng: 114.175 };
  const track = T.routeTrack([start, corner, finish], [start, finish]);
  const current = { position: 0, ...T.placeOnTrack(track, 0) };
  const target = { position: 1, ...T.placeOnTrack(track, 1) };
  const incoming = T.glideOnTrack(track, current, target, 0.25);
  const outgoing = T.glideOnTrack(track, current, target, 0.75);
  close(incoming.location.lat, start.lat);
  close(incoming.heading, 90);
  close(outgoing.location.lng, finish.lng);
  close(outgoing.heading, 0);
  assert.ok(T.meters(incoming.location, { lat: start.lat + (finish.lat - start.lat) * 0.25, lng: start.lng + (finish.lng - start.lng) * 0.25 }) > 100);
});

test('a route is followed by progress along it, even over the same road twice', () => {
  const at = (lat, lng) => ({ lat, lng });
  // Out along a road and back along the same road: a circular route.
  const line = [at(22.30, 114.10), at(22.31, 114.10), at(22.32, 114.10), at(22.32, 114.101), at(22.31, 114.1001), at(22.30, 114.1001)];
  const stops = [at(22.30, 114.10), at(22.31, 114.10), at(22.32, 114.10), at(22.31, 114.1001), at(22.30, 114.1001)];
  const track = T.routeTrack(line, stops);
  assert.ok(track.passes.every((pass, index) => index === 0 || pass.at > track.passes[index - 1].at));
  const out = T.placeOnTrack(track, 0.5), back = T.placeOnTrack(track, 3.5);
  close(out.location.lat, 22.305, 0.0002);
  close(back.location.lat, 22.305, 0.0002); // The same stretch of road...
  close(out.heading, 0, 1);
  close(Math.abs(back.heading), 180, 1); // ...but running the other way.
  const road = T.trackBetween(track, 1, 3);
  close(road[0].lat, 22.31, 0.0001);
  assert.ok(road.length > 3, 'keeps the bends between the stops');
  assert.equal(T.routeTrack(null, stops), null);
  // The wrong direction's line reaches few of the stops, so it is not used. A stop past the end is joined on.
  const away = at(23, 115);
  assert.equal(T.routeTrack(line, [stops[0], stops[1], away, away, away]), null);
  const short = T.routeTrack(line, [...stops, ...stops.slice(-1), ...stops.slice(-1), ...stops.slice(-1), away]);
  assert.deepEqual(T.roadBetween(short, 0, short.passes.length - 1).at(-1), away);
  assert.equal(T.roadBetween(short, 0, 1).includes(away), false);
  assert.equal(T.routeTrack(line, [at(23, 115), at(23.1, 115)]), null);
  const gap = T.routeTrack(line, [stops[0], null, stops[2]]);
  close(T.placeOnTrack(gap, 1).location.lat, 22.31, 0.0002); // A stop it can't place is passed through.
});
test('stop suggestions run from near to far', () => {
  const site = (zh, en, lat, visits = 1) => ({ name: { zh, en }, platforms: [{ lat, lng: 114.17 }], visits: Array(visits) });
  const index = [site('旺角站', 'Mong Kok Station', 22.32, 3), site('旺角東站', 'Mong Kok East', 22.33, 9), site('中環', 'Central', 22.28)];
  const near = { lat: 22.331, lng: 114.17 };
  assert.deepEqual(T.matchingSites('旺角', index, near).map((m) => m.site.name.zh), ['旺角東站', '旺角站']);
  assert.ok(T.matchingSites('mong', index, near)[0].distance < 200);
  assert.deepEqual(T.matchingSites('旺角', index, null).map((m) => m.site.name.zh), ['旺角東站', '旺角站']);
  assert.deepEqual(T.matchingSites('  ', index, near), []);
  assert.equal(T.matchingSites('站', index, near, undefined, 1).length, 1);
});
test('joint routes take the line of KMB\'s direction, whichever operator is on screen', async () => {
  const asked = [];
  globalThis.fetch = async (url) => { asked.push(url); return { ok: false }; };
  await P.loadShape({ gtfsId: 1497, bound: { ctb: 'O', kmb: 'I' } }, 'ctb');
  await P.loadShape({ gtfsId: 25, bound: { ctb: 'O' } }, 'ctb');
  assert.match(asked[0], /1497-I\.json$/);
  assert.match(asked[1], /25-O\.json$/);
});
test('stops and places mix from near to far, once each', () => {
  const merged = P.mergeSuggestions([{ name: '旺角站', meters: 300 }, { name: '朗豪坊', meters: 90 }], [{ name: '朗豪坊', meters: 80 }, { name: '遠方' }, { name: '始創中心', meters: 150 }]);
  assert.deepEqual(merged.map((item) => item.name), ['朗豪坊', '始創中心', '遠方', '旺角站']);
  assert.equal(merged[0].meters, 80);
  assert.equal(P.mergeSuggestions([{ name: 'a', meters: 1 }, { name: 'b', meters: 2 }], [], 1).length, 1);
  // Shops stay on the list however many stops match, near or not, and either kind fills spare room.
  const stops = Array.from({ length: 8 }, (_, index) => ({ name: `站${index}`, meters: index }));
  const shops = Array.from({ length: 5 }, (_, index) => ({ name: `店${index}` }));
  const both = P.mergeSuggestions(stops, shops);
  assert.equal(both.length, 10);
  assert.equal(both.filter((item) => item.name.startsWith('店')).length, 5);
  assert.equal(P.mergeSuggestions(stops, shops.slice(0, 1)).length, 9);
  assert.equal(P.mergeSuggestions(stops.slice(0, 1), shops).length, 6);
});
test('area words', () => {
  assert.equal(P.cleanArea('朗豪坊附近'), '朗豪坊');
  assert.equal(P.cleanArea('附近'), '附近');
  assert.ok(P.isNearby('附近') && !P.isNearby('旺角'));
});

test('the AI sees the conversation and what is on screen', () => {
  assert.equal(A.chatMessage('去中環'), '去中環');
  const message = A.chatMessage('平啲嘅', null, {
    talk: ['Rider: 旺角拉麵', 'App: Showed 拉麵 around 旺角: 一生懸麵'],
    search: { want: '拉麵', query: '拉麵', area: '旺角', extra: null, shops: ['一生懸麵', '樸一拉麵'] },
  });
  assert.match(message, /Conversation so far\nRider: 旺角拉麵/);
  assert.match(message, /Area: 旺角/);
  assert.match(message, /2\. 樸一拉麵/);
  assert.match(message, /Rider says: 平啲嘅$/);
  const trip = { origin: null, destination: '中環', preference: 'fastest' };
  assert.match(A.chatMessage('少行路', trip), /Start: current location\nDestination: 中環/);
  const last = A.chatMessage('拉麵', null, { question: '想食咩？', mayAsk: false });
  assert.match(last, /You just asked: 想食咩？/);
  assert.match(last, /may not ask anything more/);
});

test('personal AI verifies the key and counts usage from chat and exploration', async (context) => {
  const sent = [], costs = [];
  let unauthorized = 0;
  const key = 'sk-test-visitor';
  const assistant = A.personalAI(key, (cost) => costs.push(cost), () => unauthorized++);
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    sent.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    if (sent.length === 1) return reply(200, { verified: true });
    if (sent.length === 2) return reply(200, { reply: '{"destination":"中環"}', costCny: 0.015 });
    if (sent.length === 3) return reply(200, { suggestions: [], costCny: 0.025 });
    if (sent.length === 4) return reply(502, { error: 'Failed', costCny: 0.005 });
    return reply(401, { error: 'Rejected' });
  });
  await A.verifyAIKey(key);
  await assistant.chat('去中環');
  await assistant.explore({ name: '中環' }, 'food', 'zh-Hant');
  await assert.rejects(assistant.chat('去中環'), { status: 502 });
  await assert.rejects(assistant.chat('去中環'), { status: 401 });
  assert.deepEqual(sent.slice(0, 3).map(({ url, body }) => ({ url, body })), [
    { url: 'api/ai', body: { task: 'verify' } },
    { url: 'api/ai', body: { task: 'chat', message: '去中環' } },
    { url: 'api/explore/ai', body: { area: '中環', category: 'food', locale: 'zh-Hant' } },
  ]);
  assert.ok(sent.every(({ headers }) => headers.Authorization === `Bearer ${key}`));
  assert.deepEqual(costs, [0.015, 0.025, 0.005]);
  assert.equal(unauthorized, 1);
});

test('arriving by a time leaves early enough for the longest wait', () => {
  const by = noon + 3_600_000, [journey] = T.planArriving(network, at('A'), at('C'), by, noon);
  const waits = T.rides(journey).reduce((total, ride) => total + ride.waitMinutes, 0);
  assert.equal(journey.arriveBy, by);
  close(journey.departure, by - (T.totalMinutes(journey) + waits) * 60_000, 1);
  assert.ok(waits > 0 && T.arrivalTime(journey) < by && !T.arrivesLate(journey));
});

test('a trip that cannot arrive in time leaves now, shows as late, and ranks after one on time', async () => {
  const [late] = T.planArriving(network, at('A'), at('C'), noon + 60_000, noon);
  assert.equal(late.departure, noon);
  assert.ok(T.arrivesLate(late));
  const onTime = { ...late, departure: noon - 7_200_000 };
  assert.ok(T.score(onTime, 'fastest') < T.score(late, 'fastest'));
  assert.equal((await T.retime(late, async () => null)).arriveBy, late.arriveBy);
});

test('no service at the time means no journey, leaving or arriving', () => {
  const late = Date.parse('2026-11-04T23:30:00+08:00');
  assert.deepEqual(T.planArriving(network, at('G'), at('H'), noon + 3_600_000, noon).filter((journey) => journey.legs.some((leg) => leg.route === 'N1')), []);
  assert.ok(T.plan(network, at('G'), at('H'), late).some((journey) => T.rides(journey).some((ride) => ride.route === 'N1')));
});

test('rail has no timetable but still stops overnight', () => {
  const rides = (when) => T.plan(network, at('AAA'), at('BBB'), Date.parse(when)).filter((journey) => T.rides(journey).length);
  assert.equal(rides('2026-11-04T03:00:00+08:00').length, 0);
  assert.ok(rides('2026-11-04T08:00:00+08:00').length > 0);
  assert.ok(rides('2026-11-04T05:20:00+08:00').length > 0); // The first train is only minutes away.
});

test('the route keypad only offers what leads to a route', () => {
  assert.deepEqual([...T.nextRouteKeys(db, '')].sort(), ['1', '2', 'N', 'X', 'Z']);
  assert.deepEqual([...T.nextRouteKeys(db, 'n')], ['1']);
  assert.equal(T.nextRouteKeys(db, 'N1').size, 0);
  assert.equal(T.nextRouteKeys(db, '9').size, 0);
});

test('small talk comes back as words, not a trip', () => {
  assert.deepEqual(A.decodeChat('{"kind":"say","text":"我可以幫你規劃路線。"}'), { say: '我可以幫你規劃路線。' });
  assert.equal(A.decodeChat('{"kind":"say","text":" "}'), null);
  assert.match(A.CHAT_PROMPT, /"kind": "say"/);
});

test('a route is one entry, with its other direction and special services behind it', () => {
  const stop = (lat) => ({ name: { zh: `${lat}`, en: `${lat}` }, location: { lat, lng: 114 } });
  const route = (number, co, serviceType, bound, stops, gtfsId = null) => ({
    route: number, co: [co], orig: { zh: stops[0], en: stops[0] }, dest: { zh: stops.at(-1), en: stops.at(-1) }, serviceType, stops: { [co]: stops }, bound: { [co]: bound }, gtfsId,
  });
  const many = T.normalizeDB({
    routeList: {
      out: route('96', 'kmb', '1', 'O', ['a', 'm', 'b']), back: route('96', 'kmb', '1', 'I', ['b2', 'm2', 'a2']),
      special: route('96', 'kmb', '2', 'O', ['c', 'b']), elsewhere: route('96', 'gmb', '1', 'O', ['x', 'y']), far: route('77', 'gmb', '1', 'O', ['x', 'y']),
      far2: route('77', 'gmb', '1', 'O', ['p', 'q']), loop: route('8', 'kmb', '1', 'O', ['a', 'b', 'a']),
    },
    stopList: { a: stop(22.3), a2: stop(22.3005), m: stop(22.35), m2: stop(22.3505), b: stop(22.4), b2: stop(22.4005), c: stop(22.25), x: stop(22.5), y: stop(22.55), p: stop(22.1), q: stop(22.15) },
  });
  assert.deepEqual(T.searchRoutes(many, '96').map(({ key }) => key), ['out', 'elsewhere']);
  assert.equal(T.searchRoutes(many, '77').length, 2); // A number reused far away is another route.
  const out = many.routes.out, back = many.routes.back, special = many.routes.special;
  assert.equal(T.routeWays(many, out).opposite, back);
  assert.equal(T.routeWays(many, back).opposite, out);
  assert.deepEqual(T.routeWays(many, out).variants, [out, special]);
  assert.equal(T.routeWays(many, special).opposite, back);
  assert.equal(T.routeWays(many, many.routes.loop).opposite, null);
  assert.equal(T.closestPosition(back, 'kmb', many.stops.m.location, many), 1);
  assert.equal(T.closestPosition(back, 'kmb', many.stops.x.location, many), null);
});

test('changing the destination in words keeps the start', () => {
  const trip = { origin: '旺角', destination: '沙田', preference: 'fastest' };
  assert.deepEqual(A.parseFollowUp('改去中環', trip), { origin: '旺角', destination: '中環', preference: 'fastest' });
  assert.equal(A.parseTrip('轉去機場').origin, null);
});

test('the AI reads sentences and proposes lines, and has no other task', () => assert.deepEqual(Object.keys(A.PROMPTS).sort(), ['chat', 'intent', 'route']));

test('lines the AI names become a journey with stops and times from the route data', () => {
  const direct = T.journeyAlong(network, [{ mode: 'bus', route: '1' }], at('A'), at('C'), noon);
  assert.deepEqual(direct.legs, T.search(network, at('A'), at('C'), noon)[0].legs);
  assert.equal(direct.byAI, true);
  const changing = T.journeyAlong(network, [{ mode: 'bus', route: '1' }, { mode: 'bus', route: '2' }], at('A'), at('F'), noon);
  assert.deepEqual(changing.legs, T.search(network, at('A'), at('F'), noon)[0].legs);
  // A wrong mode still finds the route by its number, and an MTR line goes by any of its names.
  assert.equal(T.rides(T.journeyAlong(network, [{ mode: 'minibus', route: ' 1 ' }], at('A'), at('C'), noon))[0].op, 'kmb');
  const rail = T.journeyAlong(network, [{ mode: 'mtr', route: 'xyl' }, { mode: 'mtr', route: 'ZZL' }], at('AAA'), at('CCC'), noon);
  assert.equal(T.rides(rail)[1].transferMinutes, 3);
  assert.equal(T.mtrLine('荃灣線'), 'TWL');
  assert.equal(T.mtrLine('Tsuen Wan Line'), 'TWL');
  assert.equal(T.mtrLine('twl'), 'TWL');
  assert.equal(T.mtrLine('968'), null);
});

test('a plan is dropped when a line does not exist, is not running or does not meet the next', () => {
  const along = (routes, from, to, when = noon) => T.journeyAlong(network, routes.map((route) => ({ mode: 'bus', route })), at(from), at(to), when);
  assert.equal(along(['99'], 'A', 'C'), null);
  assert.equal(along(['2', '1'], 'A', 'F'), null);
  assert.equal(along(['1'], 'A', 'F'), null, 'route 1 ends too far from F');
  assert.equal(along(['N1'], 'G', 'H'), null);
  assert.ok(along(['N1'], 'G', 'H', Date.parse('2026-11-04T23:30:00+08:00')));
  assert.equal(along([], 'A', 'C'), null);
  assert.equal(along(['1', '1', '1', '1'], 'A', 'C'), null);
});

test('the AI\'s plans lead only when they hold up against the search', () => {
  const slowRoute = { route: 'S9', co: ['kmb'], orig: { en: 'A', zh: '甲' }, dest: { en: 'C', zh: '丙' }, serviceType: '1', stops: { kmb: ['A', 'C'] }, bound: { kmb: 'O' }, jt: '90' };
  const wider = T.buildNetwork(T.normalizeDB({ ...raw, routeList: { ...raw.routeList, slow: slowRoute } }));
  const baseline = T.plan(wider, at('A'), at('C'), noon);
  const propose = (...routes) => T.planProposed(wider, routes.map((route) => [{ mode: 'bus', route }]), at('A'), at('C'), { departure: noon, baseline });
  assert.deepEqual(propose('1', '99').map((journey) => [T.rides(journey)[0].route, journey.byAI]), [['1', true]]);
  assert.deepEqual(propose('S9'), [], 'real, but far slower than the search');
  assert.deepEqual(propose('99'), []);
  assert.equal(propose('S9', '1').length, 1);
  // A short trip still offers the walk the search found.
  const near = T.plan(network, at('B'), at('C'), noon);
  const short = T.planProposed(network, [[{ mode: 'bus', route: '1' }]], at('B'), at('C'), { departure: noon, baseline: near });
  assert.deepEqual(short.map(T.journeyID).sort(), near.map(T.journeyID).sort());
  const arriveBy = noon + 3 * 3600_000;
  const [timed] = T.planProposed(network, [[{ mode: 'bus', route: '1' }]], at('A'), at('C'), { departure: noon, arriveBy });
  assert.equal(timed.arriveBy, arriveBy);
  assert.ok(T.arrivalTime(timed) <= arriveBy && timed.departure > noon);
});

test('the AI is told names and line numbers near each end, never coordinates', () => {
  const facts = T.tripFacts(network, db, at('A'), at('F'), noon);
  assert.deepEqual(facts, { start: { stations: [], lines: { bus: ['1'] } }, end: { stations: [], lines: { bus: ['2'] } }, direct: {} });
  assert.deepEqual(T.tripFacts(network, db, at('A'), at('C'), noon).direct, { bus: ['1'] });
  const rail = T.tripFacts(network, db, at('AAA'), at('CCC'), noon);
  assert.deepEqual(rail.start, { stations: ['站一'], lines: { mtr: ['XYL'] } });
  assert.deepEqual(rail.end, { stations: ['站三'], lines: { mtr: ['ZZL'] } });
  assert.deepEqual(T.tripFacts(network, db, at('G'), at('H'), noon).direct, {}, 'the night bus is not running at noon');
  assert.deepEqual(T.tripFacts(network, db, at('G'), at('H'), Date.parse('2026-11-04T23:30:00+08:00')).direct, { bus: ['N1'] });
  const message = A.routeMessage({ from: '我的位置', to: '站三', facts: rail, preference: 'fastest', when: 'Leaving: Wednesday 12:00' });
  assert.match(message, /Start: 我的位置\nStations nearby: 站一\nLines nearby: MTR XYL\n/);
  assert.match(message, /Direct lines: none\nLeaving: Wednesday 12:00\nPreference: fastest$/);
  assert.doesNotMatch(message, /\d+\.\d/);
});

test('the AI\'s plans are read as lines only', async () => {
  const reply = '```json\n{"plans":[{"legs":[{"mode":"bus","route":968,"to":"銅鑼灣"}]},{"legs":[{"mode":"mtr","route":" TWL "},{"mode":"mtr","route":"ISL"}]},{"legs":[]},{"legs":[{"mode":"bus"}]},{"legs":[{"route":"1"},{"route":"2"},{"route":"3"},{"route":"4"}]}]}\n```';
  assert.deepEqual(A.decodePlans(reply), [[{ mode: 'bus', route: '968' }], [{ mode: 'mtr', route: 'TWL' }, { mode: 'mtr', route: 'ISL' }]]);
  assert.deepEqual(A.decodePlans('{"plans": []}'), []);
  assert.equal(A.decodePlans('I would take the MTR.'), null);
  assert.equal(A.decodePlans('{"destination":"中環"}'), null);
  const sent = [];
  globalThis.fetch = async (url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ reply: '{"plans":[{"legs":[{"mode":"bus","route":"1"}]}]}' }) }; };
  assert.deepEqual(await A.personalAI('sk-test-visitor').route('Start: 甲'), [[{ mode: 'bus', route: '1' }]]);
  assert.deepEqual(sent, [{ task: 'route', message: 'Start: 甲' }]);
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ reply: '{"kind":"say","text":"hi"}' }) });
  await assert.rejects(A.personalAI('sk-test-visitor').route('Start: 甲'));
});

test('walks take Google\'s distance and time where it has them, and the rest keep the estimate', async () => {
  const journey = T.search(network, at('A'), at('F'), noon)[0], origin = { lat: 22.299, lng: 114.17 }, destination = { lat: 22.351, lng: 114.17 };
  const ends = T.walkEnds({ ...journey, legs: [{ type: 'walk', meters: 111, minutes: 1.9, to: 'A' }, ...journey.legs, { type: 'walk', meters: 111, minutes: 1.9, to: null }] }, origin, destination, db);
  assert.deepEqual(ends, [[origin, at('A')], null, [at('C'), at('E')], null, [at('F'), destination]]);
  globalThis.fetch = async (url, options) => {
    const { from } = JSON.parse(options.body);
    return from.lat === at('C').lat ? { ok: true, json: async () => ({ points: [], meters: 90, seconds: 150 }) } : { ok: false };
  };
  await Promise.all([P.googleWalk(at('C'), at('E')), P.googleWalk(at('F'), destination)]);
  assert.deepEqual(P.knownWalkTime(at('C'), at('E')), { meters: 90, minutes: 2.5 });
  assert.equal(P.knownWalkTime(at('F'), destination), null);
  const walked = T.withWalkTimes(journey, T.walkEnds(journey, at('A'), at('F'), db), P.knownWalkTime);
  assert.deepEqual([walked.legs[1].meters, walked.legs[1].minutes, walked.legs[1].walkFromMap], [90, 2.5, true]);
  close(T.totalMinutes(walked) - T.totalMinutes(journey), 2.5 - journey.legs[1].minutes);
  assert.equal(T.withWalkTimes(walked, T.walkEnds(walked, at('A'), at('F'), db), P.knownWalkTime), walked, 'nothing new, nothing changes');
  assert.equal(T.withWalkTimes(journey, T.walkEnds(journey, at('A'), at('F'), db), () => null), journey);
});

test('Google transit joins adjacent walking instructions and matches the boarding direction', async () => {
  const { googleJourneys } = await import('../js/google-transit.js');
  const point = (at) => ({ latLng: { latitude: at.lat, longitude: at.lng } });
  const walk = { travelMode: 'WALK', staticDuration: '330s', distanceMeters: 300,
    startLocation: point(at('A')), endLocation: point(at('A')) };
  const trip = { travelMode: 'TRANSIT', transitDetails: {
    headsign: '丙', stopCount: 2, transitLine: { nameShort: '1', agencies: [{ name: 'Kowloon Motor Bus' }] },
    stopDetails: {
      departureStop: { name: '甲', location: point(at('A')) }, arrivalStop: { name: '丙', location: point(at('C')) },
      departureTime: new Date(noon + 15 * 60_000).toISOString(), arrivalTime: new Date(noon + 35 * 60_000).toISOString(),
    },
  } };
  const [long, short] = googleJourneys([{ legs: [{ steps: [walk, walk, trip] }] }, { legs: [{ steps: [walk, trip] }] }], db, noon);
  assert.equal(long.legs[0].minutes, 11);
  assert.equal(T.fitsWalkLimit(long), false);
  assert.equal(T.fitsWalkLimit(short), true);
  assert.deepEqual(T.rides(short).map((r) => [r.routeKey, r.boardPosition, r.alightPosition]), [['r1', 0, 2]]);
  assert.equal(T.rankTripOptions([long, short], 'lessWalking')[0], short);
  assert.deepEqual(T.rankTripOptions([short, { ...short }], 'lessWalking'), [short]);
  assert.equal(T.totalMinutes(short), 35);
  assert.equal(T.journeyPath(short, at('A'), at('C'), db).segments[1].providerShape, true);
  const [withPrice] = googleJourneys([{
    legs: [{ steps: [trip] }],
    travelAdvisory: { transitFare: { currencyCode: 'HKD', units: '13', nanos: 600_000_000 } },
  }], db, noon);
  assert.equal(T.journeyFare(withPrice, db), 1360);
  assert.equal(T.journeyFare(withPrice, db, null, 'child'), null);
  assert.equal(T.journeyFare(short, db), null);
});

test('journey fare uses the boarding stop and day and combines rail within the same interchange', () => {
  const faresDB = T.normalizeDB({
    ...raw, holidays: ['20261104'],
    routeList: { r1: { ...raw.routeList.r1, fares: ['8.1', '6.2'], faresHoliday: ['12.4', '9.7'] } },
  });
  const ride = (op, route, boardStopID, alightStopID) => ({
    type: 'ride', op, route, boardStopID, alightStopID, rideMinutes: 8, waitMinutes: 0, transferMinutes: 0,
  });
  const bus = { ...ride('kmb', '1', 'B', 'C'), routeKey: 'r1', boardPosition: 1 };
  const railFares = { mtr: { 'CEN>MOK': 1360, 'CEN>ADM': 490, 'ADM>MOK': 1230 } };
  const train = ride('mtr', 'ISL', 'CEN', 'ADM'), change = ride('mtr', 'TWL', 'ADM', 'MOK');
  const trip = (legs, departure = noon) => ({ legs, departure });
  assert.equal(T.journeyFare(trip([bus, train, change]), faresDB, railFares), 2330);
  assert.equal(T.journeyFare(trip([bus], noon + 86_400_000), faresDB), 620);
  assert.equal(T.journeyFare(trip([bus, train]), faresDB), null);
  assert.equal(T.journeyFare(trip([{ type: 'walk', minutes: 8 }]), faresDB), 0);
});

test('fare profiles price each paid trip and exempt airport routes from the government scheme', () => {
  const faresDB = T.normalizeDB({ ...raw, routeList: {
    r1: { ...raw.routeList.r1, fares: ['12.2', '1.8'] },
    airport: { ...raw.routeList.r1, route: 'A21', co: ['ctb'], stops: { ctb: ['A', 'B', 'C'] }, fares: ['34.6', '34.6'] },
  } });
  const ride = { type: 'ride', rideMinutes: 10, waitMinutes: 0, transferMinutes: 0 };
  const bus = { ...ride, op: 'kmb', routeKey: 'r1', boardStopID: 'A', boardPosition: 0 };
  const minFare = { ...bus, boardStopID: 'B', boardPosition: 1 };
  const airport = { ...bus, op: 'ctb', routeKey: 'airport' };
  const train = { ...ride, op: 'mtr', route: 'TWL', boardStopID: 'ADM', alightStopID: 'MOK' };
  const lightRail = { ...ride, op: 'lightRail', boardStopID: 'LR920', alightStopID: 'LR265' };
  const trip = (...legs) => ({ legs, departure: noon });
  assert.equal(T.journeyFare(trip(bus, train), faresDB, { mtr: { 'ADM>MOK': 650 } }, 'child'), 1260);
  assert.equal(T.journeyFare(trip(bus, train), faresDB, { mtr: { 'ADM>MOK': 650 } }, 'student'), 1870);
  assert.equal(T.journeyFare(trip(bus, minFare, lightRail), faresDB, { lightRail: { 'LR920>LR265': 510 } }, 'disability'), 620);
  assert.equal(T.journeyFare(trip(airport), faresDB, null, 'joyyou60'), 3460);
  assert.equal(T.journeyFare(trip(airport), faresDB, null, 'joyyou65'), 1730);
});

test('local planning expands a station search after a nearby stop gives no route', () => {
  const point = (offset) => ({ lat: 22.31, lng: 114.18 + offset / 103_000 });
  const stop = (offset) => ({ location: point(offset) });
  const route = (number, stops) => ({ route: number, operators: ['kmb'], stops: { kmb: stops }, journeyMinutes: 12 });
  const db = {
    stops: { a: stop(100), x: stop(-2300), b: stop(820), y: stop(6200) }, holidays: [], serviceDayMap: {},
    routes: { wrong: route('1', ['a', 'x']), right: route('2', ['b', 'y']) },
  };
  assert.deepEqual(T.plan(T.buildNetwork(db), point(0), point(6200), noon), []);
  const [result] = T.planLocal(T.buildNetwork(db), point(0), point(6200), noon, 'lessWalking');
  assert.equal(T.rides(result)[0].route, '2');
  assert.equal(T.fitsWalkLimit(result), false);
});

test('local planning searches for a preferred MTR route pruned by faster buses', () => {
  const routes = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`bus${i}`, {
    route: String(i), operators: ['kmb'], stops: { kmb: ['A', 'C'] }, journeyMinutes: 6 + i,
  }]));
  routes.rail = { route: 'TWL', operators: ['mtr'], stops: { mtr: ['A', 'C'] }, journeyMinutes: 38 };
  const local = T.buildNetwork({ ...db, routes });
  const options = (mode) => T.planLocal(local, at('A'), at('C'), noon, 'lessWalking', mode);
  assert.ok(options('all').every((trip) => T.rides(trip)[0].op === 'kmb'));
  const preferred = options('mtr');
  assert.equal(T.rides(preferred[0])[0].op, 'mtr');
  assert.ok(preferred.some((trip) => T.rides(trip)[0].op === 'kmb'));
  assert.equal(T.rides(options('bus')[0])[0].op, 'kmb');
  assert.deepEqual(
    T.planLocal(network, at('A'), at('C'), noon, 'lessWalking', 'mtr'),
    T.planLocal(network, at('A'), at('C'), noon, 'lessWalking'),
  );
});

test('the default ranking prefers a shorter walk over saving a few minutes', () => {
  const [base] = T.plan(network, at('A'), at('C'), noon);
  const option = (id, walk, ride) => ({ ...base, id, legs: [
    { type: 'walk', minutes: walk, meters: walk * 70 },
    { ...T.rides(base)[0], rideMinutes: ride },
  ] });
  const short = option('short', 4, 24), fast = option('fast', 9, 14), tooFar = option('too-far', 17, 1);
  assert.deepEqual(T.rankTripOptions([tooFar, fast, short], 'lessWalking'), [short, fast, tooFar]);
  assert.deepEqual(T.rankTripOptions([tooFar, fast, short], 'fastest'), [fast, short, tooFar]);
  const sameEffort = option('similar', 5, 14);
  assert.deepEqual(T.rankTripOptions([short, sameEffort], 'lessWalking'), [sameEffort, short]);
});

test('less walking can rank a short station transfer ahead of a longer direct trip', () => {
  const [base] = T.plan(network, at('A'), at('C'), noon);
  const [ride] = T.rides(base);
  const walk = (minutes) => ({ type: 'walk', minutes, meters: minutes * 75 });
  const direct = { ...base, id: 'direct', legs: [walk(6), { ...ride, rideMinutes: 40 }, walk(1)] };
  const transfer = { ...base, id: 'transfer', legs: [
    walk(2), { ...ride, rideMinutes: 5 }, walk(2), { ...ride, rideMinutes: 5 }, walk(1),
  ] };
  assert.deepEqual(T.rankTripOptions([direct, transfer], 'lessWalking'), [transfer, direct]);
  assert.deepEqual(T.rankTripOptions([direct, transfer], 'fewerTransfers'), [direct, transfer]);
});

test('a changed ETA that misses a Google connection invalidates the itinerary', async () => {
  const [first] = T.rides(T.plan(network, at('A'), at('C'), noon)[0]);
  const second = { ...first, route: '2', scheduledDeparture: noon + 25 * 60_000 };
  const journey = { departure: noon, provider: 'google', legs: [
    { ...first, scheduledDeparture: noon }, second,
  ] };
  const updated = await T.retime(journey, (ride) => Promise.resolve(ride.route === '1' ? [{ date: noon + 15 * 60_000 }] : null));
  assert.equal(updated.missedConnection, true);
});

test('Transitous preserves walk durations and matches a scheduled bus to operator stops', async () => {
  const { transitousJourneys } = await import('../js/transitous.js');
  const place = (id, name) => ({ name, lat: at(id).lat, lon: at(id).lng });
  const board = place('A', '甲'), alight = place('C', '丙'), middle = place('B', '乙');
  const walk = (duration) => ({ mode: 'WALK', from: board, to: board, duration, distance: 320 });
  const ride = (number) => ({
    mode: 'BUS', from: board, to: alight, intermediateStops: [middle], tripId: 'bus-trip',
    agencyName: 'Kowloon Motor Bus', routeShortName: number, headsign: '丙',
    startTime: new Date(noon + 15 * 60_000).toISOString(), endTime: new Date(noon + 35 * 60_000).toISOString(),
  });
  const cancelled = { ...ride('1'), cancelled: true };
  const [matched, long, unmatched] = transitousJourneys([
    { legs: [walk(300), ride('1')] },
    { legs: [walk(330), walk(330), ride('1')] },
    { legs: [walk(180), ride('99')] },
    { legs: [walk(180), cancelled] },
    { legs: [walk(180)] },
  ], db, noon);
  assert.equal(matched.provider, 'transitous');
  assert.equal(T.totalMinutes(matched), 35);
  assert.equal(T.rides(matched)[0].routeKey, 'r1');
  assert.equal(T.fitsWalkLimit(long), false);
  assert.equal(T.rides(unmatched)[0].routeKey, undefined);
  assert.deepEqual(T.journeyPath(unmatched, at('A'), at('C'), db).segments[1].stopIDs, ['甲', '乙', '丙']);
  assert.equal(transitousJourneys([{ legs: [cancelled] }, { legs: [walk(300)] }], db, noon).length, 0);
});

test('the walking cap counts adjacent walk legs together across all planning sources', () => {
  const walk = (minutes) => ({ type: 'walk', minutes, meters: minutes * 75 });
  const [base] = T.plan(network, at('A'), at('C'), noon);
  const [ride] = T.rides(base);
  assert.equal(T.fitsWalkLimit({ ...base, legs: [walk(2), ride, walk(4), walk(9)] }), false);
  assert.equal(T.fitsWalkLimit({ ...base, legs: [walk(4), ride, walk(9)] }), true);
  assert.equal(T.fitsWalkLimit({ ...base, legs: [walk(4), walk(6), ride] }), true);
});

test('combined planning ranks across sources and keeps one version of matching stops', () => {
  const [base] = T.plan(network, at('A'), at('C'), noon);
  const [ride] = T.rides(base);
  const trip = (id, provider, boardStopID, walk, rideMinutes, measured = true) => ({
    ...base, id, provider, legs: [
      { type: 'walk', minutes: walk, meters: walk * 70, walkFromMap: measured },
      { ...ride, boardStopID, rideMinutes },
    ],
  });
  const googleLong = trip('google:long', 'google', 'A', 11, 10);
  const transitousLong = trip('transitous:long', 'transitous', 'A', 12, 9);
  const estimated = trip('local', null, 'A', 1, 9, false);
  const googleShort = trip('google:short', 'google', 'B', 5, 10);
  const transitousShort = trip('transitous:short', 'transitous', 'B', 4, 20);
  const missed = { ...trip('missed', 'transitous', 'C', 0, 2), missedConnection: true };
  const options = T.rankCombinedTripOptions([transitousLong, transitousShort, estimated, missed, googleLong, googleShort], 'lessWalking');
  assert.deepEqual(options, [googleShort, googleLong]);
  assert.deepEqual(options.filter(T.fitsWalkLimit), [googleShort]);
  assert.deepEqual(T.rankCombinedTripOptions([estimated], 'lessWalking'), [estimated]);
});

test('mode preference compares the main ride across providers, keeping short walks and on-time arrivals first', () => {
  const ride = (op, vehicleType, rideMinutes) => ({ type: 'ride', op, vehicleType, rideMinutes, waitMinutes: 0, transferMinutes: 0 });
  const trip = (id, legs) => ({ id, departure: noon, arriveBy: noon + 40 * 60_000, legs });
  const metro = ride('transit', 'SUBWAY', 20), bus = ride('transit', 'BUS', 12);
  const busTrip = trip('google:bus', [bus]);
  const mixed = trip('transitous:mixed', [ride('gmb', 'BUS', 3), metro]);
  const longWalk = trip('local:walk', [{ type: 'walk', minutes: 11 }, ride('mtr', null, 5)]);
  const late = trip('local:late', [ride('mtr', null, 41)]);
  const options = [busTrip, mixed, longWalk, late];
  assert.deepEqual(T.rankCombinedTripOptions(options, 'lessWalking', 5, 'mtr'), [mixed, busTrip, late, longWalk]);
  assert.deepEqual(T.rankCombinedTripOptions(options, 'lessWalking', 5, 'bus'), [busTrip, mixed, late, longWalk]);
});

test('sharing the boarding ETA across candidates still checks each train destination', async () => {
  const stop = (id, lat) => ({ name: { en: id, zh: id }, location: { lat, lng: 114.17 } });
  const route = (stops) => ({ route: 'EAL', co: ['mtr'], stops: { mtr: stops }, bound: { mtr: 'UT' } });
  const db = T.normalizeDB({
    stopList: { A: stop('A', 22.3), B: stop('B', 22.31), C: stop('C', 22.32), D: stop('D', 22.33) },
    routeList: { main: route(['A', 'B', 'C']), branch: route(['A', 'B', 'D']) },
  });
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return { ok: true, json: async () => ({ status: 1, data: { 'EAL-A': { UP: [
      { dest: 'D', plat: '1', time: '2026-11-04 12:01:00' },
      { dest: 'C', plat: '1', time: '2026-11-04 12:03:00' },
    ] } } }) };
  };
  try {
    const arrivals = E.liveArrivalCache(db, 'zh');
    const board = { routeKey: 'main', op: 'mtr', route: 'EAL', boardPosition: 0, boardStopID: 'A' };
    const [toB, toC] = await Promise.all([arrivals({ ...board, alightStopID: 'B' }), arrivals({ ...board, alightStopID: 'C' })]);
    assert.equal(requests, 1);
    assert.deepEqual(toB.map(({ date }) => date), [noon + 60_000, noon + 180_000]);
    assert.deepEqual(toC.map(({ date }) => date), [noon + 180_000]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
