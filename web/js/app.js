// The page itself: tabs, map, and the flows that tie the modules together.
import {
  OP_COLORS, OP_LABELS, MODES, buildStopIndex, exactSite, instruction, journeyID, journeyPath, lineColor, lineName,
  nameText, normalizeDB, partialSite, primaryMode, progressAt, retime, rides, score, searchRoutes, siteHasMode, stopName, stopsNear,
  totalMinutes, transfers, walkingMeters,
} from './transit.js';
import { fetchETA, liveArrivalCache } from './eta.js';
import { chatMessage, deepSeek, isCurrentLocation, normalizedOrigin, parseFollowUp, parseWish, searchMessage } from './ai.js';
import { cleanArea, districtAt, inHongKong, isNearby, lookupPlace, photonSearch, verifyPlaces, withinArea } from './places.js';

// MARK: Storage

const store = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(`hkt.${key}`);
      return value == null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(`hkt.${key}`, JSON.stringify(value)); } catch { /* Private mode: this visit only. */ }
  },
};

const HISTORY_LIMIT = 20, HISTORY_SHOWN = 4;
const history = {
  entries: (box) => store.get('history', {})[box] ?? [],
  add(box, text) {
    const value = (text ?? '').trim();
    if (!value) return;
    const all = store.get('history', {});
    all[box] = [value, ...(all[box] ?? []).filter((item) => item.toLowerCase() !== value.toLowerCase())].slice(0, HISTORY_LIMIT);
    store.set('history', all);
  },
  clear(box) {
    const all = store.get('history', {});
    delete all[box];
    store.set('history', all);
  },
};

// MARK: State

const state = {
  lang: store.get('lang', 'zh'), tab: 'plan', db: null, dbError: null, index: null,
  origin: '', destination: '', chat: '', preference: 'fastest', phase: 'idle', error: null,
  from: null, to: null, journeys: [], expanded: null, explanation: null, explaining: false, aiNotice: null, lastChat: null,
  discovery: null,
  stopQuery: '', stopPlace: null, stops: [], stopMode: 'all', stopRadius: 500, stopBusy: false, stopError: null, stopOpen: null,
  routeQuery: '', routeKey: null, saved: store.get('saved', []),
  nav: null, fix: null, speechLang: store.get('speechLang', 'zh-HK'), listening: false,
};
const t = (zh, en) => (state.lang === 'zh' ? zh : en);
const name = (id) => stopName(id, state.db, state.lang);
const client = () => {
  const key = store.get('apiKey', '');
  return key ? deepSeek(key, store.get('model', '') || undefined) : null;
};
const siteIndex = () => (state.index ??= buildStopIndex(state.db));

// MARK: DOM helpers

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else if (key === 'value') element.value = value;
    else element.setAttribute(key, value === true ? '' : value);
  }
  element.append(...children.flat(Infinity).filter((child) => child != null && child !== false));
  return element;
}
const $ = (id) => document.getElementById(id);
const clear = (element, ...children) => element.replaceChildren(...children.flat(Infinity).filter(Boolean));
const distanceText = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const clock = (ms) => new Date(ms).toLocaleTimeString(state.lang === 'zh' ? 'zh-HK' : 'en-HK', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Hong_Kong' });
const isDarkText = (op) => op === 'ctb';

function badge(op, route) {
  const element = h('span', { class: `badge${isDarkText(op) ? ' dark' : ''}` }, lineName(op, route, state.lang));
  element.style.background = lineColor(op, route);
  return element;
}

function segments(options, selected, choose) {
  return h('div', { class: 'segments' }, options.map(([value, label]) => h('button', {
    'aria-pressed': String(value === selected), onclick: () => choose(value),
  }, label)));
}

/** Past searches: the latest few, with the rest folded away. */
function historyBar(box, pick) {
  const entries = history.entries(box);
  if (!entries.length) return null;
  const root = h('div', { class: 'history' });
  let open = false;
  const draw = () => {
    const shown = open ? entries : entries.slice(0, HISTORY_SHOWN);
    const hidden = entries.length - HISTORY_SHOWN;
    clear(root,
      h('div', { class: `list${open ? ' open' : ''}` }, shown.map((text) => h('button', {
        class: 'chip', title: text, onmousedown: (event) => event.preventDefault(), onclick: () => pick(text),
      }, text.length > 14 ? `${text.slice(0, 14)}…` : text))),
      hidden > 0 && h('button', {
        class: 'link', onmousedown: (event) => event.preventDefault(),
        onclick: () => { open = !open; draw(); },
      }, open ? t('收起', 'Less') : t(`更多 ${hidden}`, `${hidden} more`)),
      h('button', {
        class: 'link', onmousedown: (event) => event.preventDefault(),
        onclick: () => { history.clear(box); root.remove(); },
      }, t('清除', 'Clear')));
  };
  draw();
  return root;
}

// MARK: Map

const mapView = (() => {
  let map, content, labels;
  const tile = (path) => `https://mapapi.geodata.gov.hk/gs/api/v1.0.0/xyz/${path}/wgs84/{z}/{x}/{y}.png`;
  const point = (l) => [l.lat, l.lng];
  const pin = (html, cls, color) => {
    const element = document.createElement('div');
    element.className = cls;
    element.textContent = html;
    if (color) element.style.background = color;
    return L.divIcon({ html: element, className: '', iconSize: [0, 0] });
  };
  return {
    init() {
      map = L.map('map', { zoomControl: false, attributionControl: true, minZoom: 10, maxZoom: 19 }).setView([22.34, 114.15], 11);
      L.tileLayer(tile('basemap'), {
        maxZoom: 19, attribution: '<a href="https://portal.csdi.gov.hk" target="_blank" rel="noopener">© 地政總署 Lands Department</a>',
      }).addTo(map);
      labels = L.tileLayer(tile(`label/hk/${state.lang === 'zh' ? 'tc' : 'en'}`), { maxZoom: 19 });
      // Areas with no text have no tile, so Leaflet would keep the giant blurred parent on screen.
      labels._retainParent = () => false;
      labels.addTo(map);
      content = L.layerGroup().addTo(map);
      const markZoom = () => $('map').classList.toggle('far', map.getZoom() < 15);
      map.on('zoomend', markZoom);
      markZoom();
    },
    setLanguage() { labels?.setUrl(tile(`label/hk/${state.lang === 'zh' ? 'tc' : 'en'}`)); },
    resize() { map?.invalidateSize(); },
    clear() { content?.clearLayers(); },
    fit(points, maxZoom = 16) {
      if (!points.length) return;
      map.fitBounds(L.latLngBounds(points.map(point)).pad(0.15), { maxZoom, animate: false });
    },
    home() { map?.setView([22.34, 114.15], 11); },
    follow(location) { map.setView(point(location), Math.max(map.getZoom(), 16)); },
    ends(from, to) {
      if (from) L.marker(point(from.location), { icon: pin('●', 'pin', '#35c759'), title: from.name }).addTo(content);
      if (to) L.marker(point(to.location), { icon: pin('⚑', 'pin', '#ff453a'), title: to.name }).addTo(content);
    },
    path(path) {
      // A few station names always fit; a long bus route's only fit up close.
      $('map').classList.toggle('many-stops', path.segments.reduce((sum, s) => sum + s.stopIDs.length, 0) > 12);
      for (const segment of path.segments) {
        const line = segment.points.map(point);
        L.polyline(line, { color: '#fff', weight: 8, opacity: 0.95 }).addTo(content);
        const isWalk = segment.mode === 'walk';
        L.polyline(line, {
          color: isWalk ? '#2f7bf6' : lineColor(segment.op, segment.route), weight: isWalk ? 4 : 5, dashArray: isWalk ? '1 9' : null,
        }).addTo(content);
        segment.stopIDs.forEach((id, index) => {
          L.circleMarker(point(segment.points[index]), { radius: 4, color: lineColor(segment.op, segment.route), fillColor: '#fff', fillOpacity: 1, weight: 2 })
            .bindTooltip(name(id), { permanent: true, direction: 'right', offset: [6, 0], className: 'stop-label' }).addTo(content);
        });
        if (segment.mode === 'ride') {
          const chip = document.createElement('span');
          chip.className = `route-chip${isDarkText(segment.op) ? ' dark' : ''}`;
          chip.textContent = lineName(segment.op, segment.route, state.lang);
          chip.style.background = lineColor(segment.op, segment.route);
          L.marker(line[0], { icon: L.divIcon({ html: chip, className: '', iconSize: [0, 0] }), interactive: false }).addTo(content);
        }
      }
    },
    numbered(suggestions, choose) {
      suggestions.forEach((suggestion, index) => {
        L.marker(point(suggestion.place.location), { icon: pin(String(index + 1), 'pin', '#ff9f0a'), title: suggestion.place.name })
          .on('click', () => choose(suggestion)).addTo(content);
      });
    },
    stops(list, center, radius, choose) {
      L.circle(point(center), { radius, color: '#2f7bf6', weight: 1, fillOpacity: 0.06 }).addTo(content);
      // Rail last, so stations are drawn over bus stops; the list still shows every stop.
      const nearest = list.slice(0, 120), isRail = (s) => ['mtr', 'lightRail'].includes(primaryMode(s.site));
      for (const stop of [...nearest.filter((s) => !isRail(s)), ...nearest.filter(isRail)]) {
        const mode = primaryMode(stop.site);
        const color = { mtr: OP_COLORS.mtr, lightRail: OP_COLORS.lightRail, minibus: OP_COLORS.gmb, bus: OP_COLORS.kmb }[mode];
        L.circleMarker(point(stop.site.location), { radius: isRail(stop) ? 9 : 6, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 })
          .bindTooltip(nameText(stop.site.name, state.lang)).on('click', () => choose(stop)).addTo(content);
      }
    },
    me(location) { L.marker(point(location), { icon: pin('', 'me'), interactive: false, zIndexOffset: 1000 }).addTo(content); },
  };
})();

// MARK: Location

/** One position per visit; only the location buttons and navigation ask again. */
function getFix(refresh = false) {
  if (state.fix && !refresh) return Promise.resolve(state.fix);
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition((position) => {
      state.fix = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy };
      resolve(state.fix);
    }, () => resolve(state.fix), { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 });
  });
}

