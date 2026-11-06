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
  assert.deepEqual(A.parseTrip('由旺角去理大'), { origin: '旺角', destination: '理大', preference: 'fastest' });
  assert.deepEqual(A.parseTrip('去機場最快'), { origin: null, destination: '機場', preference: 'fastest' });
  assert.deepEqual(A.parseTrip('沙田到中環 唔想轉車'), { origin: '沙田', destination: '中環', preference: 'fewerTransfers' });
  assert.deepEqual(A.parseTrip('from Mong Kok to Central'), { origin: 'Mong Kok', destination: 'Central', preference: 'fastest' });
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
test('the AI ranks shops but can never lose or double one', () => {
  const a = { place: { name: 'A', rating: 4.5, ratings: 900, meters: 120.4, open: true, kind: '拉麵店' } };
  const b = { place: { name: 'B', meters: 50 } }, c = { place: { name: 'C' } };
  const message = A.rankMessage({ want: '拉麵', extra: '要平' }, [a, b]);
  assert.match(message, /1\. A: 拉麵店; rating 4\.5 from 900 people; open now; 120 m away/);
  assert.match(message, /Also wants: 要平/);
  const ranked = A.applyRanking('{"ranking":[{"number":2,"reason":"最近"},{"number":2,"reason":"重複"},{"number":9},{"number":1,"reason":""}]}', [a, b, c]);
  assert.deepEqual(ranked.map((s) => s.place.name), ['B', 'A', 'C']);
  assert.equal(ranked[0].reason, '最近');
  assert.deepEqual(A.applyRanking('not json', [a, b]), [a, b]);
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
test('the next bus is placed by its live arrival', () => {
  const db = {
    routes: { r: { stops: { kmb: ['a', 'b', 'c', 'd', 'e'] }, journeyMinutes: 8 } },
    stops: { a: { location: { lat: 22.30, lng: 114.10 } }, b: { location: { lat: 22.31, lng: 114.10 } }, c: { location: { lat: 22.32, lng: 114.10 } }, d: { location: { lat: 22.33, lng: 114.10 } }, e: { location: { lat: 22.34, lng: 114.10 } } },
  };
  const ride = { op: 'kmb', route: '1', routeKey: 'r', boardPosition: 3, liveDeparture: 180_000 };
  const coming = T.estimatedVehicle(ride, db, 0); // 2 minutes a stop, so 1.5 stops back.
  close(coming.location.lat, 22.315, 0.00001);
  assert.equal(coming.minutes, 3);
  assert.equal(coming.hasLeftTerminus, true);
  assert.equal(coming.hasPassedStop, false);
  close(coming.heading, 0, 0.01); // Due north, as the stops run.
  assert.equal(coming.isMinibus, false);
  const waiting = T.estimatedVehicle({ ...ride, liveDeparture: 3_600_000 }, db, 0);
  close(waiting.location.lat, 22.30, 0.00001);
  assert.equal(waiting.hasLeftTerminus, false);
  assert.equal(T.estimatedVehicle({ ...ride, liveDeparture: -60_000 }, db, 0).hasPassedStop, true);
  assert.equal(T.estimatedVehicle({ ...ride, liveDeparture: -600_000 }, db, 0), null);
  assert.equal(T.estimatedVehicle({ ...ride, liveDeparture: null }, db, 0), null);
  assert.equal(T.estimatedVehicle({ ...ride, isProjected: true }, db, 0), null);
  assert.equal(T.estimatedVehicle({ ...ride, op: 'mtr' }, db, 0), null);
});
test('bus lines follow the road between two stops', () => {
  const road = [{ lat: 22.30, lng: 114.10 }, { lat: 22.31, lng: 114.10 }, { lat: 22.31, lng: 114.11 }, { lat: 22.32, lng: 114.11 }];
  const clipped = T.clipLine(road, { lat: 22.3051, lng: 114.1 }, { lat: 22.315, lng: 114.11 });
  assert.equal(clipped.length, 4);
  assert.deepEqual(clipped[1], road[1]);
  assert.deepEqual(clipped[2], road[2]);
  assert.equal(T.clipLine(road, { lat: 22.5, lng: 114.3 }, road[3]), null);
  assert.equal(T.clipLine(null, road[0], road[1]), null);
  const on = T.pointOnLine(road, { lat: 22.3101, lng: 114.105 });
  close(on.location.lat, 22.31, 0.00001);
  close(on.heading, 90, 0.01); // Heading east along the second stretch.
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
test('stops and places mix from near to far, once each', () => {
  const merged = P.mergeSuggestions([{ name: '旺角站', meters: 300 }, { name: '朗豪坊', meters: 90 }], [{ name: '朗豪坊', meters: 80 }, { name: '遠方' }, { name: '始創中心', meters: 150 }]);
  assert.deepEqual(merged.map((item) => item.name), ['朗豪坊', '始創中心', '旺角站', '遠方']);
  assert.equal(merged[0].meters, 80);
  assert.equal(P.mergeSuggestions([{ name: 'a', meters: 1 }, { name: 'b', meters: 2 }], [], 1).length, 1);
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

test('the shared AI sends a task name and the text, never a prompt or a key', async () => {
  const sent = [];
  globalThis.fetch = async (url, options) => {
    sent.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ reply: 'Take the first.' }) };
  };
  await A.sharedAI().explain('Two options', 'en');
  assert.equal(sent[0].url, 'api/ai');
  assert.deepEqual(Object.keys(sent[0].body), ['task', 'message']);
  assert.equal(sent[0].body.task, 'explain_en');
  assert.ok(A.PROMPTS[sent[0].body.task]);
  assert.equal(sent[0].headers.Authorization, undefined);
  globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: '太頻繁' }) });
  await assert.rejects(A.sharedAI().chat('去中環'), /太頻繁/);
});