// MARK: Data

const DB_SOURCES = ['https://data.hkbus.app/routeFareList.min.json', 'https://hkbus.github.io/hk-bus-crawling/routeFareList.min.json'];
const worker = new Worker(new URL('./planner.worker.js', import.meta.url), { type: 'module' });
let requestID = 0;
const pending = new Map();
worker.onmessage = ({ data }) => {
  const done = pending.get(data.id);
  pending.delete(data.id);
  if (data.error) done?.reject(new Error(data.error));
  else done?.resolve(data);
};
const ask = (message) => new Promise((resolve, reject) => {
  const id = ++requestID;
  pending.set(id, { resolve, reject });
  worker.postMessage({ ...message, id });
});

async function loadDB() {
  for (const source of DB_SOURCES) {
    try {
      const response = await fetch(source);
      if (!response.ok) continue;
      state.db = normalizeDB(await response.json());
      await ask({ type: 'init', db: state.db });
      state.dbError = null;
      renderTab();
      return;
    } catch (error) {
      state.dbError = String(error);
    }
  }
  state.dbError ??= t('無法下載路線資料', "Couldn't download route data");
  renderSheet();
}

// MARK: Planning

let planRun = 0;

async function resolvePlace(text) {
  const site = exactSite(text, siteIndex());
  if (site) return { name: nameText(site.name, state.lang), location: site.location };
  const place = await lookupPlace(text);
  if (place) return state.lang === 'zh' ? { name: text, location: place.location } : place;
  const partial = partialSite(text, siteIndex());
  return partial ? { name: nameText(partial.name, state.lang), location: partial.location } : null;
}

async function here() {
  const fix = await getFix();
  return fix ? { name: t('我的位置', 'My location'), location: { lat: fix.lat, lng: fix.lng } } : null;
}

function resetPlan() {
  Object.assign(state, { journeys: [], expanded: null, explanation: null, explaining: false, aiNotice: null, from: null, to: null, error: null });
}

function setPhase(phase, error = null) {
  state.phase = phase;
  state.error = error;
  renderSheet();
}

function currentTrip() {
  const destination = state.destination.trim();
  return destination ? { origin: normalizedOrigin(state.origin), destination, preference: state.preference } : null;
}

/** `request` is {kind: 'search'}, {kind: 'chat', text} or {kind: 'place', place}. */
async function runPlan(request) {
  const run = ++planRun, ai = client(), stale = () => run !== planRun;
  stopNavigation();
  resetPlan();
  setPhase('understanding');
  let intent = null;

  if (request.kind === 'place') {
    intent = { origin: normalizedOrigin(state.origin), destination: request.place.name, preference: state.preference };
  } else if (ai) {
    try {
      if (request.kind === 'chat') {
        const reply = await ai.chat(chatMessage(request.text, request.current));
        if (stale()) return;
        if (reply.wish) return startDiscovery(reply.wish, run);
        intent = reply.trip;
      } else {
        intent = await ai.intent(searchMessage(normalizedOrigin(state.origin), state.destination.trim(), state.preference));
      }
    } catch (error) {
      state.aiNotice = t('AI 暫時未能使用，已改用基本解析：', 'AI unavailable, used basic parsing: ') + error.message;
    }
  }
  if (stale()) return;
  if (!intent && request.kind === 'chat') {
    const wish = parseWish(request.text);
    if (wish) return startDiscovery(wish, run);
    intent = parseFollowUp(request.text, request.current);
  }
  intent ??= currentTrip();
  if (!intent) return setPhase('failed', t('請輸入目的地，例如「由旺角去理大」。', 'Enter a destination, e.g. "Mong Kok to PolyU".'));
  // An empty start box always means here, whatever the AI inferred.
  if (request.kind === 'search' && !normalizedOrigin(state.origin)) intent.origin = null;
  if (request.kind === 'chat') {
    state.origin = intent.origin ?? '';
    state.destination = intent.destination;
    syncPlaceInputs();
  }
  state.preference = intent.preference;

  setPhase('locating');
  const noLocation = t('未能取得你的位置：請允許定位，或在上方輸入起點。', "Couldn't get your location: allow Location access, or type a start above.");
  const start = intent.origin ? await resolvePlace(intent.origin) : await here();
  if (stale()) return;
  if (!start) return setPhase('failed', intent.origin ? t(`找不到起點「${intent.origin}」。`, `Couldn't find the start "${intent.origin}".`) : noLocation);
  let end = request.place;
  if (!end) end = isCurrentLocation(intent.destination) ? await here() : await resolvePlace(intent.destination);
  if (stale()) return;
  if (!end) return setPhase('failed', t(`找不到目的地「${intent.destination}」。`, `Couldn't find "${intent.destination}".`));
  state.from = start;
  state.to = end;
  mapView.fit([start.location, end.location]);
  if (!inHongKong(start.location)) return setPhase('failed', t('起點不在香港範圍內。', 'The start is outside Hong Kong.'));

  setPhase('planning');
  const departure = Date.now();
  const { journeys } = await ask({ type: 'plan', from: start.location, to: end.location, departure, preference: state.preference });
  if (stale()) return;
  if (!journeys.length) return setPhase('failed', t('找不到公共交通路線，可能已經收車，或距離太近／太遠。', 'No public transport route found. Services may have ended, or the trip is too short or too far.'));
  state.journeys = journeys;
  setPhase('checkingLive');

  const arrivals = liveArrivalCache(state.db, state.lang);
  const live = await Promise.all(journeys.map((journey) => retime(journey, arrivals)));
  if (stale()) return;
  state.journeys = live.sort((a, b) => score(a, state.preference) - score(b, state.preference));
  setPhase('done');

  if (!ai || state.aiNotice) return;
  state.explaining = true;
  renderBottomStatus();
  try {
    const reply = await ai.explain(summary(state.journeys.slice(0, 3)), state.lang);
    if (!stale()) state.explanation = reply;
  } catch { /* The options are still on screen. */ }
  if (stale()) return;
  state.explaining = false;
  renderBottomStatus();
}

/** A compact, coordinate-free description of the options for the AI. */
function summary(journeys) {
  const now = Date.now();
  const lines = [`Rider preference: ${state.preference}`];
  journeys.forEach((journey, index) => {
    const parts = [`Option ${index + 1}: ${Math.round(totalMinutes(journey))} min total, ${transfers(journey)} transfer(s), ${Math.round(walkingMeters(journey))} m walking.`];
    for (const leg of journey.legs) {
      if (leg.type === 'walk') {
        parts.push(`Walk ${Math.round(leg.minutes)} min to ${leg.to ? name(leg.to) : 'destination'}.`);
      } else {
        const wait = leg.liveDeparture
          ? `${leg.isProjected ? 'projected from the live headway' : 'live'}: departs in ${Math.max(0, Math.round((leg.liveDeparture - now) / 60_000))} min`
          : `estimate, no live data: wait about ${Math.round(leg.waitMinutes)} min`;
        parts.push(`${OP_LABELS[leg.op]} ${lineName(leg.op, leg.route, state.lang)} from ${name(leg.boardStopID)} to ${name(leg.alightStopID)}, ${leg.alightPosition - leg.boardPosition} stops (${wait}).`);
      }
    }
    lines.push(parts.join(' '));
  });
  return lines.join('\n');
}

// MARK: Finding places

async function startDiscovery(wish, run) {
  if (wish.area) return discover(wish, wish.area, false, run);
  state.discovery = { stage: 'asking', wish };
  setPhase('idle');
  renderBottomStatus();
}

async function discover(wish, area, isTyped, run = ++planRun) {
  const ai = client(), stale = () => run !== planRun;
  const giveUp = (message) => {
    state.discovery = { stage: 'asking', wish };
    setPhase('failed', message);
    renderBottomStatus();
  };
  resetPlan();
  state.discovery = { stage: 'finding', wish };
  setPhase('findingPlaces');
  renderBottomStatus();

  let place = cleanArea(area), extra = null;
  if (isTyped && ai) {
    try { ({ area: place, extra } = await ai.area(area, wish.want)); } catch { /* Use the text as typed. */ }
  }
  if (stale()) return;
  let searchArea;
  if (isNearby(place)) {
    const fix = await getFix();
    if (stale()) return;
    if (!fix) return giveUp(t('未能取得你的位置，請選擇一個地區或輸入範圍。', "Couldn't get your location. Pick a district or type an area."));
    const center = { lat: fix.lat, lng: fix.lng };
    // "Nearby" means the rider's own district, not a circle around them.
    const district = await districtAt(center);
    searchArea = district
      ? { name: district[state.lang] || district.zh, center, radius: 8000, district: district.zh }
      : { name: t('附近', 'Nearby'), center, radius: 2500 };
  } else {
    const resolved = await resolvePlace(place);
    if (stale()) return;
    if (!resolved) return giveUp(t(`找不到「${place}」，請換一個範圍。`, `Couldn't find "${place}". Try another area.`));
    searchArea = { name: resolved.name, center: resolved.location, radius: 2500 };
  }

  // The AI names shops, and the map confirms each one is really there.
  let suggestions = [];
  if (ai) {
    try {
      const named = await ai.suggest(wish.want, searchArea.name, extra, state.lang);
      if (stale()) return;
      suggestions = await verifyPlaces(named, searchArea);
    } catch (error) {
      state.aiNotice = t('AI 暫時未能使用，已改用地圖搜尋：', 'AI unavailable, searched the map instead: ') + error.message;
    }
  }
  if (stale()) return;
  if (!suggestions.length) {
    const found = new Map();
    for (const term of wish.searchTerms) {
      for (const item of withinArea(await photonSearch(term, searchArea.center, searchArea.radius), searchArea)) {
        found.set(`${item.location.lat},${item.location.lng}`, item);
      }
    }
    if (stale()) return;
    suggestions = [...found.values()].sort((a, b) => a.meters - b.meters).slice(0, 5).map((item) => ({ place: item, reason: null, isNamedByAI: false }));
    if (!suggestions.length) {
      return giveUp(ai ? t(`${searchArea.name}找不到${wish.want}，請換一個範圍。`, `Couldn't find ${wish.want} around ${searchArea.name}. Try another area.`)
        : t(`地圖找不到名稱含「${wish.want}」的店。在設定加入 DeepSeek API key 後，AI 可以直接推薦店舖。`, `No shop on the map is called "${wish.want}". Add a DeepSeek API key in Settings for AI recommendations.`));
    }
  }
  state.discovery = { stage: 'choosing', wish, areaName: searchArea.name, suggestions };
  setPhase('idle');
  renderBottomStatus();
  mapView.fit(suggestions.map((suggestion) => suggestion.place.location));
}

function choosePlace(suggestion) {
  state.destination = suggestion.place.name;
  syncPlaceInputs();
  runPlan({ kind: 'place', place: { name: suggestion.place.name, location: suggestion.place.location } });
}

function backToSuggestions() {
  planRun++;
  stopNavigation();
  resetPlan();
  state.destination = '';
  syncPlaceInputs();
  setPhase('idle');
}

// MARK: Navigation

let watchID = null, wakeLock = null;

function selectedPath() {
  const journey = state.journeys.find((j) => journeyID(j) === state.expanded);
  return journey && state.from && state.to ? journeyPath(journey, state.from.location, state.to.location, state.db) : null;
}

async function startNavigation(journey) {
  const path = journeyPath(journey, state.from.location, state.to.location, state.db);
  state.nav = { id: journeyID(journey), path, progress: null, here: null, issue: null };
  watchID = navigator.geolocation?.watchPosition((position) => {
    if (!state.nav || state.nav.progress?.hasArrived) return;
    const here = { lat: position.coords.latitude, lng: position.coords.longitude };
    state.nav.here = here;
    state.nav.issue = null;
    state.nav.progress = progressAt(state.nav.path, here, position.coords.accuracy, state.nav.progress);
    if (state.nav.progress?.hasArrived) stopWatching();
    drawMap();
    mapView.follow(here);
    renderNavBanner();
  }, (error) => {
    if (state.nav) state.nav.issue = error.code === 1 ? 'denied' : 'unavailable';
    renderNavBanner();
  }, { enableHighAccuracy: true, maximumAge: 3_000, timeout: 20_000 }) ?? null;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* Screen may dim; navigation still works. */ }
  renderSheet();
  renderNavBanner();
}

function stopWatching() {
  if (watchID != null) navigator.geolocation.clearWatch(watchID);
  watchID = null;
  wakeLock?.release?.();
  wakeLock = null;
}

function stopNavigation() {
  stopWatching();
  if (!state.nav) return;
  state.nav = null;
  renderNavBanner();
}

function renderNavBanner() {
  $('nav-banner')?.remove();
  if (!state.nav || state.tab !== 'plan') return;
  const { progress, path, issue } = state.nav;
  const text = issue === 'denied' ? t('導航需要定位權限，請在瀏覽器設定開啟。', 'Navigation needs Location access. Turn it on in your browser settings.')
    : !progress ? (issue ? t('暫時未能定位，稍後會再試。', "Can't find you right now. Still trying.") : t('正在取得你的位置…', 'Finding your location…'))
      : instruction(path, progress, state.lang, name);
  $('map').append(h('div', { id: 'nav-banner', class: 'nav-banner' },
    h('span', { class: 'grow' }, text),
    h('button', { class: 'primary', onclick: () => { stopNavigation(); renderSheet(); drawMap(); fitPlanMap(); } }, progress?.hasArrived ? t('完成', 'Done') : t('結束', 'End'))));
}

// MARK: Voice

const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
let recognition = null;

function toggleSpeech() {
  if (recognition) return recognition.stop();
  recognition = new Recognition();
  recognition.lang = state.speechLang;
  recognition.interimResults = true;
  let text = '';
  recognition.onresult = (event) => {
    text = [...event.results].map((result) => result[0].transcript).join('');
    state.chat = text;
    $('chat-input').value = text;
  };
  recognition.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      state.aiNotice = t('語音輸入需要麥克風權限，請在瀏覽器設定開啟。', 'Voice input needs Microphone access. Turn it on in your browser settings.');
      renderBottomStatus();
    }
  };
  recognition.onend = () => {
    recognition = null;
    state.listening = false;
    renderChatControls();
    if (text.trim()) sendChat();
  };
  recognition.start();
  state.listening = true;
  renderChatControls();
}

function renderChatControls() {
  const mic = $('mic');
  if (mic) {
    mic.textContent = state.listening ? '■' : '🎤';
    mic.style.color = state.listening ? 'var(--red)' : '';
  }
  const input = $('chat-input');
  if (input) input.placeholder = chatPrompt();
}

function chatPrompt() {
  if (state.listening) return t('正在聆聽…', 'Listening…');
  if (state.discovery?.stage === 'asking') return t('輸入更精確的範圍，例如：朗豪坊附近', 'Type a more exact area, e.g. near Langham Place');
  return t('告訴 AI，例如：我想吃螺螄粉', 'Ask AI, e.g. I want rice noodles');
}

// MARK: Actions

function search() {
  if (!state.db || !state.destination.trim()) return;
  const origin = normalizedOrigin(state.origin);
  if (origin) history.add('origin', origin);
  if (!isCurrentLocation(state.destination)) history.add('destination', state.destination);
  state.discovery = null;
  renderBottomStatus();
  renderPlaceHistory(null);
  document.activeElement?.blur();
  runPlan({ kind: 'search' });
}

function sendChat() {
  const text = state.chat.trim();
  if (!text || !state.db) return;
  history.add('chat', text);
  state.chat = '';
  const input = $('chat-input');
  if (input) {
    input.value = '';
    input.blur();
  }
  state.lastChat = text;
  renderChatHistory(false);
  if (state.discovery?.stage === 'asking') return void discover(state.discovery.wish, text, true);
  const current = currentTrip();
  state.discovery = null;
  renderBottomStatus();
  runPlan({ kind: 'chat', text, current });
}

function swapEnds() {
  const start = state.origin.trim(), end = state.destination.trim();
  state.origin = isCurrentLocation(end) ? '' : end;
  state.destination = start || t('我的位置', 'My location');
  syncPlaceInputs();
}

function syncPlaceInputs() {
  if ($('origin-input')) $('origin-input').value = state.origin;
  if ($('destination-input')) $('destination-input').value = state.destination;
}

async function searchStops(aroundMe = false) {
  if (!state.db) return;
  const run = ++stopRun, text = state.stopQuery.trim(), index = siteIndex();
  state.stopError = null;
  state.stopOpen = null;
  let place = null;
  state.stopBusy = true;
  renderSheet();
  if (aroundMe) {
    place = await here();
    if (!place) state.stopError = t('未能取得你的位置，請允許定位。', "Couldn't get your location. Allow Location access.");
  } else if (text) {
    history.add('stops', text);
    const site = exactSite(text, index);
    if (site) {
      place = { name: nameText(site.name, state.lang), location: site.location };
    } else {
      // A map reads 理大 as any name containing those characters, so expand nicknames first.
      let full = text;
      try { full = (await client()?.intent(searchMessage(null, text, 'fastest')))?.destination ?? text; } catch { /* Search the text as typed. */ }
      place = await resolvePlace(full);
      if (place && full !== text) place = { ...place, name: full };
    }
    if (!place) state.stopError = t(`找不到「${text}」，請換個說法。`, `Couldn't find "${text}". Try another name.`);
  }
  if (run !== stopRun) return;
  state.stopPlace = place;
  state.stops = place ? stopsNear(index, place.location, state.stopRadius) : [];
  state.stopBusy = false;
  renderStopsTop();
  renderSheet();
  drawMap();
  if (place) mapView.fit([offset(place.location, state.stopRadius, -1), offset(place.location, state.stopRadius, 1)], 18);
}
let stopRun = 0;
const offset = (l, m, sign) => ({ lat: l.lat + (sign * m) / 111_000, lng: l.lng + (sign * m) / 103_000 });

function planTo(site) {
  state.tab = 'plan';
  state.origin = '';
  state.destination = nameText(site.name, state.lang);
  state.discovery = null;
  renderTab();
  runPlan({ kind: 'place', place: { name: state.destination, location: site.location } });
}

// MARK: Arrival widgets

function etaWidget(route, seq, op) {
  const root = h('div', { class: 'eta-grid' }, h('div', { class: 'row small muted' }, h('span', { class: 'spinner' }), t('查詢中…', 'Loading…')));
  fetchETA(route, seq, state.db, state.lang, op).then((etas) => {
    const now = Date.now(), timed = etas.filter((eta) => eta.date != null && eta.date >= now - 60_000).slice(0, 2);
    if (!timed.length) {
      const remark = etas.find((eta) => nameText(eta.remark, state.lang));
      return clear(root, h('div', { class: 'small muted' }, remark ? nameText(remark.remark, state.lang) : t('暫無到站資料', 'No arrivals right now')));
    }
    clear(root, timed.map((eta, index) => {
      const minutes = Math.max(0, Math.floor((eta.date - now) / 60_000));
      return h('div', { class: 'eta-box' },
        h('div', { class: 'tiny muted' }, index ? t('第二班', 'Then') : t('下一班', 'Next')),
        h('div', { class: 'bold' }, minutes ? t(`${minutes} 分鐘`, `${minutes} min`) : t('即到', 'Now')),
        h('div', { class: 'tiny muted ellipsis' }, nameText(eta.remark, state.lang) || clock(eta.date)));
    }));
  }).catch(() => clear(root, h('div', { class: 'notice' }, t('未能取得到站時間', "Couldn't get arrivals"))));
  return root;
}

const isSaved = (key, seq, op) => state.saved.some((s) => s.routeKey === key && s.seq === seq && s.op === op);
function toggleSaved(key, seq, op) {
  state.saved = isSaved(key, seq, op) ? state.saved.filter((s) => !(s.routeKey === key && s.seq === seq && s.op === op)) : [...state.saved, { routeKey: key, seq, op }];
  store.set('saved', state.saved);
}
function starButton(key, seq, op) {
  const button = h('button', { class: 'icon-button', 'aria-label': t('收藏', 'Save') }, isSaved(key, seq, op) ? '★' : '☆');
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleSaved(key, seq, op);
    button.textContent = isSaved(key, seq, op) ? '★' : '☆';
  });
  return button;
}

/** A route at a stop: tap for its next two arrivals. */
function visitRow(visit) {
  const route = state.db.routes[visit.routeKey];
  if (!route) return null;
  const detail = h('div');
  let open = false;
  return h('div', {},
    h('div', { class: 'row' },
      h('button', {
        class: 'tap grow', onclick: () => {
          open = !open;
          clear(detail, open && etaWidget(route, visit.seq, visit.op));
        },
      }, h('div', { class: 'row' }, badge(visit.op, route.route), h('span', { class: 'small ellipsis grow' }, `→ ${nameText(route.dest, state.lang)}`), h('span', { class: 'tiny muted' }, OP_LABELS[visit.op]))),
      starButton(visit.routeKey, visit.seq, visit.op)),
    detail);
}

// MARK: Plan tab

function renderPlaceHistory(field) {
  const slot = $('place-history');
  if (!slot) return;
  clear(slot, field && historyBar(field, (text) => {
    state[field] = text;
    syncPlaceInputs();
    search();
  }));
}

function renderChatHistory(show) {
  const slot = $('chat-history');
  if (!slot) return;
  clear(slot, show && historyBar('chat', (text) => {
    state.chat = text;
    sendChat();
  }));
}

function renderPlanTop() {
  const place = (field, dot, placeholder, trailing) => h('label', { class: 'field' }, h('span', { class: `dot${dot}` }),
    h('input', {
      id: `${field}-input`, value: state[field], placeholder, enterkeyhint: 'search', autocomplete: 'off',
      oninput: (event) => { state[field] = event.target.value; },
      onfocus: () => renderPlaceHistory(field),
      onblur: () => setTimeout(() => { if (!document.activeElement?.id?.endsWith('-input')) renderPlaceHistory(null); }, 150),
      onkeydown: (event) => { if (event.key === 'Enter') search(); },
    }), trailing);
  clear($('top'),
    h('div', { class: 'row' },
      h('div', { class: 'grow', style: 'display:flex;flex-direction:column;gap:6px' },
        place('origin', '', t('我的位置', 'My location'), h('button', {
          class: 'icon-button', 'aria-label': t('由我的位置出發', 'Start from my location'),
          onclick: (event) => { event.preventDefault(); state.origin = ''; syncPlaceInputs(); getFix(true); },
        }, '◎')),
        place('destination', ' red', t('要去哪裡？', 'Where to?'))),
      h('div', { style: 'display:flex;flex-direction:column;gap:6px;align-items:center' },
        h('button', { class: 'icon-button', 'aria-label': t('對調起點及目的地', 'Swap start and destination'), onclick: swapEnds }, '⇅'),
        h('button', { class: 'primary', onclick: search }, t('搜尋', 'Search')))),
    h('div', { id: 'place-history' }));
}

function journeyCard(journey) {
  const id = journeyID(journey), isOpen = state.expanded === id, isNavigating = state.nav?.id === id;
  const shown = journey.legs.filter((leg) => leg.type === 'ride' || leg.minutes >= 0.5);
  const changes = transfers(journey);
  return h('div', { class: 'card' },
    h('button', {
      class: 'tap', onclick: () => {
        state.expanded = isOpen ? null : id;
        renderSheet();
        drawMap();
        fitPlanMap();
      },
    },
      h('div', { class: 'row' },
        h('span', { class: 'big' }, Math.round(totalMinutes(journey))),
        h('span', { class: 'small muted grow' }, t(`分鐘 · 到達 ${clock(journey.departure + totalMinutes(journey) * 60_000)}`, `min · arrive ${clock(journey.departure + totalMinutes(journey) * 60_000)}`)),
        rides(journey).some((ride) => ride.liveDeparture) && h('span', { class: 'tiny green' }, t('實時', 'Live')),
        h('span', { class: 'muted' }, isOpen ? '⌃' : '⌄')),
      h('div', { class: 'chips', style: 'margin-top:6px' }, shown.flatMap((leg, index) => [
        index > 0 && h('span', { class: 'muted tiny' }, '›'),
        leg.type === 'walk' ? h('span', { class: 'small muted' }, `🚶${Math.max(1, Math.round(leg.minutes))}`) : badge(leg.op, leg.route),
      ])),
      h('div', { class: 'tiny muted', style: 'margin-top:5px' }, `${changes ? t(`轉 ${changes} 次`, `${changes} change${changes > 1 ? 's' : ''}`) : t('直達', 'Direct')} · ${t(`步行 ${Math.round(walkingMeters(journey))} 米`, `walk ${Math.round(walkingMeters(journey))} m`)}`)),
    isOpen && h('div', { class: 'divider' }),
    isOpen && journey.legs.map(legDetail),
    isOpen && h('button', {
      class: `primary wide ${isNavigating ? 'danger' : 'blue'}`,
      onclick: () => { if (isNavigating) { stopNavigation(); renderSheet(); drawMap(); fitPlanMap(); } else { stopNavigation(); startNavigation(journey); } },
    }, isNavigating ? t('結束導航', 'End navigation') : t('開始導航', 'Start navigation')));
}

function legDetail(leg) {
  if (leg.type === 'walk') {
    const minutes = Math.max(1, Math.round(leg.minutes)), target = leg.to ? name(leg.to) : t('目的地', 'destination');
    return h('div', { class: 'small muted' }, t(`🚶 步行約 ${minutes} 分鐘（${Math.round(leg.meters)} 米）到 ${target}`, `🚶 Walk about ${minutes} min (${Math.round(leg.meters)} m) to ${target}`));
  }
  const wait = Math.round(leg.waitMinutes), platform = leg.livePlatform ? ` · ${nameText(leg.livePlatform, state.lang)}` : '';
  const when = !leg.liveDeparture ? t(`估算：等候約 ${wait} 分鐘（暫無實時資料）`, `Estimate: about ${wait} min wait (no live data)`)
    : leg.isProjected ? t(`實時推算：約 ${clock(leg.liveDeparture)} 開出（等候約 ${wait} 分鐘）`, `Projected from live: about ${clock(leg.liveDeparture)} (${wait} min wait)`) + platform
      : t(`實時：${clock(leg.liveDeparture)} 開出（等候約 ${wait} 分鐘）`, `Live: departs ${clock(leg.liveDeparture)} (${wait} min wait)`) + platform;
  return h('div', { class: 'row', style: 'align-items:flex-start' }, badge(leg.op, leg.route),
    h('div', { class: 'grow' },
      h('div', { class: 'small bold' }, t(`${name(leg.boardStopID)} 上車 · 往 ${leg.dest.zh}`, `Board at ${name(leg.boardStopID)} · to ${leg.dest.en}`)),
      h('div', { class: `tiny ${leg.liveDeparture ? 'green' : 'muted'}` }, when),
      h('div', { class: 'small muted' }, t(`${name(leg.alightStopID)} 落車 · ${leg.alightPosition - leg.boardPosition} 個站 · 約 ${Math.round(leg.rideMinutes)} 分鐘`, `Alight at ${name(leg.alightStopID)} · ${leg.alightPosition - leg.boardPosition} stops · about ${Math.round(leg.rideMinutes)} min`))));
}

function suggestionList({ wish, areaName, suggestions }) {
  return [
    h('div', { class: 'row' }, h('span', { class: 'bold grow' }, t(`${areaName}的${wish.want}：選一個地點`, `${wish.want} around ${areaName}: pick one`)),
      h('button', { class: 'link', onclick: () => { state.discovery = { stage: 'asking', wish: { ...wish, area: null } }; renderSheet(); drawMap(); renderBottomStatus(); } }, t('換範圍', 'Change area'))),
    h('div', { class: 'tiny muted' }, suggestions[0]?.isNamedByAI
      ? t('由 AI 推薦，並已在地圖核實。AI 的資料可能過時，出發前請確認仍在營業。', 'Recommended by AI and found on the map. AI knowledge can be out of date, so check before you go.')
      : t('地點來自地圖搜尋，沒有菜單資料，未必有售，出發前請先確認。', 'Places come from a map search, which has no menus. Check before you go.')),
    suggestions.map((suggestion, index) => h('button', { class: 'card tap', onclick: () => choosePlace(suggestion) },
      h('div', { class: 'row', style: 'align-items:flex-start' }, h('span', { class: 'num' }, index + 1),
        h('div', { class: 'grow' },
          h('div', { class: 'row' }, h('span', { class: 'bold ellipsis grow' }, suggestion.place.name), h('span', { class: 'tiny muted' }, distanceText(suggestion.place.meters))),
          suggestion.place.address && h('div', { class: 'tiny muted ellipsis' }, suggestion.place.address),
          suggestion.reason && h('div', { class: 'small yellow' }, suggestion.reason))))),
  ];
}

const PHASES = {
  understanding: () => (client() ? t('AI 正在分析你的要求…', 'AI is analysing your request…') : t('理解要求…', 'Reading your request…')),
  findingPlaces: () => t('AI 正在搜尋，並在地圖上核實地點…', 'AI is searching and checking places on the map…'),
  locating: () => t('正在尋找起點及目的地…', 'Finding places…'),
  planning: () => t('正在計算路線…', 'Planning routes…'),
  checkingLive: () => t('正在核對實時到站時間…', 'Checking live arrivals…'),
};

function planSheet() {
  const items = [];
  if (!state.db) {
    items.push(state.dbError
      ? [h('div', { class: 'notice' }, state.dbError), h('button', { class: 'primary', onclick: loadDB }, t('重試', 'Retry'))]
      : h('div', { class: 'row small muted' }, h('span', { class: 'spinner' }), t('正在載入路線資料…', 'Loading route data…')));
    return items;
  }
  if (PHASES[state.phase]) items.push(h('div', { class: 'row small muted' }, h('span', { class: 'spinner' }), PHASES[state.phase]()));
  if (state.error) items.push(h('div', { class: 'notice' }, state.error));
  if (state.from && state.to) {
    items.push(h('div', { class: 'row small bold' }, h('span', { class: 'ellipsis' }, state.from.name), h('span', { class: 'muted' }, '→'), h('span', { class: 'ellipsis grow' }, state.to.name)));
  }
  if (state.journeys.length) {
    items.push(segments([['fastest', t('最快', 'Fastest')], ['fewerTransfers', t('少轉車', 'Fewer changes')], ['lessWalking', t('少行路', 'Less walking')]], state.preference, (preference) => {
      state.preference = preference;
      state.journeys = [...state.journeys].sort((a, b) => score(a, preference) - score(b, preference));
      renderSheet();
    }));
  }
  if (state.discovery?.stage === 'choosing') {
    if (state.journeys.length || state.phase !== 'idle') {
      items.push(h('button', { class: 'link', style: 'text-align:left', onclick: backToSuggestions }, t('‹ 返回推薦地點', '‹ Back to recommendations')));
    } else {
      items.push(suggestionList(state.discovery));
    }
  }
  items.push(state.journeys.map(journeyCard));
  if (!state.journeys.length && state.phase === 'idle' && !state.error && !state.discovery) {
    items.push(h('div', { class: 'small muted' }, t(
      '在上方輸入目的地；起點留空時由你目前的位置出發。也可以在下方用文字或語音告訴 AI，例如「我想吃螺螄粉」。',
      'Type a destination above; with no start, your current location is used. You can also tell the AI below by text or voice.')));
  }
  return items;
}

function renderBottomStatus() {
  const slot = $('ai-status');
  if (!slot) return;
  const wish = state.discovery?.stage === 'asking' ? state.discovery.wish : null;
  let area = null;
  if (wish) {
    const options = (wish.areaOptions.length ? wish.areaOptions : ['旺角', '銅鑼灣', '尖沙咀', '中環']).filter((option) => option !== '附近').slice(0, 4);
    area = h('div', { class: 'area' },
      h('div', { class: 'row' }, h('span', { class: 'bold yellow grow' }, t(`想找${wish.want}，要在哪裡找？`, `Where should I look for ${wish.want}?`)),
        h('button', { class: 'icon-button', 'aria-label': t('取消', 'Cancel'), onclick: () => { state.discovery = null; renderBottomStatus(); renderChatControls(); renderSheet(); } }, '✕')),
      h('div', { class: 'choices' },
        h('button', { onclick: () => discover(wish, '附近', false) }, t('附近（本區）', 'Nearby (this district)')),
        options.map((option) => h('button', { onclick: () => discover(wish, option, false) }, option))),
      h('div', { class: 'tiny muted' }, t('或在下方輸入更精確的範圍，例如：朗豪坊附近、要平啲', 'Or type a more exact area below')));
  }
  clear(slot,
    state.lastChat && h('div', { class: 'tiny muted ellipsis' }, state.lastChat),
    state.explanation && h('div', { class: 'small yellow' }, `✦ ${state.explanation}`),
    state.explaining && !state.explanation && h('div', { class: 'small muted' }, t('AI 整理建議中…', 'AI is summarising…')),
    state.aiNotice && h('div', { class: 'tiny muted' }, state.aiNotice),
    area);
  renderChatControls();
}

function renderPlanBottom() {
  const hasKey = !!store.get('apiKey', '');
  const speechLabels = { 'zh-HK': t('粵語', 'Cantonese'), 'zh-CN': t('普通話', 'Mandarin'), 'en-US': 'English' };
  const speechButton = Recognition && h('button', {
    class: 'link', onclick: (event) => {
      const order = Object.keys(speechLabels);
      state.speechLang = order[(order.indexOf(state.speechLang) + 1) % order.length];
      store.set('speechLang', state.speechLang);
      event.target.textContent = speechLabels[state.speechLang];
    },
  }, speechLabels[state.speechLang]);
  clear($('bottom'),
    h('div', { id: 'ai-status', style: 'display:flex;flex-direction:column;gap:4px' }),
    h('div', { id: 'chat-history' }),
    h('div', { class: 'field' },
      h('span', { class: hasKey ? 'yellow' : 'muted' }, '✦'),
      h('input', {
        id: 'chat-input', value: state.chat, placeholder: chatPrompt(), enterkeyhint: 'send', autocomplete: 'off',
        oninput: (event) => { state.chat = event.target.value; },
        onfocus: () => renderChatHistory(true),
        onblur: () => setTimeout(() => renderChatHistory(false), 150),
        onkeydown: (event) => { if (event.key === 'Enter') sendChat(); },
      }),
      speechButton,
      Recognition && h('button', { id: 'mic', class: 'icon-button', 'aria-label': t('語音輸入', 'Voice input'), onclick: toggleSpeech }, '🎤'),
      h('button', { class: 'icon-button yellow', 'aria-label': t('傳送', 'Send'), onclick: sendChat }, '↑')),
    !hasKey && h('button', { class: 'tiny muted', style: 'text-align:left', onclick: () => setTab('settings') }, t('未連接 AI：現時使用基本解析。按此到設定加入 DeepSeek API key。', 'AI not connected: using basic parsing. Tap to add a DeepSeek API key in Settings.')));
  renderBottomStatus();
}

// MARK: Stops tab

function renderStopsTop() {
  clear($('top'),
    h('div', { class: 'row' },
      h('label', { class: 'field' }, h('input', {
        id: 'stop-input', value: state.stopQuery, placeholder: t('輸入站名或地點，例如：旺角、朗豪坊', 'Stop or place, e.g. Mong Kok'), enterkeyhint: 'search', autocomplete: 'off',
        oninput: (event) => { state.stopQuery = event.target.value; },
        onkeydown: (event) => { if (event.key === 'Enter') { event.target.blur(); searchStops(); } },
      })),
      h('button', { class: 'icon-button', 'aria-label': t('查看我附近的站點', 'Show stops around me'), onclick: () => searchStops(true) }, '◎'),
      h('button', { class: 'primary', onclick: () => searchStops() }, t('搜尋', 'Search'))),
    historyBar('stops', (text) => {
      state.stopQuery = text;
      $('stop-input').value = text;
      searchStops();
    }),
    segments([['all', t('全部', 'All')], ['bus', t('巴士', 'Bus')], ['minibus', t('小巴', 'Minibus')], ['mtr', t('港鐵', 'MTR')], ['lightRail', t('輕鐵', 'LRT')]], state.stopMode, (mode) => {
      state.stopMode = mode;
      renderStopsTop();
      renderSheet();
      drawMap();
    }),
    segments([[300, '300 m'], [500, '500 m'], [1000, '1 km']], state.stopRadius, (radius) => {
      state.stopRadius = radius;
      renderStopsTop();
      if (state.stopPlace) {
        state.stops = stopsNear(siteIndex(), state.stopPlace.location, radius);
        renderSheet();
        drawMap();
      }
    }));
}

const visibleStops = () => state.stops.filter((stop) => siteHasMode(stop.site, state.stopMode));

function stopCard(stop, isNearest) {
  const isOpen = state.stopOpen === stop.site.id;
  const numbers = [...new Set(stop.site.visits.map((v) => lineName(v.op, state.db.routes[v.routeKey].route, state.lang)))];
  return h('div', { class: 'card', id: `stop-${stop.site.id}` },
    h('button', { class: 'tap', onclick: () => { state.stopOpen = isOpen ? null : stop.site.id; renderSheet(); } },
      h('div', { class: 'row' }, h('span', { class: 'bold grow' }, nameText(stop.site.name, state.lang)),
        h('span', { class: `small ${isNearest ? 'yellow' : 'muted'}` }, distanceText(stop.distance)), h('span', { class: 'muted' }, isOpen ? '⌃' : '⌄')),
      h('div', { class: 'tiny muted ellipsis' }, numbers.slice(0, 8).join(' · ') + (numbers.length > 8 ? ` +${numbers.length - 8}` : ''))),
    isOpen && [
      h('button', { class: 'primary wide', onclick: () => planTo(stop.site) }, t('規劃路線到這裡', 'Plan a trip here')),
      h('div', { class: 'tiny muted' }, t('此站路線 · 點選查看最近兩班', 'Routes at this stop · tap for arrivals')),
      stop.site.visits.filter(MODES[state.stopMode]).map(visitRow),
    ]);
}

function stopsSheet() {
  if (!state.db) return h('div', { class: 'row small muted' }, h('span', { class: 'spinner' }), t('正在載入站點資料…', 'Loading stops…'));
  const stops = visibleStops();
  return [
    state.stopBusy && h('div', { class: 'row small muted' }, h('span', { class: 'spinner' }), t('搜尋中…', 'Searching…')),
    state.stopError && h('div', { class: 'notice' }, state.stopError),
    state.stopPlace && !state.stopBusy && h('div', { class: 'bold' }, t(`${state.stopPlace.name}附近 ${stops.length} 個站點`, `${stops.length} stops around ${state.stopPlace.name}`)),
    !state.stopPlace && !state.stopBusy && !state.stopError && h('div', { class: 'small muted' }, t('輸入站名或地點後，附近所有巴士站、小巴站、港鐵及輕鐵站都會顯示在這裡；點開站點可查看路線及到站時間，或直接規劃路線。', 'Search a stop or place to see all stops around it. Open one for routes and arrivals, or to plan a trip there.')),
    state.stopPlace && !stops.length && !state.stopBusy && h('div', { class: 'small muted' }, t('此範圍內沒有這類站點，可擴大範圍或改選「全部」。', 'No stops of this kind here. Try a larger radius or All.')),
    stops.map((stop, index) => stopCard(stop, index === 0)),
  ];
}

// MARK: Routes tab

function renderRoutesTop() {
  clear($('top'),
    h('label', { class: 'field' }, h('input', {
      id: 'route-input', value: state.routeQuery, placeholder: t('搜尋路線，例如 1A、960、505', 'Search routes, e.g. 1A, 960, 505'), enterkeyhint: 'search', autocomplete: 'off',
      oninput: (event) => { state.routeQuery = event.target.value; state.routeKey = null; renderSheet(); },
      onkeydown: (event) => { if (event.key === 'Enter') { history.add('routes', state.routeQuery); event.target.blur(); } },
    })),
    historyBar('routes', (text) => {
      state.routeQuery = text;
      state.routeKey = null;
      $('route-input').value = text;
      renderSheet();
    }));
}

function routesSheet() {
  if (!state.db) return h('div', { class: 'row small muted' }, h('span', { class: 'spinner' }), t('正在載入路線資料…', 'Loading route data…'));
  if (state.routeKey) {
    const route = state.db.routes[state.routeKey], op = route.operators[0];
    return [
      h('button', { class: 'link', style: 'text-align:left', onclick: () => { state.routeKey = null; renderSheet(); } }, t('‹ 返回', '‹ Back')),
      h('div', { class: 'row' }, badge(op, route.route), h('span', { class: 'bold' }, `${nameText(route.orig, state.lang)} → ${nameText(route.dest, state.lang)}`)),
      route.stops[op].map((id, seq) => stopRow(route, seq, id, op)),
    ];
  }
  const routes = searchRoutes(state.db, state.routeQuery);
  if (!state.routeQuery.trim()) return h('div', { class: 'small muted' }, t('輸入路線號碼，查看沿線站點及到站時間，並可按 ☆ 收藏。', 'Type a route number to see its stops and arrivals. Press ☆ to save a stop.'));
  if (!routes.length) return h('div', { class: 'small muted' }, t('找不到這條路線。', 'No such route.'));
  return routes.map((route) => h('button', {
    class: 'card tap', onclick: () => { history.add('routes', state.routeQuery); state.routeKey = route.key; renderSheet(); $('sheet').scrollTop = 0; },
  }, h('div', { class: 'row' }, badge(route.operators[0], route.route),
    h('div', { class: 'grow' }, h('div', { class: 'small bold ellipsis' }, `→ ${nameText(route.dest, state.lang)}`),
      h('div', { class: 'tiny muted' }, `${route.operators.map((op) => OP_LABELS[op]).join(' · ')}${route.serviceType === '1' ? '' : t(' · 特別班', ' · Special')}`)))));
}

function stopRow(route, seq, id, op) {
  const detail = h('div');
  let open = false;
  return h('div', { class: 'card', style: 'padding:8px 12px' },
    h('div', { class: 'row' },
      h('button', {
        class: 'tap grow small', onclick: () => {
          open = !open;
          clear(detail, open && etaWidget(route, seq, op));
        },
      }, `${seq + 1}. ${name(id)}`),
      starButton(route.key, seq, op)),
    detail);
}

// MARK: Saved tab

function savedSheet() {
  if (!state.db) return h('div', { class: 'row small muted' }, h('span', { class: 'spinner' }), t('正在載入…', 'Loading…'));
  if (!state.saved.length) return h('div', { class: 'small muted' }, t('還沒有收藏。在「路線」或「站點」按 ☆ 加入常用的車站。', 'Nothing saved yet. Press ☆ on the Routes or Stops page.'));
  return state.saved.flatMap((saved) => {
    const route = state.db.routes[saved.routeKey];
    if (!route) return [];
    const id = route.stops[saved.op]?.[saved.seq];
    return [h('div', { class: 'card' },
      h('div', { class: 'row' }, badge(saved.op, route.route),
        h('div', { class: 'grow' }, h('div', { class: 'small bold ellipsis' }, `→ ${nameText(route.dest, state.lang)}`), h('div', { class: 'tiny muted ellipsis' }, name(id))),
        h('button', { class: 'icon-button', 'aria-label': t('移除', 'Remove'), onclick: () => { toggleSaved(saved.routeKey, saved.seq, saved.op); renderSheet(); } }, '★')),
      etaWidget(route, saved.seq, saved.op))];
  });
}

// MARK: Settings tab

function settingsSheet() {
  const keyInput = h('input', { type: 'password', placeholder: store.get('apiKey', '') ? t('已設定，輸入新 key 以取代', 'Saved. Type a new key to replace it') : t('貼上 DeepSeek API key', 'Paste a DeepSeek API key'), autocomplete: 'off' });
  return [
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('span', { class: 'grow' }, t('語言', 'Language')),
        segments([['zh', '繁體中文'], ['en', 'English']], state.lang, (lang) => {
          state.lang = lang;
          store.set('lang', lang);
          document.documentElement.lang = lang === 'zh' ? 'zh-Hant' : 'en';
          mapView.setLanguage();
          renderTab();
        }))),
    h('div', { class: 'card' },
      h('div', { class: 'bold' }, t('AI 路線助手（DeepSeek）', 'AI assistant (DeepSeek)')),
      h('label', { class: 'field' }, keyInput),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => { if (keyInput.value.trim()) { store.set('apiKey', keyInput.value.trim()); renderTab(); } } }, t('儲存', 'Save')),
        store.get('apiKey', '') && h('button', { class: 'link', onclick: () => { store.set('apiKey', ''); renderTab(); } }, t('移除', 'Remove'))),
      h('div', { class: 'tiny muted' }, t('key 只保存在這部裝置的瀏覽器內，並由瀏覽器直接傳送給 DeepSeek，不經任何其他伺服器。不要在共用裝置上儲存。', 'The key stays in this browser and goes straight to DeepSeek, through no other server. Don\'t save it on a shared device.'))),
    h('div', { class: 'card' },
      h('div', { class: 'bold' }, t('私隱', 'Privacy')),
      h('div', { class: 'small muted' }, t(
        '此網站沒有伺服器，不收集任何資料。收藏及搜尋記錄只保存在你的瀏覽器。到站查詢直接連到各營辦商。使用「附近」找地點時，你的座標會傳送給 OpenStreetMap 的 Photon 服務以確定所在地區；傳送給 DeepSeek 的只有你輸入的文字、地區、站名及路線號碼，不包括座標。',
        'This site has no server and collects nothing. Saved stops and history stay in your browser. Arrivals come straight from the operators. When finding places nearby, your coordinates go to OpenStreetMap\'s Photon service to work out your district; DeepSeek only receives your text, the district, stop names and route numbers, never coordinates.'))),
    h('div', { class: 'card' },
      h('div', { class: 'bold' }, t('安裝到手機', 'Install on your phone')),
      h('div', { class: 'small muted' }, t('iPhone：在 Safari 按分享，再選「加入主畫面」。Android：在 Chrome 選單按「安裝應用程式」。', 'iPhone: in Safari, tap Share, then Add to Home Screen. Android: in the Chrome menu, tap Install app.'))),
    h('div', { class: 'tiny muted' }, t('路線資料來自 hkbus.app；地圖來自地政總署；地點搜尋來自政府地理資訊及 OpenStreetMap。', 'Route data from hkbus.app; maps from the Lands Department; place search from Government GIS and OpenStreetMap.')),
    h('a', { class: 'tiny link', href: 'https://github.com/kevinwentao07-zwt/hktransport', target: '_blank', rel: 'noopener' }, t('GitHub 原始碼（GPL-3.0）', 'Source on GitHub (GPL-3.0)')),
  ];
}

// MARK: Rendering

const TABS = [
  ['plan', '↗', () => t('規劃', 'Plan')], ['stops', '◉', () => t('站點', 'Stops')], ['routes', '☰', () => t('路線', 'Routes')],
  ['saved', '★', () => t('收藏', 'Saved')], ['settings', '⚙', () => t('設定', 'Settings')],
];

function renderSheet() {
  const sheets = { plan: planSheet, stops: stopsSheet, routes: routesSheet, saved: savedSheet, settings: settingsSheet };
  clear($('sheet'), sheets[state.tab]());
  if (state.tab === 'plan') drawMap();
}

function drawMap() {
  mapView.clear();
  if (state.tab === 'stops') {
    if (state.stopPlace) {
      mapView.ends(null, state.stopPlace);
      mapView.stops(visibleStops(), state.stopPlace.location, state.stopRadius, (stop) => {
        state.stopOpen = stop.site.id;
        renderSheet();
        $(`stop-${stop.site.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    }
    return;
  }
  if (state.tab !== 'plan') return;
  const path = state.nav?.path ?? selectedPath();
  if (path) mapView.path(path);
  const choosing = state.discovery?.stage === 'choosing' && !state.journeys.length && state.phase === 'idle';
  if (choosing) mapView.numbered(state.discovery.suggestions, choosePlace);
  mapView.ends(state.from, state.to);
  if (state.nav?.here) mapView.me(state.nav.here);
}

function fitPlanMap() {
  const path = selectedPath();
  const points = path ? path.segments.flatMap((s) => s.points) : [state.from?.location, state.to?.location].filter(Boolean);
  if (points.length) mapView.fit(points);
}

function renderTab() {
  clear($('tabs'), TABS.map(([id, glyph, label]) => h('button', {
    'aria-current': state.tab === id ? 'page' : null, onclick: () => setTab(id),
  }, h('span', { class: 'glyph' }, glyph), label())));
  const showsMap = state.tab === 'plan' || state.tab === 'stops';
  $('map').classList.toggle('hidden', !showsMap);
  $('app').classList.toggle('no-map', !showsMap);
  clear($('top'));
  clear($('bottom'));
  if (state.tab === 'plan') {
    renderPlanTop();
    renderPlanBottom();
  } else if (state.tab === 'stops') {
    renderStopsTop();
  } else if (state.tab === 'routes') {
    renderRoutesTop();
  }
  renderSheet();
  mapView.resize();
  drawMap();
  renderNavBanner();
}

function setTab(tab) {
  state.tab = tab;
  renderTab();
  $('sheet').scrollTop = 0;
  if (tab === 'stops' && state.stopPlace) mapView.fit([offset(state.stopPlace.location, state.stopRadius, -1), offset(state.stopPlace.location, state.stopRadius, 1)], 18);
  if (tab === 'plan') fitPlanMap();
}

new ResizeObserver(() => mapView.resize()).observe($('map'));

mapView.init();
renderTab();
loadDB();
setInterval(() => { if (state.tab === 'saved') renderSheet(); }, 30_000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
