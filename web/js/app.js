// The page itself: tabs, map, and the flows that tie the modules together.
import { meters,
  OP_COLORS, OP_LABELS, MODES, LIVE_AHEAD_MS, arrivalTime, arrivesLate, buildStopIndex, closestPosition, nextRouteKeys, planAdvice, routeFamily, routeWays, exactSite, instruction, journeyID, journeyPath, RETURN_COLOR, circularTurn, roadBetween, lineColor, lineName, matchingSites,
  nameText, normalizeDB, normalizePlace, partialSite, pathAhead, glideOnTrack, primaryMode, progressAt, retime, rides, routeTrack, fitsWalkLimit, journeyFare, MAX_WALK_LEG_MINUTES, rankCombinedTripOptions, searchRoutes, siteHasMode, stopName, stopsNear, trackBetween, vehiclesOnRoute,
  totalMinutes, transfers, walkEnds, walkingMeters, withWalkTimes,
} from './transit.js?v=dev';
import { fetchETA, liveArrivalCache, routeArrivals } from './eta.js?v=dev';
import { toSimplified } from './hans.js?v=dev';
import { AI_PROVIDERS, chatMessage, personalAI, verifyAIKey, isCurrentLocation, normalizedOrigin, parseFollowUp, parseSearch, parseWish, searchMessage } from './ai.js?v=dev';
import { HONG_KONG, cleanArea, exploreDestination, exploreWebSearchURL, googlePlaceLocation, googleSearch, googleSuggest, googleWalk, governmentSearch, inHongKong, insideArea, isNearby, knownShape, knownWalk, knownWalkTime, loadShape, lookupPlace, mergeShops, mergeSuggestions, photonSearch, withinArea } from './places.js?v=dev';

import { googleJourneys, requestGoogleTransit } from './google-transit.js?v=dev';
import { requestTransitous, transitousJourneys } from './transitous.js?v=dev';
import { EDUHK_TIMETABLE, EDUHK_TRANSPORT, EDUHK_UNIVERSITY, includesEdUHK, withEdUHKShuttle } from './eduhk.js?v=dev';

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
  remove(key) {
    try { localStorage.removeItem(`hkt.${key}`); } catch { /* Storage can be unavailable. */ }
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

const savedTransitMode = store.get('transitMode', 'all');
const FARE_PROFILES = {
  adult: ['成人', 'Adult'],
  child: ['小童（3–11 歲）', 'Child (3–11)'],
  student: ['學生八達通', 'Student Octopus'],
  joyyou60: ['樂悠咭（60–64 歲）', 'JoyYou Card (60–64)'],
  joyyou65: ['樂悠咭（65 歲或以上）', 'JoyYou Card (65+)'],
  disability: ['合資格殘疾人士', 'Eligible disability'],
};
const savedFareProfile = store.get('fareProfile', 'adult');
function savedAIConfig() {
  const legacy = store.get('deepseekKey', '');
  return store.get('aiConfig', null) ?? (legacy ? { key: legacy, provider: 'deepseek', model: AI_PROVIDERS.deepseek.model } : null);
}

const state = {
  lang: store.get('lang', 'zh'), script: store.get('script', 'hant'), tab: 'plan', db: null, dbError: null, index: null,
  origin: '', destination: '', when: null, chat: '', preference: store.get('preference', 'lessWalking'), phase: 'idle', error: null, planDirty: false,
  transitMode: ['mtr', 'bus'].includes(savedTransitMode) ? savedTransitMode : 'all',
  eduhkShuttle: store.get('eduhkShuttle', false) === true,
  fareProfile: Object.hasOwn(FARE_PROFILES, savedFareProfile) ? savedFareProfile : 'adult',
  aiConfig: savedAIConfig(), aiKeyRejected: false,
  from: null, to: null, journeys: [], candidates: [], allowLongWalk: false, onMap: null, pickedJourney: false, expanded: null, explanation: null, aiNotice: null, lastChat: null,
  discovery: null, explore: null,
  stopQuery: '', stopPlace: null, stops: [], stopMode: 'all', stopRadius: 500, stopBusy: false, stopError: null, stopOpen: null, stopVisit: null,
  routeQuery: '', routeKey: null, routeKeyboard: false, recentRoutes: store.get('recentRoutes', []), thread: null, lastSearch: null, saved: store.get('saved', []),
  talk: [], focus: null, routeView: false, nav: null, fix: null, speechLang: store.get('speechLang', 'zh-HK'), listening: false,
};
const t = (zh, en) => (state.lang === 'zh' ? zh : en);
const name = (id) => stopName(id, planningDB(), state.lang);
// Everything is written in Traditional, as stop names and replies are, so Simplified converts what
// lands on the page rather than each string on its way there.
const TEXT_ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'aria-valuetext'];

function simplify(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = toSimplified(node.nodeValue);
    if (text !== node.nodeValue) node.nodeValue = text;
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  for (const element of [node, ...node.querySelectorAll('*')]) {
    for (const name of TEXT_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value && toSimplified(value) !== value) element.setAttribute(name, toSimplified(value));
    }
  }
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) simplify(walker.currentNode);
}

const scriptWatcher = new MutationObserver((changes) => {
  for (const change of changes) {
    if (change.type === 'childList') change.addedNodes.forEach(simplify);
    else simplify(change.target);
  }
});

function applyScript() {
  scriptWatcher.disconnect();
  const isSimplified = state.lang === 'zh' && state.script === 'hans';
  document.documentElement.lang = state.lang === 'en' ? 'en' : isSimplified ? 'zh-Hans' : 'zh-Hant';
  if (!isSimplified) return;
  simplify($('app'));
  scriptWatcher.observe($('app'), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: TEXT_ATTRIBUTES });
}

function client() {
  const config = state.aiConfig;
  return config ? personalAI(config, recordAICost, () => {
    if (state.aiConfig === config) setAIConfig(null, true);
  }) : null;
}

const enableAIHint = () => t('在「設定 → AI API」選擇平台並輸入 API Key 後啟用。', 'Choose a provider and enter an API key in Settings → AI API to enable AI.');

function aiErrorMessage(status) {
  if (status === 400) return t('請確認介面格式、模型名稱和公開 HTTPS 地址。', 'Check the API format, model name and public HTTPS address.');
  if (status === 401) return t('平台拒絕了 API Key，請檢查 Key 及其權限。', 'The provider rejected the API key. Check the key and its permissions.');
  if (status === 402) return t('AI 平台帳戶餘額不足。', 'Your provider balance is insufficient.');
  if (status === 404) return t('找不到所選模型或 API 端點。', 'The selected model or API endpoint was not found.');
  if (status === 429) return t('AI 平台暫時限制請求頻率，請稍後再試。', 'The AI provider is temporarily limiting requests. Try again shortly.');
  return t('暫時未能取得 AI 回覆，請檢查設定或稍後再試。', 'Unable to get an AI response. Check your settings or try again shortly.');
}

const aiUsageDay = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
let aiUsage = store.get('aiUsage', null);

function todayAIUsage(day = aiUsageDay()) {
  const saved = store.get('aiUsage', aiUsage);
  if (saved?.day !== day) return { costs: {}, unpriced: 0 };
  return { costs: saved.costs ?? (Number.isFinite(saved.cost) ? { CNY: saved.cost } : {}), unpriced: saved.unpriced ?? 0 };
}

function recordAICost(charge) {
  const day = aiUsageDay();
  const add = () => {
    if (day !== aiUsageDay()) return;
    const { costs, unpriced } = todayAIUsage(day);
    if (charge) costs[charge.currency] = (costs[charge.currency] ?? 0) + charge.amount;
    aiUsage = { day, costs, unpriced: unpriced + Number(charge === null) };
    store.set('aiUsage', aiUsage);
    renderAICost();
  };
  // Serialize updates from multiple tabs before writing the shared daily total.
  if (navigator.locks) void navigator.locks.request('hkt.aiUsage', add);
  else add();
}

function aiCostText() {
  const { costs, unpriced } = todayAIUsage();
  const parts = Object.entries(costs).map(([currency, cost]) =>
    cost > 0 && cost < 0.0001 ? `< ${currency} 0.0001` : `${currency} ${cost.toFixed(cost ? 4 : 2)}`);
  if (unpriced) parts.push(t(`${unpriced} 次費用未知`, `${unpriced} unpriced`));
  return parts.join(' · ') || '0.00';
}

function renderAICost() {
  const amount = $('ai-cost');
  if (!amount) return;
  const text = aiCostText();
  if (amount.textContent !== text) amount.textContent = text;
}

function setAIConfig(config, rejected = false) {
  if (JSON.stringify(state.aiConfig) === JSON.stringify(config) && state.aiKeyRejected === rejected) return;
  if (config) store.set('aiConfig', config);
  else store.remove('aiConfig');
  store.remove('deepseekKey');
  state.aiConfig = config;
  state.aiKeyRejected = rejected;
  recognition?.abort();
  if (state.thread?.busy && state.phase === 'understanding') state.phase = state.journeys.length ? 'done' : 'idle';
  if (state.discovery?.stage === 'finding') {
    planRun += 1;
    state.phase = 'idle';
  } else if (state.discovery?.stage === 'asking' && state.phase === 'failed') {
    state.phase = 'idle';
    state.error = null;
  }
  Object.assign(state, { chat: '', thread: null, talk: [], discovery: null, lastSearch: null, aiNotice: null });
  if (state.explore) {
    if (state.explore.preview?.kind === 'ai') clearExplorePreview(state.explore);
    state.explore.ai = null;
  }
  renderTab();
}

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
const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
// Far enough out for the longest trips across Hong Kong to fit on a phone.
const MIN_ZOOM = 9, SNUG_MARGIN = 56;
const wideLayout = window.matchMedia('(min-width: 820px)');

function mapPadding() {
  const wide = wideLayout.matches;
  const bottom = sheet.mapOnly ? $('app').clientHeight - $('open-panel').offsetTop + 10
    : wide ? 30 : sheet.targetHeight() + 32;
  return { top: wide ? 30 : 50, left: wide && !sheet.mapOnly ? 440 : 24, right: wide ? 30 : 24, bottom };
}
/** Legs the rider hasn't reached yet are drawn this faint while navigating. */
const UPCOMING_OPACITY = 0.4;

const ICONS = {
  route: ['M6 19a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z', 'M18 10a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z', 'M8.5 16.5H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5'],
  pin: ['M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21Z', 'M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z'],
  bus: ['M6 17V6.5A2.5 2.5 0 0 1 8.5 4h7A2.5 2.5 0 0 1 18 6.5V17a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1Z', 'M6 12h12', 'M8.5 18v2', 'M15.5 18v2', 'M9 15h.01', 'M15 15h.01'],
  star: ['M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9L12 3.5Z'],
  settings: ['M4 7h10', 'M18 7h2', 'M4 17h2', 'M10 17h10', 'M16 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z', 'M8 19.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z'],
  keyboard: ['M4 7h16a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z', 'M7 10.5h.01', 'M11 10.5h.01', 'M15 10.5h.01', 'M8 14h8'],
  backspace: ['M9 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-6-6 6-6Z', 'M12.5 10l4 4', 'M16.5 10l-4 4'],
  mic: ['M12 15a3.5 3.5 0 0 0 3.5-3.5v-5a3.5 3.5 0 0 0-7 0v5A3.5 3.5 0 0 0 12 15Z', 'M5.5 11.5a6.5 6.5 0 0 0 13 0', 'M12 18v3'],
  stop: ['M7 7h10v10H7z'],
  send: ['M12 19V5', 'M6 11l6-6 6 6'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'M20 20l-3.8-3.8'],
  swap: ['M8 4v15', 'M4 15l4 4 4-4', 'M16 20V5', 'M12 9l4-4 4 4'],
  locate: ['M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z', 'M12 3v3', 'M12 18v3', 'M3 12h3', 'M18 12h3', 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z'],
  walk: ['M13 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z', 'M9 21l2.5-6.5', 'M16 21l-2.5-6-1-5', 'M7 12l1.5-3.5 4-1.5 2.5 3.5 2.5 1'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  down: ['M6 9l6 6 6-6'],
  up: ['M6 15l6-6 6 6'],
  next: ['M9 6l6 6-6 6'],
  back: ['M15 6l-6 6 6 6'],
  spark: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z', 'M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2Z'],
  navigate: ['M12 3l7 18-7-4-7 4 7-18Z'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3 2'],
  arrow: ['M4.5 11.5L20 4l-7.5 15.5-2-6-6-2Z'],
};

function icon(key, size = 20, solid = false) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon${solid ? ' solid' : ''}`);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[key]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
const clear = (element, ...children) => element.replaceChildren(...children.flat(Infinity).filter(Boolean));
const distanceText = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const clock = (ms) => new Date(ms).toLocaleTimeString(state.lang === 'zh' ? 'zh-HK' : 'en-HK', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Hong_Kong' });
const isDarkText = (op) => op === 'ctb';

function badge(op, route) {
  const element = h('span', { class: `badge${isDarkText(op) ? ' dark' : ''}` }, lineName(op, route, state.lang));
  element.style.background = lineColor(op, route);
  return element;
}

const thumbs = new Map();

/** A re-render starts the thumb where it was, so it slides to the new choice. */
function segments(options, selected, choose) {
  const key = options.map(([value]) => value).join(), index = options.findIndex(([value]) => value === selected);
  const element = h('div', { class: 'segments' }, options.map(([value, label]) => h('button', {
    'aria-pressed': String(value === selected), onclick: () => choose(value),
  }, label)));
  element.style.setProperty('--n', options.length);
  element.style.setProperty('--i', thumbs.get(key) ?? index);
  thumbs.set(key, index);
  requestAnimationFrame(() => requestAnimationFrame(() => element.style.setProperty('--i', index)));
  return element;
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
      h('div', { class: `past${open ? ' open' : ''}` }, shown.map((text, index) => h('button', {
        class: 'chip', title: text, style: `--i:${Math.min(index, 6)}`, onmousedown: (event) => event.preventDefault(), onclick: () => pick(text),
      }, icon('clock', 13), h('span', {}, text.length > 14 ? `${text.slice(0, 14)}…` : text)))),
      hidden > 0 && h('button', {
        class: 'pill', 'aria-label': open ? t('收起', 'Less') : t(`更多 ${hidden} 項`, `${hidden} more`), onmousedown: (event) => event.preventDefault(),
        onclick: () => { open = !open; draw(); },
      }, open ? t('收起', 'Less') : `+${hidden}`),
      h('button', {
        class: 'pill round-pill', 'aria-label': t('清除記錄', 'Clear history'), onmousedown: (event) => event.preventDefault(),
        onclick: () => { history.clear(box); root.remove(); },
      }, icon('close', 13)));
  };
  draw();
  return root;
}

// MARK: Map

/** A small 3D bus built from CSS faces, so it turns with the road. */
function busMarker() {
  // Prefixed, as a class such as .back already means something else on this page.
  const faces = ['shadow', 'top', 'front', 'back', 'left', 'right'].map((face) => h('i', { class: `f-${face}` }));
  return h('div', { class: 'bus-marker' }, h('div', { class: 'bus3d' }, faces), h('span', { class: 'bus-note' }));
}

/** Both map engines put this element's origin at the selected coordinate. */
function explorePin(place, delay) {
  return h('div', { class: 'explore-pin', style: `--pin-delay:${delay}ms`, 'aria-hidden': 'true' },
    h('i', { class: 'explore-pin-ground' }),
    h('div', { class: 'explore-pin-drop' },
      h('div', { class: 'explore-pin-arrow' }, ['top', 'side', 'bevel', 'face'].map((face) => h('i', { class: face }))),
      h('span', { class: 'explore-pin-name' }, place.name)));
}

/** A stop still ahead of the coming bus, kept quieter than the stops on the rider's own trip. */
function upcomingStop(text) {
  const element = document.createElement('div');
  element.className = 'g-stop upcoming';
  const dot = document.createElement('div'), label = document.createElement('div');
  dot.className = 'g-dot';
  label.className = 'stop-label';
  label.textContent = text;
  element.append(dot, label);
  return element;
}

/** How long until the next bus, shown on the chosen stop. */
function arrivalTag() {
  const element = document.createElement('div');
  element.className = 'arrival-tag';
  return element;
}

function dressBus(element, vehicle) {
  const bus = element.querySelector('.bus3d'), note = element.querySelector('.bus-note');
  element.classList.toggle('other', !vehicle.isNext);
  bus.classList.toggle('minibus', vehicle.isMinibus);
  bus.style.setProperty('--body', vehicle.color);
  bus.style.setProperty('--heading', `${vehicle.heading}deg`);
  const prefix = vehicle.isLive ? '' : t('推算 ', 'About ');
  // Buses past the stop, or with no stop chosen, are simply shown where they are.
  note.textContent = vehicle.minutes == null ? '' : vehicle.minutes ? t(`${prefix}${vehicle.minutes} 分鐘到站`, `${prefix}${vehicle.minutes} min away`) : t('即將到站', 'Arriving');
}

const leafletMap = (() => {
  let map, content, base, preview = null, buses = new Map(), tag = null, chosen = null, approach = null, approachStops = [], approachKey = '', lastFit = '', flying = false;
  const darkMode = window.matchMedia('(prefers-color-scheme: dark)');
  const style = () => `https://tiles.openfreemap.org/styles/${darkMode.matches ? 'dark' : 'liberty'}`;
  /** The maps label everything in both languages; show just the one being read. */
  const localize = () => {
    const gl = base?.getMaplibreMap();
    if (!gl) return;
    const label = state.lang === 'zh'
      ? ['coalesce', ['get', 'name:zh-Hant'], ['get', 'name:zh'], ['get', 'name:nonlatin'], ['get', 'name'], ['get', 'name_en']]
      : ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']];
    for (const layer of gl.getStyle()?.layers ?? []) {
      // Road number shields use other fields, and keep them.
      if (layer.type === 'symbol' && JSON.stringify(layer.layout?.['text-field'] ?? '').includes('name')) gl.setLayoutProperty(layer.id, 'text-field', label);
    }
  };
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
      map = L.map('map', { zoomControl: false, attributionControl: true, minZoom: MIN_ZOOM, maxZoom: 19 }).setView([22.34, 114.15], 11);
      content = L.layerGroup().addTo(map);
      const markZoom = () => $('map').classList.toggle('far', map.getZoom() < 15);
      map.on('zoomend', markZoom);
      markZoom();
    },
    useBase() {
      if (base) return;
      base = L.maplibreGL({
        style: style(), localIdeographFontFamily: '-apple-system, "PingFang HK", "Noto Sans TC", sans-serif',
        attribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      }).addTo(map);
      const gl = base.getMaplibreMap();
      gl.on('style.load', localize);
      darkMode.addEventListener('change', () => gl.setStyle(style(), { diff: false }));
    },
    destroy() {
      map.remove();
      map = base = null;
      preview = null;
      const element = $('map');
      element.classList.remove('far', ...[...element.classList].filter((name) => name.startsWith('leaflet-')));
    },
    setLanguage() { localize(); },
    resize() { map?.invalidateSize(); },
    clear() {
      content?.clearLayers();
      buses = new Map();
      tag = null;
      chosen = null;
      approach = null;
      approachStops = [];
      approachKey = '';
    },
    previewPlace(place, delay = 0) {
      preview?.remove();
      preview = place ? L.marker(point(place.location), {
        icon: L.divIcon({ html: explorePin(place, delay), className: '', iconSize: [0, 0] }),
        interactive: false, keyboard: false, zIndexOffset: 1500,
      }).addTo(map) : null;
    },
    /** The chosen stop's pin, moved rather than redrawn. */
    chosen(place) {
      if (!place) {
        chosen?.remove();
        chosen = null;
      } else if (chosen) {
        chosen.setLatLng(point(place.location));
      } else {
        chosen = L.marker(point(place.location), { icon: pin('', 'pin end', '#ff3b30'), title: place.name, zIndexOffset: 500 }).addTo(content);
      }
    },
    tag(location, text) {
      if (!location) {
        tag?.marker.remove();
        tag = null;
        return;
      }
      if (!tag) {
        const element = arrivalTag();
        tag = { element, marker: L.marker(point(location), { icon: L.divIcon({ html: element, className: '', iconSize: [0, 0] }), interactive: false, zIndexOffset: 950 }).addTo(content) };
      }
      tag.marker.setLatLng(point(location));
      tag.element.textContent = text;
    },
    /** The road and stops still ahead of the coming bus, which go as it arrives. */
    approach(line, color, stops = []) {
      if (!line) {
        approach?.remove();
        approach = null;
      } else if (approach) {
        approach.setLatLngs(line.map(point));
      } else {
        approach = L.polyline(line.map(point), { color, weight: 4, opacity: 0.75 }).addTo(content);
      }
      const key = stops.map((stop) => stop.id).join();
      if (key === approachKey) return;
      approachKey = key;
      approachStops.forEach((marker) => marker.remove());
      approachStops = stops.map((stop) => L.marker(point(stop.location), { icon: L.divIcon({ html: upcomingStop(stop.name), className: '', iconSize: [0, 0] }), interactive: false }).addTo(content));
    },
    vehicles(list) {
      for (const [id, bus] of buses) {
        if (!list.some((vehicle) => vehicle.id === id)) {
          bus.marker.remove();
          buses.delete(id);
        }
      }
      for (const vehicle of list) {
        if (!buses.has(vehicle.id)) {
          const element = busMarker();
          buses.set(vehicle.id, { element, marker: L.marker(point(vehicle.location), { icon: L.divIcon({ html: element, className: 'bus-holder', iconSize: [0, 0] }), interactive: false, zIndexOffset: 900 }).addTo(content) });
        }
        const bus = buses.get(vehicle.id);
        bus.marker.setLatLng(point(vehicle.location));
        dressBus(bus.element, vehicle);
      }
    },
    fit(points, maxZoom = 16, isSnug = false) {
      if (!points.length) return;
      // Frame the part of the map the search card and panel leave uncovered.
      const { top, left, right, bottom } = mapPadding(), margin = isSnug ? SNUG_MARGIN : 0;
      const options = {
        maxZoom, paddingTopLeft: [left + margin, top + margin / 2],
        paddingBottomRight: [right + margin, bottom],
      };
      const bounds = L.latLngBounds(points.map(point));
      // Leaflet can't fly to where it already is: its path works out to NaN.
      const fit = `${bounds.toBBoxString()}|${options.paddingTopLeft}|${options.paddingBottomRight}`, still = fit === lastFit;
      lastFit = fit;
      if (calm.matches || !flying || still) map.fitBounds(bounds, { ...options, animate: false });
      else map.flyToBounds(bounds, { ...options, duration: 0.9, easeLinearity: 0.2 });
      flying = true;
    },
    follow(location, zoom = 16, isExact = false, offset = [0, sheet.targetHeight() / 2]) {
      // Centred in the part of the map the sheet leaves showing.
      const level = isExact ? zoom : Math.max(map.getZoom(), zoom);
      const target = map.unproject(map.project(point(location), level).add(offset), level);
      if (map.getCenter().distanceTo(target) <= 1 && map.getZoom() === level) return 0;
      if (calm.matches) {
        map.setView(target, level, { animate: false });
        return 0;
      }
      map.flyTo(target, level, { duration: 0.8 });
      return 800;
    },
    ends(from, to) {
      if (from) L.marker(point(from.location), { icon: pin('', 'pin start'), title: from.name, interactive: false, keyboard: false }).addTo(content);
      if (to) L.marker(point(to.location), { icon: pin('', 'pin end', '#ff3b30'), title: to.name, interactive: false, keyboard: false, zIndexOffset: 500 }).addTo(content);
    },
    path(path, choose, animate = false) {
      // A few station names always fit; a long bus route's only fit up close.
      $('map').classList.toggle('many-stops', path.segments.reduce((sum, s) => sum + s.stopIDs.length, 0) > 12);
      for (const segment of path.segments) {
        const line = (segment.line ?? segment.points).map(point), light = segment.upcoming ? UPCOMING_OPACITY : 1;
        L.polyline(line, { color: '#fff', weight: 8, opacity: 0.95 * light }).addTo(content);
        const isWalk = segment.mode === 'walk', drawOn = animate && !isWalk;
        for (const leg of segment.legs ?? [{ road: segment.line ?? segment.points, color: isWalk ? '#2f7bf6' : lineColor(segment.op, segment.route) }]) {
          const stroke = L.polyline(leg.road.map(point), {
            color: leg.color, weight: isWalk ? 4 : leg.weight ?? 5, dashArray: isWalk ? '1 9' : null, opacity: light, className: drawOn ? 'route-line' : '',
          }).addTo(content);
          // One unit long, so the line can be drawn on by animating its dash.
          if (drawOn) stroke.getElement()?.setAttribute('pathLength', 1);
        }
        segment.stopIDs.forEach((id, index) => {
          const dot = L.circleMarker(point(segment.marks?.[index] ?? segment.points[index + (segment.lead ?? 0)]), {
            radius: 4, color: segment.dots?.[index] ?? lineColor(segment.op, segment.route), fillColor: '#fff', fillOpacity: light, opacity: light, weight: 2,
            className: [animate && 'stop-dot', segment.upcoming && 'upcoming'].filter(Boolean).join(' '),
          }).bindTooltip(name(id), { permanent: true, direction: 'right', offset: [6, 0], className: 'stop-label', opacity: segment.upcoming ? 0.55 : 0.9 }).addTo(content);
          dot.getElement()?.style.setProperty('--i', Math.min(index, 14));
          if (choose) dot.on('click', () => choose(segment, index));
        });
        if (segment.mode === 'ride') {
          const chip = document.createElement('span');
          chip.className = `route-chip${isDarkText(segment.op) ? ' dark' : ''}`;
          chip.textContent = lineName(segment.op, segment.route, state.lang);
          chip.style.background = lineColor(segment.op, segment.route);
          L.marker(line[0], { icon: L.divIcon({ html: chip, className: '', iconSize: [0, 0] }), interactive: false, opacity: segment.upcoming ? 0.6 : 1 }).addTo(content);
        }
      }
    },
    numbered(suggestions, choose) {
      suggestions.forEach((suggestion, index) => {
        L.marker(point(suggestion.place.location), { icon: pin(String(index + 1), 'pin', '#007aff'), title: suggestion.place.name })
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
    home() { this.fit([{ lat: 22.2, lng: 113.92 }, { lat: 22.5, lng: 114.3 }], 12); },
    me(location) { L.marker(point(location), { icon: pin('', 'me'), interactive: false, zIndexOffset: 1000 }).addTo(content); },
  };
})();

/** The same map on Google's tiles, used while the server has allowance left. */
const googleMap = (() => {
  let map, Marker, preview = null, buses = new Map(), tag = null, chosen = null, glide = 0, hasFramed = false, approach = null, approachStops = [], approachKey = '', items = [];
  const keep = (item) => { items.push(item); return item; };
  const div = (className, text, color) => {
    const element = document.createElement('div');
    element.className = className;
    if (text) element.textContent = text;
    if (color) element.style.background = color;
    return element;
  };
  /** A zero-sized anchor, so markers sit on the point as they do on the other map. */
  const mark = (location, element, { zIndex, title, click, opacity } = {}) => {
    const anchor = div('g-anchor');
    if (opacity != null) anchor.style.opacity = opacity;
    anchor.append(element);
    if (title) element.title = title;
    const marker = keep(new Marker({ map, position: location, content: anchor, zIndex, gmpClickable: !!click }));
    if (click) {
      // A tap can arrive by either route, and should only count once.
      let tapped = 0;
      const tap = () => {
        if (performance.now() - tapped > 500) click();
        tapped = performance.now();
      };
      marker.addEventListener('gmp-click', tap);
      element.addEventListener('click', tap);
    }
    return marker;
  };
  const line = (path, options) => keep(new google.maps.Polyline({ map, path, clickable: false, ...options }));
  /** Eases the camera to a new view. The first view, or a finger on the map, stops it. */
  const moveSmoothly = (center, zoom) => {
    const run = ++glide;
    if (calm.matches || !hasFramed) {
      hasFramed = true;
      map.moveCamera({ center, zoom });
      return 0;
    }
    const from = map.getCenter(), fromZoom = map.getZoom(), started = performance.now();
    const fromLat = from.lat(), fromLng = from.lng();
    if (fromZoom === zoom && meters({ lat: fromLat, lng: fromLng }, center) <= 1) return 0;
    const step = (now) => {
      if (run !== glide) return;
      const part = Math.max(0, Math.min(1, (now - started) / 750)), eased = 1 - (1 - part) ** 3;
      map.moveCamera({
        center: { lat: fromLat + (center.lat - fromLat) * eased, lng: fromLng + (center.lng - fromLng) * eased },
        zoom: fromZoom + (zoom - fromZoom) * eased,
      });
      if (part < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return 750;
  };
  return {
    init() {
      Marker = google.maps.marker.AdvancedMarkerElement;
      map = new google.maps.Map($('map'), {
        center: { lat: 22.34, lng: 114.15 }, zoom: 11, minZoom: MIN_ZOOM, maxZoom: 19, mapId: 'DEMO_MAP_ID',
        disableDefaultUI: true, clickableIcons: false, gestureHandling: 'greedy', colorScheme: 'FOLLOW_SYSTEM',
      });
      const markZoom = () => $('map').classList.toggle('far', map.getZoom() < 15);
      map.addListener('zoom_changed', markZoom);
      map.addListener('dragstart', () => { glide += 1; });
      markZoom();
    },
    destroy() {
      this.previewPlace(null);
      glide += 1;
      this.clear();
      $('map').replaceChildren();
    },
    setLanguage() { /* Google sets labels as it loads, so a new language shows on the next visit. */ },
    resize() {},
    clear() {
      for (const item of items) {
        if (item.setMap) item.setMap(null);
        else item.map = null;
      }
      items = [];
      buses = new Map();
      tag = null;
      chosen = null;
      approach = null;
      approachStops = [];
      approachKey = '';
    },
    previewPlace(place, delay = 0) {
      if (preview) preview.map = null;
      if (!place) {
        preview = null;
        return;
      }
      const anchor = div('g-anchor');
      anchor.append(explorePin(place, delay));
      preview = new Marker({ map, position: place.location, content: anchor, zIndex: 1500 });
    },
    /** The chosen stop's pin, moved rather than redrawn. */
    chosen(place) {
      if (!place) {
        if (chosen) {
          chosen.map = null;
          items = items.filter((item) => item !== chosen);
        }
        chosen = null;
      } else if (chosen) {
        chosen.position = place.location;
      } else {
        chosen = mark(place.location, div('pin end', '', '#ff3b30'), { title: place.name, zIndex: 500 });
      }
    },
    tag(location, text) {
      if (!location) {
        if (tag) {
          tag.marker.map = null;
          items = items.filter((item) => item !== tag.marker);
        }
        tag = null;
        return;
      }
      if (!tag) {
        const element = arrivalTag();
        tag = { element, marker: mark(location, element, { zIndex: 950 }) };
      }
      tag.marker.position = location;
      tag.element.textContent = text;
    },
    /** The road and stops still ahead of the coming bus, which go as it arrives. */
    approach(path, color, stops = []) {
      if (!path) {
        approach?.setMap(null);
        items = items.filter((item) => item !== approach);
        approach = null;
      } else if (approach) {
        approach.setPath(path);
      } else {
        approach = line(path, { strokeColor: color, strokeWeight: 4, strokeOpacity: 0.75, zIndex: 1 });
      }
      const key = stops.map((stop) => stop.id).join();
      if (key === approachKey) return;
      approachKey = key;
      approachStops.forEach((marker) => { marker.map = null; });
      items = items.filter((item) => !approachStops.includes(item));
      approachStops = stops.map((stop) => mark(stop.location, upcomingStop(stop.name), { zIndex: 60 }));
    },
    vehicles(list) {
      for (const [id, bus] of buses) {
        if (!list.some((vehicle) => vehicle.id === id)) {
          bus.marker.map = null;
          items = items.filter((item) => item !== bus.marker);
          buses.delete(id);
        }
      }
      for (const vehicle of list) {
        if (!buses.has(vehicle.id)) {
          const element = busMarker();
          buses.set(vehicle.id, { element, marker: mark(vehicle.location, element, { zIndex: 900 }) });
        }
        const bus = buses.get(vehicle.id);
        bus.marker.position = vehicle.location;
        dressBus(bus.element, vehicle);
      }
    },
    fit(points, maxZoom = 16, isSnug = false) {
      if (!points.length) return;
      if (points.length === 1) return this.follow(points[0], maxZoom);
      // Worked out here, as Google's fitBounds lands the route under a sheet this tall.
      // Labels hang off a snug view's stops and buses, so it keeps clear of the sides.
      const margin = isSnug ? SNUG_MARGIN : 0, { top: topEdge, bottom, left: leftEdge, right: rightEdge } = mapPadding(), box = $('map');
      const left = leftEdge + margin, right = rightEdge + margin, top = topEdge + margin / 2;
      const toX = (lng) => (lng + 180) / 360;
      const toY = (lat) => 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI);
      const xs = points.map((p) => toX(p.lng)), ys = points.map((p) => toY(p.lat));
      const [west, east, north, south] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const fits = (pixels, span) => (span ? Math.log2(Math.max(1, pixels) / (256 * span)) : maxZoom);
      const room = (sideways, upright) => Math.min(fits(box.clientWidth - sideways, east - west), fits(box.clientHeight - upright, south - north));
      const exact = room(left + right, top + bottom);
      // Only a vector map holds a zoom between levels. Others round it, up as often as not, off the route.
      const canHoldExact = isSnug && map.getRenderingType?.() === google.maps.RenderingType?.VECTOR;
      // A whole level down halves the route, so it would give up the margin before that.
      const zoom = Math.max(MIN_ZOOM, Math.min(maxZoom, canHoldExact ? exact : Math.floor(room(leftEdge + rightEdge, topEdge + bottom))));
      const world = 256 * 2 ** zoom;
      const x = (west + east) / 2 + (right - left) / 2 / world, y = (north + south) / 2 + (bottom - top) / 2 / world;
      const center = { lat: (Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) * 360) / Math.PI - 90, lng: x * 360 - 180 };
      moveSmoothly(center, zoom);
    },
    follow(location, zoom = 16, isExact = false, offset = [0, sheet.targetHeight() / 2]) {
      const level = isExact ? zoom : Math.max(map.getZoom(), zoom), world = 256 * 2 ** level;
      const y = 0.5 - Math.log(Math.tan(Math.PI / 4 + (location.lat * Math.PI) / 360)) / (2 * Math.PI) + offset[1] / world;
      return moveSmoothly({
        lat: (Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) * 360) / Math.PI - 90,
        lng: location.lng + offset[0] * 360 / world,
      }, level);
    },
    ends(from, to) {
      if (from) mark(from.location, div('pin start'), { title: from.name, zIndex: 400 });
      if (to) mark(to.location, div('pin end', '', '#ff3b30'), { title: to.name, zIndex: 500 });
    },
    path(path, choose, animate = false) {
      $('map').classList.toggle('many-stops', path.segments.reduce((sum, s) => sum + s.stopIDs.length, 0) > 12);
      for (const segment of path.segments) {
        const color = lineColor(segment.op, segment.route), isWalk = segment.mode === 'walk', road = segment.line ?? segment.points, light = segment.upcoming ? UPCOMING_OPACITY : 1;
        if (isWalk) {
          line(road, {
            strokeOpacity: 0, zIndex: 2,
            icons: [{ icon: { path: google.maps.SymbolPath.CIRCLE, scale: 2, fillColor: '#2f7bf6', fillOpacity: light, strokeOpacity: 0 }, repeat: '11px' }],
          });
        } else {
          line(road, { strokeColor: '#fff', strokeWeight: 8, strokeOpacity: 0.95 * light, zIndex: 1 });
          (segment.legs ?? [{ road, color, weight: 5 }]).forEach((leg, index) => line(leg.road, { strokeColor: leg.color, strokeWeight: leg.weight, strokeOpacity: light, zIndex: 2 + index }));
        }
        segment.stopIDs.forEach((id, index) => {
          const stop = div(`g-stop${animate ? ' popping' : ''}`);
          stop.style.setProperty('--i', Math.min(index, 14));
          const dot = div('g-dot');
          dot.style.borderColor = segment.dots?.[index] ?? color;
          stop.append(dot, div('stop-label', name(id)));
          mark(segment.marks?.[index] ?? segment.points[index + (segment.lead ?? 0)], stop, { zIndex: 100, opacity: segment.upcoming ? 0.55 : null, click: choose && (() => choose(segment, index)) });
        });
        if (segment.mode === 'ride') {
          const chip = div(`route-chip${isDarkText(segment.op) ? ' dark' : ''}`, lineName(segment.op, segment.route, state.lang), color);
          mark(segment.points[0], chip, { zIndex: 200, opacity: segment.upcoming ? 0.6 : null });
        }
      }
    },
    numbered(suggestions, choose) {
      suggestions.forEach((suggestion, index) => {
        mark(suggestion.place.location, div('pin', String(index + 1), '#007aff'), { title: suggestion.place.name, zIndex: 300, click: () => choose(suggestion) });
      });
    },
    stops(list, center, radius, choose) {
      keep(new google.maps.Circle({ map, center, radius, strokeColor: '#2f7bf6', strokeWeight: 1, fillColor: '#2f7bf6', fillOpacity: 0.06, clickable: false }));
      const nearest = list.slice(0, 120), isRail = (s) => ['mtr', 'lightRail'].includes(primaryMode(s.site));
      for (const stop of [...nearest.filter((s) => !isRail(s)), ...nearest.filter(isRail)]) {
        const mode = primaryMode(stop.site);
        const color = { mtr: OP_COLORS.mtr, lightRail: OP_COLORS.lightRail, minibus: OP_COLORS.gmb, bus: OP_COLORS.kmb }[mode];
        const dot = div(`g-pick${isRail(stop) ? ' rail' : ''}`, '', color);
        mark(stop.site.location, dot, { title: nameText(stop.site.name, state.lang), zIndex: isRail(stop) ? 60 : 50, click: () => choose(stop) });
      }
    },
    home() { this.fit([{ lat: 22.2, lng: 113.92 }, { lat: 22.5, lng: 114.3 }], 12); },
    me(location) { mark(location, div('me'), { zIndex: 1000 }); },
  };
})();

let mapView = leafletMap;

function loadGoogle(key) {
  return new Promise((resolve, reject) => {
    window.hktGoogleReady = resolve;
    const script = document.createElement('script');
    const language = state.lang === 'en' ? 'en' : state.script === 'hans' ? 'zh-CN' : 'zh-HK';
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&libraries=marker&language=${language}&region=HK&callback=hktGoogleReady`;
    script.onerror = reject;
    document.head.append(script);
  });
}

/** Puts the map where the rider expects it after the map underneath changes. */
function frameMap() {
  drawMap();
  const view = state.explore;
  if (view?.preview) void focusExploredPlace(view, view.preview.item, view.preview.kind);
  else if (state.tab === 'plan' && (state.from || state.to)) fitPlanMap();
  else showHomeMap();
}

// Shops keep Google's data after the map loads run out, shown on its free embedded map.
let spareEmbedKey = null;
const embedShops = () => !state.google && !!state.embedKey;
const googleShops = () => state.google || !!state.embedKey;

function useFreeMap() {
  state.google = false;
  state.embedKey = spareEmbedKey;
  const wasGoogle = mapView === googleMap;
  if (wasGoogle) {
    googleMap.destroy();
    mapView = leafletMap;
    leafletMap.init();
  }
  leafletMap.useBase();
  if (wasGoogle) {
    if (state.candidates.some((journey) => journey.provider === 'google' || (!journey.provider && journey.legs.some((leg) => leg.walkFromMap)))) runPlan({ kind: 'replan' });
    frameMap();
  }
}

// Google calls this when it refuses the key, such as at its own quota.
let googleRefused = false;
window.gm_authFailure = () => {
  googleRefused = true;
  useFreeMap();
};

async function useGoogleMap(shared) {
  try {
    await loadGoogle(shared.mapKey);
    if (googleRefused) return;
    leafletMap.destroy();
    mapView = googleMap;
    googleMap.init();
    state.google = shared.places === true;
    frameMap();
  } catch {
    useFreeMap();
  }
}

// MARK: Location

/** One position per visit; only the location buttons and navigation ask again. */
let fixRequest = null;
function getFix(refresh = false) {
  if (state.fix && !refresh) return Promise.resolve(state.fix);
  return fixRequest ??= new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition((position) => {
      state.fix = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy };
      resolve(state.fix);
    }, () => resolve(state.fix), { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 });
  }).finally(() => { fixRequest = null; });
}

/** Asks as the page opens, and moves the map only if the rider hasn't started on something. */
async function locateOnOpen() {
  const fix = await getFix();
  if (!fix) return;
  drawMap();
  if (state.tab === 'plan' && !state.from && !state.to && !state.destination && state.phase === 'idle' && inHongKong(fix)) mapView.follow(fix, 15);
}

/** What the server shares with every visitor. Elsewhere, such as GitHub Pages, there is no server. */
async function checkServer() {
  let shared = null;
  try {
    const response = await fetch('api/ai', { signal: AbortSignal.timeout(3000) });
    if (response.ok) shared = await response.json();
  } catch { /* The page works without it. */ }
  state.transitous = shared?.transitous === true;
  spareEmbedKey = shared?.embedKey ?? null;
  if (shared?.mapKey) useGoogleMap(shared);
  else useFreeMap();
}

// MARK: Data

const DB_SOURCES = ['https://data.hkbus.app/routeFareList.min.json', 'https://hkbus.github.io/hk-bus-crawling/routeFareList.min.json'];
const worker = new Worker(new URL('./planner.worker.js?v=dev', import.meta.url), { type: 'module' });
let requestID = 0;
const pending = new Map();
worker.onmessage = ({ data }) => {
  const done = pending.get(data.id);
  pending.delete(data.id);
  clearTimeout(done?.timeout);
  if (data.error) done?.reject(new Error(data.error));
  else done?.resolve(data);
};
const ask = (message, patience) => new Promise((resolve, reject) => {
  const id = ++requestID;
  const timeout = patience && setTimeout(() => {
    pending.delete(id);
    reject(new Error('Built-in planner timed out'));
  }, patience);
  pending.set(id, { resolve, reject, timeout });
  worker.postMessage({ ...message, id });
});

let shuttleDB = null;
function planningDB() {
  return state.eduhkShuttle && state.db ? (shuttleDB ??= withEdUHKShuttle(state.db)) : state.db;
}

async function loadDB() {
  for (const source of DB_SOURCES) {
    try {
      const response = await fetch(source);
      if (!response.ok) continue;
      state.db = normalizeDB(await response.json());
      shuttleDB = null;
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

let planRun = 0, transitRequest, plannedInputs;
let replanEdUHK = false;
const SAME_PLACE_METERS = 30;
const railFares = new Map(), railFareRequests = new Set();
const usesRail = (journey) => rides(journey).some((ride) => ride.op === 'mtr' || ride.op === 'lightRail');

function loadRailFares() {
  const profile = state.fareProfile;
  if (railFares.has(profile) || railFareRequests.has(profile)) return;
  railFareRequests.add(profile);
  fetch(`api/fares?profile=${profile}`, { signal: AbortSignal.timeout(8000) })
    .then((response) => response.ok ? response.json() : null)
    .then((data) => { if (data?.fares) railFares.set(profile, data.fares); })
    .catch(() => {})
    .finally(() => {
      railFareRequests.delete(profile);
      if (state.tab === 'plan' && state.fareProfile === profile && state.journeys.some(usesRail)) renderSheet();
    });
}

/** Places picked from a list, by name, as a search by name could land on another branch. */
const pickedPlaces = new Map();

async function resolvePlace(text) {
  if (pickedPlaces.has(text)) return pickedPlaces.get(text);
  const site = exactSite(text, siteIndex());
  if (site) return { name: nameText(site.name, state.lang), location: site.location };
  // Google finds places while its free allowance lasts; the free sources take over after that.
  const near = state.fix && inHongKong(state.fix);
  const found = (await googleSearch(text, near ? state.fix : HONG_KONG, near ? 5000 : 50_000, state.lang))?.[0];
  if (found) return { name: found.name, location: found.location };
  const place = await lookupPlace(text);
  if (place) return state.lang === 'zh' ? { name: text, location: place.location } : place;
  const partial = partialSite(text, siteIndex());
  return partial ? { name: nameText(partial.name, state.lang), location: partial.location } : null;
}

async function here() {
  const fix = await getFix();
  return fix ? { name: t('我的位置', 'My location'), location: { lat: fix.lat, lng: fix.lng } } : null;
}

function resetPlan(keepExplore = false) {
  transitRequest?.abort();
  clearMapStop();
  if (!keepExplore) clearExplore();
  Object.assign(state, { focus: null, journeys: [], candidates: [], allowLongWalk: false, onMap: null, pickedJourney: false, expanded: null, explanation: null, aiNotice: null, from: null, to: null, error: null, arrivals: null, planDirty: false });
}

function showRouteView() {
  if (!whenOpen && !state.explore) sheet.snap('half');
  if (state.routeView) return;
  state.routeView = true;
  renderPlanTop();
  slideView('forward');
}

/** Slides the sheet's content in from the side it logically came from. */
function slideView(direction) {
  for (const id of ['top', 'sheet']) {
    const element = $(id);
    element.classList.remove('view-forward', 'view-back');
    void element.offsetWidth; // Restart the animation if one is running.
    element.classList.add(`view-${direction}`);
    setTimeout(() => element.classList.remove(`view-${direction}`), 500);
  }
}

let staggerNext = false;
const stagger = () => { staggerNext = true; };

/** Back to the home sheet. */
function closeTrip() {
  planRun++;
  stopNavigation();
  resetPlan();
  Object.assign(state, { origin: '', destination: '', when: null, discovery: null, lastSearch: null, lastChat: null, talk: [], thread: null, routeView: false, phase: 'idle' });
  whenOpen = false;
  stagger();
  renderTab();
  slideView('back');
  sheet.snap('half');
  showHomeMap();
}

function setPhase(phase, error = null) {
  if (phase === 'failed') answer(error);
  state.phase = phase;
  state.error = error;
  renderSheet();
  showEmbed();
}

function currentTrip() {
  const destination = state.destination.trim();
  return destination ? { origin: normalizedOrigin(state.origin), destination, preference: state.preference } : null;
}

/** Replanning reuses the resolved places from the current trip. */
async function runPlan(request) {
  if (request.kind === 'replan' && (state.planDirty || state.nav)) return;
  const ai = client(), isChat = request.kind === 'chat', key = state.aiConfig, phaseBefore = state.phase;
  if (isChat && !ai) return;
  clearTimeout(whenTimer);
  const run = ++planRun, stale = () => run !== planRun;
  const previous = request.kind === 'replan' ? { start: state.from, end: state.to } : null;
  const startOver = () => {
    const notice = state.aiNotice;
    stopNavigation();
    const sameDestination = state.explore && (previous?.end ?? request.place) === state.explore.destination;
    resetPlan(sameDestination);
    state.aiNotice = notice;
    // A place already known stays reachable even if the trip to it can't be planned.
    if (request.place) state.to = request.place;
    renderNearStops();
  };
  state.aiNotice = null;
  if (!isChat) {
    if (!previous) state.thread = null;
    startOver();
  }
  renderBottomStatus();
  setPhase('understanding');
  let intent = null, wish = null;

  if (request.kind === 'place') {
    intent = { origin: normalizedOrigin(state.origin), destination: request.place.name, preference: state.preference };
  } else if (isChat && ai) {
    // Only the chat box needs the AI: the search box holds a place, and the planner does the rest.
    try {
      const reply = await ai.chat(chatMessage(request.text, request.current, request.context));
      if (stale() || key !== state.aiConfig) return;
      // Small talk changes nothing, so what is on screen stays.
      if (reply.say) {
        state.discovery = request.discovery;
        state.phase = phaseBefore === 'done' ? 'done' : 'idle';
        answer(reply.say);
        return renderSheet();
      }
      wish = reply.wish ?? null;
      intent = reply.trip ?? null;
    } catch (error) {
      if (stale() || key !== state.aiConfig) return;
      state.aiNotice = aiErrorMessage(error.status);
    }
  }
  if (stale()) return;
  if (isChat) startOver();
  if (wish) return startDiscovery({ ...wish, asked: request.asked, question: request.context.mayAsk ? wish.question : null }, run);
  if (!intent && isChat) {
    // Without the AI, an answer to "where?" can only be a place.
    if (request.asked) return discover({ ...request.wish, area: request.text, question: null }, run);
    const guess = parseWish(request.text) ?? (googleShops() && !request.current ? parseSearch(request.text) : null);
    if (guess) return startDiscovery(guess, run);
    intent = parseFollowUp(request.text, request.current);
  }
  intent ??= currentTrip();
  if (!intent) return setPhase('failed', t('請輸入目的地，例如「由旺角去理大」。', 'Enter a destination, e.g. "Mong Kok to PolyU".'));
  if (request.kind === 'chat') {
    state.origin = intent.origin ?? '';
    state.destination = intent.destination;
  }
  showRouteView();
  syncPlaceInputs();
  state.preference = intent.preference;

  const inputs = [state.origin, state.destination];
  setPhase('locating');
  const noLocation = t('未能取得你的位置：請允許定位，或在上方輸入起點。', "Couldn't get your location: allow Location access, or type a start above.");
  const startRequest = Promise.resolve(previous?.start ?? request.start ?? (intent.origin ? resolvePlace(intent.origin) : here())).catch(() => null);
  // A shop on screen is already known, so it needs no search.
  let end = previous?.end ?? request.place ?? request.shops?.find((shop) => shop.name === intent.destination);
  if (!end) end = isCurrentLocation(intent.destination) ? await here() : await resolvePlace(intent.destination);
  if (stale()) return;
  if (!end) return setPhase('failed', t(`找不到目的地「${intent.destination}」。`, `Couldn't find "${intent.destination}".`));
  state.to = end;
  renderNearStops();
  const start = await startRequest;
  if (stale()) return;
  if (!start) return setPhase('failed', intent.origin ? t(`找不到起點「${intent.origin}」。`, `Couldn't find the start "${intent.origin}".`) : noLocation);
  state.from = start;
  // A search can land somewhere other than the words typed, so the boxes say where it went.
  if (request.kind === 'search') {
    if (intent.origin && state.origin === inputs[0]) state.origin = inputs[0] = start.name;
    if (state.destination === inputs[1]) state.destination = inputs[1] = end.name;
    syncPlaceInputs();
  }
  plannedInputs = inputs;
  if (state.tab === 'plan' && !state.explore?.preview) mapView.fit([start.location, end.location]);
  if (!inHongKong(start.location) || !inHongKong(end.location)) return setPhase('failed', t('起點及目的地須在香港範圍內。', 'The start and destination must be in Hong Kong.'));
  if (meters(start.location, end.location) < SAME_PLACE_METERS) return setPhase('failed', t('出發地和目的地是同一個地方。', 'The start and destination are the same place.'));

  setPhase('planning');
  const now = Date.now();
  if (state.when?.at <= now) {
    state.when = null;
    renderWhen();
    showToast(t('所選時間已過，改為現在出發。', 'That time has passed, so this leaves now.'));
  }
  const { mode, at } = state.when ?? {};
  const preference = state.preference;
  const departure = mode === 'depart' ? at : now, arriveBy = mode === 'arrive' ? at : null;
  const local = async () => (await ask({
    type: 'plan', from: start.location, to: end.location, preference, preferredMode: state.transitMode, departure, arriveBy, includeEdUHK: state.eduhkShuttle,
  }, 6000)).journeys;
  transitRequest = new AbortController();
  const options = { preference, mode, at, lang: state.lang, signal: transitRequest.signal };
  const providers = [];
  if (state.transitous) providers.push(async () => transitousJourneys(
    await requestTransitous(start.location, end.location, options), state.db, departure, arriveBy, now,
  ));
  if (mapView === googleMap) providers.push(async () => {
    if (mapView !== googleMap) return [];
    const routes = await requestGoogleTransit(start.location, end.location, options);
    return mapView === googleMap ? googleJourneys(routes, state.db, departure, arriveBy, now) : [];
  });
  providers.push(local);

  const batches = await Promise.allSettled(providers.map((provider) => provider()));
  if (stale()) return;
  const rawPlans = batches.flatMap((batch) => batch.status === 'fulfilled' ? batch.value : [])
    .filter((journey) => (journey.provider !== 'google' || mapView === googleMap) && (state.eduhkShuttle || !includesEdUHK(journey)));
  const found = (await Promise.all(rawPlans.map((journey) => includesEdUHK(journey) ? retime(journey, () => null) : journey)))
    .filter((journey) => !journey.missedConnection);
  if (stale()) return;
  if (!found.length) {
    return setPhase('failed', t('找不到可搭乘的公共交通路線，請試另一個時間或上車地點。', 'No public transport route found. Try another time or boarding location.'));
  }
  if (found.some(usesRail)) loadRailFares();
  showTripOptions(found);
  setPhase('checkingLive');
  fitPlanMap();

  const arrivals = state.arrivals = liveArrivalCache(state.db, state.lang);
  const candidates = (await Promise.all(found.map((journey) => (
    journey.departure - now <= LIVE_AHEAD_MS ? retime(journey, arrivals) : journey
  )))).filter((journey) => !journey.missedConnection && (state.eduhkShuttle || !includesEdUHK(journey)));
  if (stale()) return;
  if (!candidates.length) {
    showTripOptions([]);
    if (state.nav) return setPhase('done', t('未能確認原定班次，請留意站內資訊。', "The original departure couldn't be confirmed. Check the information at the stop."));
    return setPhase('failed', t('這些班次已趕不上，請重新搜尋。', 'Those departures can no longer be reached. Search again.'));
  }
  const moved = showTripOptions(candidates, true);
  setPhase('done');
  if (moved && !mapTouched) fitPlanMap();
  void useWalkTimes();
  const [best] = state.journeys;
  if (!best) {
    answer(t('找到路線，但需要走較遠的路。可以查看步行較長的方案。', 'Routes are available with a longer walk. You can review those options.'));
    return;
  }
  const minutes = Math.round(totalMinutes(best)), changes = transfers(best);
  answer(t(
    `${start.name}到${end.name}：最佳方案 ${minutes} 分鐘，${changes ? `轉 ${changes} 次車` : '直達'}。`,
    `${start.name} to ${end.name}: best option ${minutes} min, ${changes ? `${changes} change${changes > 1 ? 's' : ''}` : 'direct'}.`,
  ));
}

function showTripOptions(candidates, keepSelection = false) {
  state.candidates = candidates;
  const ranked = rankCombinedTripOptions(candidates, state.preference, 8, state.transitMode);
  state.journeys = (state.allowLongWalk ? ranked : ranked.filter(fitsWalkLimit)).slice(0, 5);
  const nav = state.nav;
  if (nav && !state.journeys.some((journey) => journeyID(journey) === nav.id)) {
    state.journeys = [nav.journey, ...state.journeys.slice(0, 4)];
  }
  const selected = (nav || (keepSelection && state.pickedJourney)) && state.journeys.some((journey) => journeyID(journey) === state.onMap);
  const id = selected ? state.onMap : nav?.id ?? (state.journeys[0] ? journeyID(state.journeys[0]) : null);
  const changed = id !== state.onMap;
  if (changed) {
    state.pickedJourney = false;
    state.expanded = null;
    state.focus = null;
    clearMapStop();
  }
  state.onMap = id;
  if (nav) renderNavBanner();
  writeAdvice();
  return changed;
}

function writeAdvice() {
  state.explanation = planAdvice(state.journeys, t, (ride) => lineName(ride.op, ride.route, state.lang), Date.now());
}

// MARK: Finding places


/** The AI decides whether it needs to ask anything. If not, the search starts at once. */
function startDiscovery(wish, run) {
  if (!wish.question) return discover(wish, run);
  remember('App', `Asked: ${wish.question}`);
  state.discovery = { stage: 'asking', wish };
  answer(null);
  setPhase('idle');
  renderBottomStatus();
}

const MOST_SHOPS = 16, NEARBY_METERS = 5000;

async function discover(wish, run = ++planRun) {
  const stale = () => run !== planRun;
  const giveUp = (message) => {
    state.discovery = { stage: 'asking', wish: { ...wish, area: null, question: null, options: [] } };
    setPhase('failed', message);
    renderBottomStatus();
  };
  const notice = state.aiNotice;
  resetPlan();
  state.aiNotice = notice;
  state.discovery = { stage: 'finding', wish };
  setPhase('findingPlaces');
  renderBottomStatus();

  const place = cleanArea(wish.area ?? '附近');
  let searchArea;
  if (wish.anywhere) {
    const near = state.fix && inHongKong(state.fix);
    searchArea = { name: t('全港', 'Hong Kong'), center: near ? state.fix : HONG_KONG, radius: 50_000, isAroundRider: true };
  } else if (isNearby(place)) {
    const fix = await getFix();
    if (stale()) return;
    if (!fix) return giveUp(t('未能取得你的位置，請選擇一個地區或輸入範圍。', "Couldn't get your location. Pick a district or type an area."));
    // "Nearby" means within 5 km of the rider.
    searchArea = { name: t('5 公里內', 'Within 5 km'), center: { lat: fix.lat, lng: fix.lng }, radius: NEARBY_METERS, isAroundRider: true };
  } else {
    const resolved = await resolvePlace(place);
    if (stale()) return;
    if (!resolved) return giveUp(t(`找不到「${place}」，請換一個範圍。`, `Couldn't find "${place}". Try another area.`));
    searchArea = { name: resolved.name, center: resolved.location, radius: 2500 };
  }

  // Each Google search brings a full page for the price of one.
  let suggestions = [];
  if (googleShops()) {
    // Chinese and English names reach different shops, and Google's own order is by relevance.
    const search = (query) => googleSearch(searchArea.isAroundRider ? query : `${query} ${searchArea.name}`, searchArea.center, searchArea.radius, state.lang, true);
    const [chinese, english] = await Promise.all([search(wish.query), wish.queryEn ? search(wish.queryEn) : null]);
    if (stale()) return;
    suggestions = mergeShops(insideArea(chinese ?? [], searchArea), insideArea(english ?? [], searchArea), MOST_SHOPS)
      .map((place) => ({ place, isGoogle: true }));
  }
  if (!suggestions.length) {
    const found = new Map();
    for (const term of wish.searchTerms) {
      for (const item of withinArea(await photonSearch(term, searchArea.center, searchArea.radius), searchArea)) {
        found.set(`${item.location.lat},${item.location.lng}`, item);
      }
    }
    if (stale()) return;
    suggestions = [...found.values()].sort((a, b) => a.meters - b.meters).slice(0, MOST_SHOPS).map((place) => ({ place }));
    if (!suggestions.length) return giveUp(t(`${searchArea.name}找不到${wish.want}，請換一個範圍。`, `Couldn't find ${wish.want} around ${searchArea.name}. Try another area.`));
  }
  state.discovery = { stage: 'choosing', wish, areaName: searchArea.name, center: searchArea.center, suggestions };
  state.lastSearch = state.discovery;
  answer(t(`找到 ${suggestions.length} 個「${wish.want}」的結果，點選就可以看路線。`, `Found ${suggestions.length} for "${wish.want}". Tap one for a route.`));
  stagger();
  setPhase('idle');
  renderBottomStatus();
  sheet.snap('half');
  if (showsEmbed()) showEmbed();
  else mapView.fit(suggestions.map((suggestion) => suggestion.place.location));
}

const showsEmbed = () => embedShops() && state.tab === 'plan' && !state.explore && state.discovery?.stage === 'choosing' && !state.journeys.length
  && state.phase === 'idle' && state.discovery.suggestions.some((suggestion) => suggestion.isGoogle);

function showEmbed() {
  const on = showsEmbed(), box = $('embed-map'), frame = box.firstElementChild;
  box.hidden = !on;
  $('app').classList.toggle('embedding', on);
  if (!on) return;
  frame.style.height = `${Math.max(160, window.innerHeight - sheet.targetHeight())}px`;
  const { wish, center, shown } = state.discovery;
  const language = state.lang === 'en' ? 'en' : state.script === 'hans' ? 'zh-CN' : 'zh-HK';
  const common = `key=${encodeURIComponent(state.embedKey)}&language=${language}&region=HK`;
  const url = shown ? `https://www.google.com/maps/embed/v1/place?${common}&q=place_id:${encodeURIComponent(shown)}`
    : `https://www.google.com/maps/embed/v1/search?${common}&q=${encodeURIComponent(wish.query)}&center=${center.lat},${center.lng}&zoom=14`;
  if (frame.src !== url) frame.src = url;
}

function showOnEmbed(suggestion) {
  state.discovery.shown = suggestion.place.id;
  sheet.snap('half');
  showEmbed();
}

const FREE_PLACE_WITHIN = 500;

/** Google's places stay off other maps, so the route goes to the same shop as the free sources know it. */
async function planToShop({ place }) {
  const discovery = state.discovery;
  const found = (await lookupPlace(place.name)) ?? (place.address ? await lookupPlace(place.address) : null);
  if (state.discovery !== discovery) return;
  if (!found || meters(found.location, place.location) > FREE_PLACE_WITHIN) {
    discovery.notice = t(`免費地圖找不到「${place.name}」，請用「在 Google 地圖查看」導航。`, `The free map can't find ${place.name}. Use View on Google Maps for directions.`);
    return renderSheet();
  }
  state.destination = found.name;
  syncPlaceInputs();
  runPlan({ kind: 'place', place: { name: found.name, location: found.location } });
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
  const journey = state.journeys.find((j) => journeyID(j) === state.onMap);
  return journey && state.from && state.to ? journeyPath(journey, state.from.location, state.to.location, planningDB()) : null;
}

const VEHICLE_REFRESH = 30_000, SAME_ARRIVAL_MS = 90_000;
let shownVehicles = [], gliding = false, lastGlide = 0, lastBusID = 0;
let vehicleTrack = null, vehicleList = [], vehicleKey = '', vehicleArrivals = [], vehicleFetched = 0, vehicleFetching = '';
const arrivalsSeen = new Map();

/**
 * The route whose buses are on the map. On a planned trip that is always the bus the rider is waiting
 * for: tapping a stop only shows that stop's arrivals, and the bus and its road stay as they were.
 */
function rideOnScreen() {
  if (state.tab === 'plan') {
    if (state.planDirty && !state.nav) return null;
    const journey = state.journeys.find((j) => journeyID(j) === state.onMap);
    // The buses out there now are not the ones a later trip will catch.
    if (!journey || (!state.nav && journey.departure - Date.now() > LIVE_AHEAD_MS)) return null;
    return rides(journey).find((ride) => ride.routeKey && !['mtr', 'lightRail', 'eduhk'].includes(ride.op));
  }
  const focus = state.focus, route = focus && state.db?.routes[focus.routeKey];
  if (!route || ['mtr', 'lightRail'].includes(focus.op)) return null;
  return { routeKey: focus.routeKey, route: route.route, op: focus.op, boardPosition: focus.position };
}

/** Asks for arrivals along the whole route, now and then, and places every bus between times. */
function moveVehicles() {
  if (document.hidden) return; // Nobody is looking, so ask the operators for nothing.
  showArrivalTag();
  const ride = rideOnScreen(), route = ride && state.db.routes[ride.routeKey];
  if (!route) {
    vehicleKey = '';
    vehicleTrack = null;
    vehicleList = [];
    shownVehicles = [];
    mapView.approach(null);
    return mapView.vehicles([]);
  }
  const key = `${ride.routeKey}|${ride.op}`;
  if (key !== vehicleKey) {
    vehicleKey = key;
    vehicleList = [];
    // These buses aren't on this route, so none of them may carry over as the same bus.
    shownVehicles = [];
    mapView.vehicles([]);
    // Coming back to a route shows its buses at once, as the times are still good.
    ({ arrivals: vehicleArrivals, at: vehicleFetched } = arrivalsSeen.get(key) ?? { arrivals: [], at: 0 });
  }
  vehicleTrack = trackOf(route, ride.op);
  if (!vehicleTrack) {
    // A provider's trip line may start at the boarding stop, past the approach.
    void loadShape(route, ride.op);
    return mapView.approach(null);
  }
  if (vehicleFetching !== key && Date.now() - vehicleFetched > VEHICLE_REFRESH) {
    vehicleFetching = key;
    routeArrivals(route, ride.op, state.db, state.lang).then((arrivals) => {
      arrivalsSeen.set(key, { arrivals, at: Date.now() });
      if (key === vehicleKey) vehicleArrivals = arrivals;
    }).catch(() => {}).finally(() => {
      if (vehicleFetching === key) vehicleFetching = '';
      if (key !== vehicleKey) return;
      vehicleFetched = Date.now();
      moveVehicles();
    });
  }
  const shownTime = state.tab === 'plan' ? ride.liveDeparture : chosenStopArrival();
  vehicleList = vehiclesOnRoute(vehicleArrivals, ride, state.db, Date.now(), vehicleTrack).map((vehicle) => {
    // The two answers can be up to a refresh apart; the stop, the sheet and the bus say the same.
    const isShownBus = vehicle.isNext && shownTime && Math.abs(shownTime - vehicle.arrival) < SAME_ARRIVAL_MS;
    return isShownBus ? { ...vehicle, minutes: minutesUntil(shownTime), isLive: true } : vehicle;
  });
  glideVehicles();
  const coming = shownVehicles.find((vehicle) => vehicle.isNext);
  if (state.tab !== 'plan' || !coming || !vehicleTrack.passes[ride.boardPosition] || coming.position >= ride.boardPosition) {
    return mapView.approach(null);
  }
  const firstStop = Math.ceil(coming.position), ids = route.stops[ride.op];
  const ahead = ids.slice(firstStop, ride.boardPosition).flatMap((id, index) => {
    const location = stopOnRoad(route, ride.op, firstStop + index);
    return location ? [{ id, location, name: name(id) }] : [];
  });
  mapView.approach(trackBetween(vehicleTrack, coming.position, ride.boardPosition), coming.color, ahead);
}

let tagKey = '', tagArrivals, tagFetched = 0, tagShown = '';

/** When the next bus reaches the chosen stop. The stop, the sheet and the bus all read this one time. */
const chosenStopArrival = () => tagArrivals?.find(stillDue)?.date ?? null;

/** On the chosen stop and in the sheet: how long until the next bus. */
function showArrivalTag() {
  const focus = state.focus, route = focus && state.db?.routes[focus.routeKey];
  if (!route || focus.position == null) {
    tagKey = '';
    tagArrivals = undefined;
    return mapView.tag(null);
  }
  const key = `${focus.routeKey}|${focus.op}|${focus.position}`;
  if (key !== tagKey) {
    tagKey = key;
    tagArrivals = undefined;
    tagFetched = 0;
    tagShown = '';
  }
  if (Date.now() - tagFetched > VEHICLE_REFRESH) {
    tagFetched = Date.now();
    fetchETA(route, focus.position, state.db, state.lang, focus.op)
      .then((etas) => { if (key === tagKey) tagArrivals = etas; })
      .catch(() => { if (key === tagKey) tagArrivals = []; })
      .finally(() => { if (key === tagKey) showArrivalTag(); });
  }
  const next = chosenStopArrival(), minutes = next && minutesUntil(next);
  const text = tagArrivals === undefined ? t('查詢中…', 'Checking…') : !next ? t('暫無到站資料', 'No arrivals')
    : !minutes ? t('即將到站', 'Arriving') : t(`還有 ${minutes} 分鐘`, `${minutes} min`);
  mapView.tag(stopOnRoad(route, focus.op, focus.position), text);
  const card = $('focus-arrivals'), shown = `${key}|${text}|${tagArrivals?.length}`;
  if (card && tagArrivals && (shown !== tagShown || !card.querySelector('.eta-box, .muted'))) {
    tagShown = shown;
    fillArrivals(card, tagArrivals);
  }
}

/** Shows a whole route on the map, and with a stop chosen, the buses either side of it. */
function focusRoute(routeKey, op, position = null) {
  state.focus = { routeKey, op, position };
  sheet.snap('half');
  drawMap();
  fitWholeRoute();
}

function fitWholeRoute() {
  const { routeKey, op } = state.focus;
  mapView.fit(state.db.routes[routeKey].stops[op].map((id) => state.db.stops[id]?.location).filter(Boolean), 16, true);
}

/** The view to come back to: where the rider is, or all of Hong Kong without a position. */
function showHomeMap() {
  if (state.fix && inHongKong(state.fix)) mapView.follow(state.fix, 15, true);
  else mapView.home();
}

const METERS_AROUND_STOP = 120;

/** With a stop chosen the map comes right in on it; without one, back out to the whole route. */
function fitFocus() {
  if (!state.focus) return;
  const { routeKey, op, position } = state.focus, ids = state.db.routes[routeKey].stops[op];
  if (position == null) return fitWholeRoute();
  const stop = state.db.stops[ids[position]]?.location;
  if (!stop) return;
  mapView.fit([offset(stop, METERS_AROUND_STOP, -1), offset(stop, METERS_AROUND_STOP, 1)], 16.5, true);
}

function clearFocus() {
  state.focus = null;
  clearMapStop();
  drawMap();
}

/** Out of a route: back to the stops searched for if there are any, otherwise to the rider. */
function leaveFocus() {
  clearFocus();
  if (state.tab === 'stops' && state.stopPlace) fitStopArea();
  else showHomeMap();
}

function focusPath() {
  const { routeKey, op } = state.focus, route = state.db.routes[routeKey];
  const positions = route.stops[op].flatMap((id, position) => (state.db.stops[id]?.location ? [position] : []));
  const stopIDs = positions.map((position) => route.stops[op][position]);
  return { segments: [{ mode: 'ride', route: route.route, routeKey, op, stopIDs, positions, points: stopIDs.map((id) => state.db.stops[id].location) }] };
}

/** A stop picked on the map or in the list: the sheet shows its arrivals and the map follows. */
function chooseFocusStop(position) {
  state.focus = { ...state.focus, position: state.focus.position === position ? null : position };
  renderSheet();
  $('sheet').scrollTop = 0;
  sheet.snap('half');
  // The route stays drawn: only the pin moves, and the camera slides to it.
  showChosenStop();
  moveVehicles();
  if (sheet.mapOnly) {
    const { routeKey, op, position: selected } = state.focus;
    if (selected == null) return clearMapStop();
    return showMapStop(name(state.db.routes[routeKey].stops[op][selected]));
  }
  fitFocus();
}

function showChosenStop() {
  if (!state.focus) return mapView.chosen(null);
  const { routeKey, op, position } = state.focus, route = state.db.routes[routeKey];
  const id = position == null ? null : route.stops[op][position];
  return mapView.chosen(id ? { name: name(id), location: stopOnRoad(route, op, position) } : null);
}

/** The chosen stop's arrivals, filled in by showArrivalTag. */
function arrivalCard(id, close) {
  return h('div', { class: 'card open' },
    h('div', { class: 'row' }, h('span', { class: 'bold grow' }, name(id)),
      close && h('button', { class: 'round', 'aria-label': t('關閉', 'Close'), onclick: close }, icon('close', 15))),
    h('div', { class: 'eta-grid', id: 'focus-arrivals' }, h('div', { class: 'status' }, h('span', { class: 'spinner' }), t('查詢中…', 'Loading…'))));
}

/** A stop tapped on a planned route: the card goes above the journeys and nothing else is redrawn. */
function chooseLineStop(segment, index) {
  const position = segment.positions?.[index];
  if (position == null || !segment.routeKey) return;
  if (segment.op === 'eduhk') return showToast(name(segment.stopIDs[index]));
  const isSame = state.focus?.routeKey === segment.routeKey && state.focus.op === segment.op && state.focus.position === position;
  state.focus = isSame ? null : { routeKey: segment.routeKey, op: segment.op, position };
  if (state.focus) pauseNavigationFollow();
  showPlanStop();
}

function closePlanStop() {
  state.focus = null;
  showPlanStop();
}

function planStopCard() {
  if (!state.focus) return null;
  const { routeKey, op, position } = state.focus;
  return arrivalCard(state.db.routes[routeKey].stops[op][position], closePlanStop);
}

function showPlanStop() {
  const slot = $('plan-stop');
  if (!slot) return;
  clear(slot, planStopCard());
  tagShown = '';
  showChosenStop();
  moveVehicles();
  if (!state.focus) {
    clearMapStop();
    return fitPlanMap();
  }
  $('sheet').scrollTop = 0;
  sheet.snap('half');
  if (sheet.mapOnly) {
    const { routeKey, op, position } = state.focus;
    return showMapStop(name(state.db.routes[routeKey].stops[op][position]));
  }
  return fitFocus();
}

function variantLabel(variant, variants, index) {
  if (!index) return t('常規班次', 'Regular');
  const origin = nameText(variant.orig, state.lang), end = nameText(variant.dest, state.lang);
  if (origin !== nameText(variants[0].orig, state.lang)) return t(`由 ${origin}`, `From ${origin}`);
  if (end !== nameText(variants[0].dest, state.lang)) return t(`往 ${end}`, `To ${end}`);
  return t(`特別班 ${index}`, `Special ${index}`);
}

/** Which way the stops below run, and how to change that. */
function routeHead(route, op) {
  const { variants, opposite } = routeWays(state.db, route);
  const end = nameText(route.dest, state.lang), origin = nameText(route.orig, state.lang);
  return h('div', { class: 'card route-head' },
    h('div', { class: 'row' }, badge(op, route.route),
      h('div', { class: 'grow', style: 'min-width:0' },
        h('div', { class: 'bold' }, t(`往 ${end}`, `To ${end}`)),
        h('div', { class: 'tiny muted' }, t(`由 ${origin} 開出`, `From ${origin}`))),
      opposite && h('button', { class: 'swap-way', onclick: () => showRouteWay(opposite, true) }, icon('swap', 16), t('轉方向', 'Reverse'))),
    variants.length > 1 && h('div', { class: 'days' }, variants.map((variant, index) => h('button', {
      'aria-pressed': String(variant === route), onclick: () => showRouteWay(variant),
    }, variantLabel(variant, variants, index)))));
}

/**
 * Another service of this route. A chosen stop becomes the one across the road, if there is one.
 * The opposite direction runs the same streets, so the map and the sheet stay exactly where they are.
 */
function showRouteWay(route, keepsView = false) {
  const { routeKey, op, position } = state.focus ?? {}, wasAt = position == null ? null : state.db.stops[state.db.routes[routeKey].stops[op][position]]?.location;
  const nextOp = route.operators.includes(op) ? op : route.operators[0];
  if (state.tab === 'routes') {
    state.routeKey = route.key;
    rememberRoute(route);
  }
  const chosen = wasAt ? closestPosition(route, nextOp, wasAt, state.db) : null;
  if (keepsView) {
    state.focus = { routeKey: route.key, op: nextOp, position: chosen };
    drawMap();
  } else {
    focusRoute(route.key, nextOp, chosen);
  }
  stagger();
  renderSheet();
  $('sheet').scrollTop = 0;
}

/** One route's stops, with the chosen stop's arrivals at the top. */
function routeDetail(route, op, back) {
  const position = state.focus?.position, id = position == null ? null : route.stops[op][position];
  const turn = circularTurn(route, op, state.db), out = lineColor(op, route.route);
  const legDot = (color) => h('i', { class: 'leg-dot', style: `background:${color}` });
  return [
    h('button', { class: 'back', onclick: back }, icon('back', 17), t('返回', 'Back')),
    routeHead(route, op),
    id && arrivalCard(id),
    !id && h('div', { class: 'tiny muted' }, t('點選站點查看來車時間，左右滑動可設為出發地或目的地。', 'Tap a stop for arrivals, or swipe it to start or end a trip there.')),
    turn != null && h('div', { class: 'leg-key tiny' },
      h('span', {}, legDot(out), t(`去程：往${name(route.stops[op][turn])}`, `Out: to ${name(route.stops[op][turn])}`)),
      h('span', {}, legDot(RETURN_COLOR), t('回程：返回起點', 'Back: to the start'))),
    route.stops[op].map((stop, seq) => stopRow(route, seq, stop, op, turn != null && legDot(seq > turn ? RETURN_COLOR : out))),
  ];
}

setInterval(moveVehicles, 1000);

const SAME_BUS_STOPS = 1.5; // By place along the route, as two buses can pass on the same road.

/** Keeps each bus sliding toward where it should be, between the once-a-second sums. */
function glideVehicles() {
  // A bus keeps its marker while it is the same bus, so a different one never appears to jump there.
  const taken = new Set();
  shownVehicles = vehicleList.map((vehicle) => {
    const same = shownVehicles.find(({ id, position }) => !taken.has(id) && Math.abs(position - vehicle.position) < SAME_BUS_STOPS);
    vehicle.id = same?.id ?? ++lastBusID;
    taken.add(vehicle.id);
    return same ? glideOnTrack(vehicleTrack, same, vehicle, 0) : vehicle;
  });
  if (calm.matches) {
    shownVehicles = vehicleList;
    return mapView.vehicles(vehicleList);
  }
  mapView.vehicles(shownVehicles);
  if (gliding || !shownVehicles.length) return;
  gliding = true;
  lastGlide = performance.now();
  requestAnimationFrame(glideFrame);
}

function glideFrame(now) {
  if (!vehicleTrack || !vehicleList.length || calm.matches) {
    gliding = false;
    return;
  }
  // Ease the position along the road, then sample the location and heading there.
  const share = 1 - Math.exp(-Math.max(0, now - lastGlide) / 700);
  lastGlide = now;
  shownVehicles = shownVehicles.map((vehicle, index) => glideOnTrack(vehicleTrack, vehicle, vehicleList[index], share));
  mapView.vehicles(shownVehicles);
  requestAnimationFrame(glideFrame);
}

const hasRealLine = (segment) => !segment.providerShape && segment.mode === 'ride' && segment.routeKey && !['mtr', 'lightRail', 'eduhk'].includes(segment.op);

const tracks = new Map();

/** A route's line with its stops placed along it, once the line has arrived. */
function trackOf(route, op) {
  const shape = knownShape(route, op), key = `${route.key}|${op}`;
  if (!shape) return null;
  if (!tracks.has(key)) tracks.set(key, routeTrack(shape, route.stops[op].map((id) => state.db.stops[id]?.location)));
  return tracks.get(key);
}

/** A stop's place on its route's line, as stops are mapped at the kerb and lines down the road. */
function stopOnRoad(route, op, position) {
  return trackOf(route, op)?.passes[position]?.location ?? state.db.stops[route.stops[op][position]]?.location;
}

/** A circular route's way out and way back, each in its own colour. */
function withLegs(segment) {
  const route = segment.mode === 'ride' && state.db.routes[segment.routeKey];
  const turn = route && segment.positions ? circularTurn(route, segment.op, state.db) : null;
  if (turn == null) return segment;
  const { positions, points, op } = segment, first = positions[0], last = positions.at(-1), out = lineColor(op, segment.route);
  const track = trackOf(route, op);
  const leg = (from, to, color, weight = 5) => ({ color, weight, road: track ? trackBetween(track, from, to) : points.filter((_, index) => positions[index] >= from && positions[index] <= to) });
  const legs = last <= turn ? [leg(first, last, out)] : first >= turn ? [leg(first, last, RETURN_COLOR)]
    // Most go back along some of the same road, so the way back runs inside the way out.
    : [leg(first, turn, out, 7), leg(turn, last, RETURN_COLOR, 3)];
  return { ...segment, legs, dots: positions.map((position) => (position > turn ? RETURN_COLOR : out)) };
}

const SHORTEST_GOOGLE_WALK = 40;

/** The path with real walking and bus lines in place of straight ones, where they have arrived. */
function withRoads(path) {
  return path && {
    ...path,
    segments: path.segments.map((segment) => {
      if (segment.providerShape) return segment;
      const first = segment.points[0], last = segment.points.at(-1);
      if (segment.mode === 'walk') return mapView === googleMap ? { ...segment, points: knownWalk(first, last) ?? segment.points } : segment;
      if (!hasRealLine(segment)) return segment;
      const track = trackOf(state.db.routes[segment.routeKey], segment.op);
      if (!track || !segment.positions) return segment;
      return { ...segment, line: roadBetween(track, segment.positions[0], segment.positions.at(-1)), marks: segment.positions.map((position) => track.passes[position]?.location) };
    }).map((segment) => (segment.providerShape ? segment : withLegs(segment))),
  };
}

/**
 * Only the route on screen asks, and each line only once. Bus lines are free; walks use Google's
 * allowance, and bring how long they really take, which then goes into the journeys.
 */
function loadRoads(path) {
  if (!path) return Promise.resolve(false);
  const buses = path.segments.filter(hasRealLine).map((segment) => [state.db.routes[segment.routeKey], segment.op])
    .filter(([route, op]) => !knownShape(route, op));
  const walks = path.segments.filter((segment) => !segment.providerShape && segment.mode === 'walk' && mapView === googleMap)
    .map((segment) => [segment.points[0], segment.points.at(-1)])
    .filter(([from, to]) => meters(from, to) >= SHORTEST_GOOGLE_WALK && !knownWalk(from, to));
  return Promise.all([...buses.map(([route, op]) => loadShape(route, op)), ...walks.map(([from, to]) => googleWalk(from, to))])
    .then(async () => {
      // Walks fetched for an earlier version of these journeys still need putting in.
      const timed = path.segments.some((segment) => segment.mode === 'walk') && await useWalkTimes();
      return timed || buses.some(([route, op]) => knownShape(route, op)) || walks.some(([from, to]) => knownWalk(from, to));
    });
}

/** Recheck the walking limit when a local route's street distances become available. */
async function useWalkTimes() {
  if (mapView !== googleMap || state.phase !== 'done' || !state.candidates.length || !state.from || !state.to) return false;
  const run = planRun, before = state.candidates;
  const updated = before.map((journey) => (journey.provider ? journey
    : withWalkTimes(journey, walkEnds(journey, state.from.location, state.to.location, planningDB()), knownWalkTime)));
  if (updated.every((journey, index) => journey === before[index])) return false;
  const live = await Promise.all(updated.map((journey, index) => {
    if (journey === before[index]) return journey;
    if (state.arrivals && journey.departure - Date.now() <= LIVE_AHEAD_MS) return retime(journey, state.arrivals);
    return includesEdUHK(journey) ? retime(journey, () => null) : journey;
  }));
  if (run !== planRun || state.candidates !== before) return false;
  const moved = showTripOptions(live.filter((journey) => !journey.missedConnection && (state.eduhkShuttle || !includesEdUHK(journey))), true);
  renderSheet();
  if (moved && !mapTouched) fitPlanMap();
  return true;
}

const showingNavigation = () => state.nav != null && state.onMap === state.nav.id;

async function startNavigation(journey) {
  const path = journeyPath(journey, state.from.location, state.to.location, state.db), id = journeyID(journey);
  // Tracking follows the real walking line, so progress and the map share one path.
  const nav = state.nav = { id, journey, path: withRoads(path), progress: null, here: null, issue: null, following: true };
  state.onMap = state.expanded = id;
  state.focus = null;
  clearMapStop();
  whenOpen = false;
  syncNavControls();
  sheet.snap('peek');
  renderSheet();
  renderNavBanner();
  loadRoads(path).then((arrived) => {
    // Swapping the path once there is progress would put the rider on the wrong edge.
    if (!arrived || state.nav !== nav || nav.progress) return;
    nav.path = withRoads(path);
    if (state.tab === 'plan' && showingNavigation()) drawMap();
  });
  if (!navigator.geolocation) {
    nav.issue = 'denied';
    return renderNavBanner();
  }
  watchID = navigator.geolocation.watchPosition((position) => {
    if (state.nav !== nav || nav.progress?.hasArrived) return;
    const here = { lat: position.coords.latitude, lng: position.coords.longitude };
    nav.here = here;
    nav.issue = null;
    nav.progress = progressAt(nav.path, here, position.coords.accuracy, nav.progress);
    if (nav.progress?.hasArrived) stopWatching();
    if (state.tab !== 'plan') return;
    drawMap();
    if (showingNavigation() && nav.following) mapView.follow(here);
    renderNavBanner();
  }, (error) => {
    if (state.nav !== nav) return;
    nav.issue = error.code === 1 ? 'denied' : 'unavailable';
    renderNavBanner();
  }, { enableHighAccuracy: true, maximumAge: 3_000, timeout: 20_000 });
  try {
    const lock = await navigator.wakeLock?.request('screen');
    if (state.nav === nav && !nav.progress?.hasArrived) wakeLock = lock;
    else await lock?.release();
  } catch { /* Screen may dim; navigation still works. */ }
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
  syncNavControls();
  renderNavBanner();
}

function syncNavControls() {
  $('route-inputs')?.toggleAttribute('disabled', !!state.nav);
  $('close-trip')?.toggleAttribute('disabled', !!state.nav);
  $('transport-preference')?.querySelectorAll('button').forEach((button) => { button.disabled = !!state.nav; });
  renderWhen();
}

function resumeNavigation() {
  const nav = state.nav;
  if (!nav) return;
  nav.following = true;
  state.onMap = state.expanded = nav.id;
  state.focus = null;
  clearMapStop();
  mapTouched = false;
  renderSheet();
  renderNavBanner();
  if (nav.here) mapView.follow(nav.here);
  else fitPlanMap(true);
}

function renderNavBanner() {
  const banner = $('nav-banner');
  if (!state.nav || state.tab !== 'plan') return banner?.remove();
  const { progress, path, issue, following } = state.nav;
  const preview = !showingNavigation(), paused = !following;
  const text = preview ? t('正在預覽其他方案，原有導航繼續。', 'Previewing another route. Navigation is still running.')
    : issue === 'denied' ? t('導航需要定位權限，請在瀏覽器設定開啟。', 'Navigation needs Location access. Turn it on in your browser settings.')
    : !progress ? (issue ? t('暫時未能定位，稍後會再試。', "Can't find you right now. Still trying.") : t('正在取得你的位置…', 'Finding your location…'))
      : instruction(path, progress, state.lang, name);
  const resume = preview ? t('回到導航', 'Return to navigation') : paused ? t('回到我的位置', 'Recenter') : '';
  const end = progress?.hasArrived ? t('完成', 'Done') : t('結束', 'End');
  const signature = JSON.stringify([text, resume, end]);
  if (banner?.dataset.signature === signature) return;
  const next = banner ?? h('div', { id: 'nav-banner', class: 'nav-banner' });
  next.dataset.signature = signature;
  clear(next, icon('navigate', 20, true), h('span', { class: 'grow' }, text),
    h('div', { class: 'nav-actions' },
      resume && h('button', { onclick: resumeNavigation }, resume),
      h('button', { onclick: () => { stopNavigation(); renderSheet(); fitPlanMap(); } }, end)));
  if (!banner) $('app').append(next);
}

// MARK: Voice

const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
let recognition = null;

function toggleSpeech() {
  if (!state.aiConfig) return;
  if (recognition) return recognition.stop();
  recognition = new Recognition();
  recognition.lang = state.speechLang;
  recognition.interimResults = true;
  let text = '';
  const key = state.aiConfig;
  recognition.onresult = (event) => {
    if (key !== state.aiConfig || !$('chat-input')) return;
    text = [...event.results].map((result) => result[0].transcript).join('');
    state.chat = text;
    $('chat-input').value = text;
    syncComposer();
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
    if (key === state.aiConfig && text.trim()) sendChat();
  };
  recognition.start();
  state.listening = true;
  renderChatControls();
}

function renderChatControls() {
  const mic = $('mic');
  if (mic) {
    clear(mic, icon(state.listening ? 'stop' : 'mic', 20, state.listening));
    mic.classList.toggle('listening', state.listening);
    mic.style.color = state.listening ? 'var(--danger)' : '';
  }
  const input = $('chat-input');
  if (input) input.placeholder = chatPrompt();
}

/** The microphone gives way to the send button once there is something to send. */
const syncComposer = () => $('composer')?.classList.toggle('typing', !!state.chat.trim());

function chatPrompt() {
  if (!state.aiConfig) return t('AI 尚未啟用', 'AI is disabled');
  if (state.listening) return t('正在聆聽…', 'Listening…');
  if (state.discovery?.stage === 'asking') return t('輸入你的回答…', 'Type your answer…');
  return t('問 AI，例如：去吃茶餐廳', 'Ask AI, e.g. Find a cha chaan teng');
}

// MARK: Actions

function search(places = {}) {
  if (!state.db || !state.destination.trim()) return;
  stopSuggesting();
  renderPlaceHistory(null);
  const origin = normalizedOrigin(state.origin);
  if (origin) history.add('origin', origin);
  if (!isCurrentLocation(state.destination)) history.add('destination', state.destination);
  Object.assign(state, { discovery: null, talk: [], thread: null, lastSearch: null });
  renderBottomStatus();
  document.activeElement?.blur();
  showRouteView();
  runPlan({ kind: 'search', ...places });
}

const MOST_QUESTIONS = 2;

const TALK_REMEMBERED = 10;
const remember = (who, text) => { state.talk = [...state.talk, `${who}: ${text.slice(0, 200)}`].slice(-TALK_REMEMBERED); };

/** What is on screen, so the AI can tell a follow-up from a new subject. */
function chatContext() {
  // A search stays in mind after one of its shops is chosen, so "the second one, then?" still means something.
  const { stage, wish, areaName, suggestions } = state.discovery ?? state.lastSearch ?? {}, asking = stage === 'asking';
  const asked = asking ? (wish.asked ?? 0) + 1 : 0;
  return {
    talk: state.talk,
    search: wish ? { ...wish, area: areaName ?? wish.area, shops: suggestions?.map(({ place }) => place.name) } : null,
    question: asking ? wish.question ?? t(`想找${wish.want}，要在哪裡找？`, `Where should I look for ${wish.want}?`) : null,
    mayAsk: asked < MOST_QUESTIONS,
  };
}

function askAI(text) {
  if (!state.aiConfig) return;
  if (state.nav) return showToast(t('請先結束導航，再搜尋新路線。', 'End navigation before searching for a new route.'));
  const { stage, wish, suggestions } = state.discovery ?? state.lastSearch ?? {}, context = chatContext(), current = currentTrip();
  const discovery = state.discovery;
  remember('Rider', text);
  state.discovery = null;
  state.thread = { said: text, busy: true };
  renderBottomStatus();
  runPlan({
    kind: 'chat', text, current, context, wish, discovery, asked: stage === 'asking' ? (wish.asked ?? 0) + 1 : 0,
    shops: suggestions?.map(({ place }) => place),
  });
}

function sendChat() {
  const text = state.chat.trim();
  if (!state.aiConfig || !text || !state.db) return;
  if (state.nav) return showToast(t('請先結束導航，再搜尋新路線。', 'End navigation before searching for a new route.'));
  history.add('chat', text);
  state.chat = '';
  const input = $('chat-input');
  if (input) {
    input.value = '';
    input.blur();
  }
  syncComposer();
  state.lastChat = text;
  renderChatHistory(false);
  askAI(text);
}

function swapEnds() {
  const start = state.origin.trim(), end = state.destination.trim();
  const resolved = !state.planDirty && state.from && state.to && plannedInputs?.[0] === state.origin && plannedInputs[1] === state.destination;
  const places = resolved ? { start: state.to, place: state.from } : {};
  state.origin = isCurrentLocation(end) ? '' : end;
  state.destination = start || t('我的位置', 'My location');
  syncPlaceInputs();
  search(places);
}

function editTripPlace(field, value) {
  state[field] = value;
  if (!state.routeView || state.planDirty || (!state.to && state.phase === 'idle')) return;
  const wasPlanning = PHASES[state.phase];
  planRun++;
  transitRequest?.abort();
  clearTimeout(whenTimer);
  state.planDirty = true;
  state.phase = 'idle';
  state.error = null;
  state.focus = null;
  if (wasPlanning && state.thread?.busy) state.thread = null;
  clearExplore();
  renderNearStops();
  renderBottomStatus();
  renderSheet();
}

function syncPlaceInputs() {
  if ($('origin-input')) $('origin-input').value = state.origin;
  if ($('destination-input')) $('destination-input').value = state.destination;
}

const siteTexts = new Map();

/** Everything a stop can be typed as, including Simplified. */
function siteText(site) {
  if (!siteTexts.has(site)) siteTexts.set(site, `${site.name.zh} ${toSimplified(site.name.zh)} ${site.name.en}`.toLowerCase());
  return siteTexts.get(site);
}

/** Instant matches while typing, nearest first. */
function stopSuggestions() {
  const near = state.fix && inHongKong(state.fix) ? state.fix : null;
  const matches = matchingSites(state.stopQuery, siteIndex(), near, siteText);
  if (!matches.length) return [h('div', { class: 'small muted', style: 'padding:6px 4px' }, t('沒有符合的站點，按搜尋可以找地點。', 'No stops match. Search to look for a place.'))];
  return [h('div', { class: 'list' }, matches.map(({ site, distance }) => {
    const mode = primaryMode(site);
    const routes = [...new Set(site.visits.map((visit) => state.db.routes[visit.routeKey]?.route).filter(Boolean))];
    const shown = routes.slice(0, 5).join(' · ') + (routes.length > 5 ? ' …' : '');
    return h('button', { class: 'item', onclick: () => chooseSite(site) },
      h('i', { class: 'dot', style: `color:#fff;background:${{ mtr: OP_COLORS.mtr, lightRail: OP_COLORS.lightRail, minibus: OP_COLORS.gmb, bus: OP_COLORS.kmb }[mode]}` }, icon(mode === 'mtr' || mode === 'lightRail' ? 'pin' : 'bus', 16)),
      h('span', { class: 'grow', style: 'min-width:0' },
        h('div', { class: 'ellipsis' }, nameText(site.name, state.lang)),
        h('div', { class: 'tiny muted ellipsis' }, shown)),
      distance != null && h('span', { class: 'tiny muted' }, distanceText(distance)));
  }))];
}

let suggestTimer = null, suggestRun = 0, googlePlaces = [];

/** Drops the suggestions still on their way, so none lands on top of a search already made. */
function stopSuggesting() {
  clearTimeout(suggestTimer);
  suggestRun += 1;
}

const showSuggestions = (field) => (state.routeView ? renderPlaceHistory(field) : renderSheet());

/** Stops answer at once. Google waits for a pause in the typing, to keep within its allowance. */
function suggestPlaces(field = 'destination') {
  stopSuggesting();
  const run = suggestRun, text = state[field].trim();
  if (text.length < 2) googlePlaces = [];
  showSuggestions(field);
  getFix();
  if (text.length < 2) return;
  suggestTimer = setTimeout(async () => {
    const near = state.fix && inHongKong(state.fix) ? state.fix : null;
    const found = await googleSuggest(text, near, state.lang);
    if (run !== suggestRun) return;
    googlePlaces = found;
    showSuggestions(field);
  }, 400);
}

/** From the home search box a suggestion plans the trip at once. */
const planToItem = (item) => (item.site ? planTo(item.site) : planToSuggestion(item));

/** From a box on the route page it fills that box, and the trip plans once it has a destination. */
async function fillPlace(field, item) {
  const location = item.site?.location ?? await googlePlaceLocation(item.id);
  if (location) pickedPlaces.set(item.name, { name: item.name, location });
  state[field] = item.name;
  googlePlaces = [];
  syncPlaceInputs();
  renderPlaceHistory(null);
  if (!state.destination.trim()) return $('destination-input')?.focus();
  document.activeElement?.blur();
  sheet.snap('half');
  return search();
}

function placeSuggestions(field = 'destination', choose = planToItem) {
  const near = state.fix && inHongKong(state.fix) ? state.fix : null;
  const stops = matchingSites(state[field], siteIndex(), near, siteText).map(({ site, distance }) => ({ site, name: nameText(site.name, state.lang), meters: distance ?? undefined }));
  const items = mergeSuggestions(stops, googlePlaces);
  if (!items.length) return h('div', { class: 'small muted', style: 'padding:6px 4px' }, t('繼續輸入，或按搜尋。', 'Keep typing, or press search.'));
  return h('div', { class: 'list' }, items.map((item) => h('button', {
    class: 'item', onmousedown: (event) => event.preventDefault(),
    onclick: () => {
      stopSuggesting();
      return choose(item);
    },
  },
    h('i', { class: 'dot', style: item.site ? 'color:#fff;background:var(--accent)' : '' }, icon(item.site ? 'bus' : 'pin', 16)),
    h('span', { class: 'grow', style: 'min-width:0' },
      h('div', { class: 'ellipsis' }, item.name),
      h('div', { class: 'tiny muted ellipsis' }, item.site ? t('站點', 'Stop') : item.address ?? '')),
    item.meters != null && h('span', { class: 'tiny muted' }, distanceText(item.meters)))));
}

function chooseSite(site) {
  const name = nameText(site.name, state.lang);
  state.stopQuery = name;
  const input = $('stop-input');
  if (input) {
    input.value = name;
    input.blur();
  }
  searchStops(false, { name, location: site.location });
}

async function searchStops(aroundMe = false, chosen = null) {
  if (!state.db || state.tab !== 'stops') return;
  const run = ++stopRun, text = state.stopQuery.trim(), index = siteIndex();
  state.stopSuggesting = false;
  state.focus = null;
  state.stopError = null;
  selectNearbyStop(null);
  let place = null, error = null;
  state.stopBusy = true;
  state.stopPlace = null;
  state.stops = [];
  renderSheet();
  drawMap();
  if (chosen) {
    history.add('stops', text);
    place = chosen;
  } else if (aroundMe) {
    place = await here().catch(() => null);
    if (!place) error = t('未能取得你的位置，請允許定位。', "Couldn't get your location. Allow Location access.");
  } else if (text) {
    history.add('stops', text);
    const site = exactSite(text, index);
    if (site) {
      place = { name: nameText(site.name, state.lang), location: site.location };
    } else {
      // A map reads 理大 as any name containing those characters, so expand nicknames first.
      let full = text;
      try { full = (await client()?.intent(searchMessage(null, text, 'fastest')))?.destination ?? text; } catch { /* Search the text as typed. */ }
      if (run !== stopRun) return;
      place = await resolvePlace(full).catch(() => null);
      if (place && full !== text) place = { ...place, name: full };
    }
    if (!place) error = t(`找不到「${text}」，請換個說法。`, `Couldn't find "${text}". Try another name.`);
  }
  if (run !== stopRun || state.tab !== 'stops') return;
  state.stopError = error;
  state.stopPlace = place;
  state.stops = place ? stopsNear(index, place.location, state.stopRadius) : [];
  state.stopBusy = false;
  renderStopsTop();
  stagger();
  renderSheet();
  drawMap();
  if (place) fitStopArea();
}
let stopRun = 0;
function cancelStopSearch() {
  stopRun++;
  state.stopBusy = false;
  state.stopError = null;
}
const offset = (l, m, sign) => ({ lat: l.lat + (sign * m) / 111_000, lng: l.lng + (sign * m) / 103_000 });

function planTo(site) {
  planToPlace({ name: nameText(site.name, state.lang), location: site.location });
}

function planToPlace(place) {
  if (state.tab === 'stops') cancelStopSearch();
  state.tab = 'plan';
  // A start the rider picked is waiting for this destination.
  if (!pickedPlaces.has(state.origin)) state.origin = '';
  state.destination = place.name;
  state.discovery = null;
  state.routeView = true;
  renderTab();
  sheet.snap('half');
  runPlan({ kind: 'place', place });
}

/** Goes to the very place Google suggested, as a search by name could find another branch. */
async function planToSuggestion(item) {
  state.destination = item.name;
  syncPlaceInputs();
  const location = await googlePlaceLocation(item.id);
  if (!location) return search();
  history.add('destination', item.name);
  document.activeElement?.blur();
  return planToPlace({ name: item.name, location });
}

// MARK: Arrival widgets

const minutesUntil = (date) => Math.max(0, Math.floor((date - Date.now()) / 60_000));
const stillDue = (eta) => eta.date != null && eta.date >= Date.now() - 60_000;

function fillArrivals(root, etas) {
  const timed = etas.filter(stillDue).slice(0, 2);
  if (!timed.length) {
    const remark = etas.find((eta) => nameText(eta.remark, state.lang));
    return clear(root, h('div', { class: 'small muted' }, remark ? nameText(remark.remark, state.lang) : t('暫無到站資料', 'No arrivals right now')));
  }
  return clear(root, timed.map((eta, index) => {
    const minutes = minutesUntil(eta.date);
    return h('div', { class: 'eta-box' },
      h('div', { class: 'tiny muted' }, index ? t('第二班', 'Then') : t('下一班', 'Next')),
      h('div', { class: 'when' }, minutes ? t(`${minutes} 分鐘`, `${minutes} min`) : t('即到', 'Now')),
      h('div', { class: 'tiny muted ellipsis' }, nameText(eta.remark, state.lang) || clock(eta.date)));
  }));
}

function etaWidget(route, seq, op) {
  const root = h('div', { class: 'eta-grid' }, h('div', { class: 'status' }, h('span', { class: 'spinner' }), t('查詢中…', 'Loading…')));
  fetchETA(route, seq, state.db, state.lang, op).then((etas) => fillArrivals(root, etas))
    .catch(() => clear(root, h('div', { class: 'notice' }, t('未能取得到站時間', "Couldn't get arrivals"))));
  return root;
}

const isSaved = (key, seq, op) => state.saved.some((s) => s.routeKey === key && s.seq === seq && s.op === op);
function toggleSaved(key, seq, op) {
  state.saved = isSaved(key, seq, op) ? state.saved.filter((s) => !(s.routeKey === key && s.seq === seq && s.op === op)) : [...state.saved, { routeKey: key, seq, op }];
  store.set('saved', state.saved);
}
function starButton(key, seq, op) {
  const draw = () => {
    const saved = isSaved(key, seq, op);
    button.classList.toggle('on', saved);
    button.setAttribute('aria-pressed', String(saved));
    clear(button, icon('star', 20, saved));
  };
  const button = h('button', { class: 'icon-button', 'aria-label': t('收藏', 'Save') });
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleSaved(key, seq, op);
    draw();
  });
  draw();
  return button;
}

/** A route at a stop: tap for its next two arrivals. */
function visitRow(visit) {
  const route = state.db.routes[visit.routeKey];
  if (!route) return null;
  const key = `${visit.routeKey}|${visit.op}|${visit.seq}`, id = `visit-${key}`, expanded = state.stopVisit === key;
  const row = h('div', { id, class: 'stop-visit' },
    h('div', { class: 'row' },
      h('button', { class: 'tap grow', 'aria-expanded': String(expanded), onclick: () => {
        state.stopVisit = expanded ? null : key;
        renderSheet();
        $(id)?.querySelector('button')?.focus({ preventScroll: true });
      } }, h('div', { class: 'row' },
        badge(visit.op, route.route), h('span', { class: 'small ellipsis grow' }, `→ ${nameText(route.dest, state.lang)}`),
        h('span', { class: 'tiny muted visit-next' }, t('等候查詢', 'Waiting')),
        icon(expanded ? 'up' : 'down', 13))),
      starButton(visit.routeKey, visit.seq, visit.op)),
    expanded && h('div', { class: 'stack' },
      h('div', { class: 'eta-grid visit-arrivals' }),
      h('button', { class: 'link visit-route', onclick: () => {
        stopListView = { scroll: $('sheet').scrollTop, size: sheet.current };
        focusRoute(visit.routeKey, visit.op, visit.seq);
        renderSheet();
        $('sheet').scrollTop = 0;
      } }, t('查看全程路線', 'View full route'))));
  row.arrivalRequest = { route, seq: visit.seq, op: visit.op, key: `${state.lang}|${key}` };
  return row;
}

const stopArrivalCache = new Map(), visibleStopArrivals = new Set();
const STOP_ARRIVAL_MAX_PENDING = 4;
let stopArrivalPending = 0;

const stopArrivalObserver = new IntersectionObserver((entries) => {
  for (const { isIntersecting, target } of entries) {
    if (isIntersecting && target.isConnected) visibleStopArrivals.add(target);
    else visibleStopArrivals.delete(target);
  }
  refreshVisibleStopArrivals();
}, { root: $('sheet') });

function watchVisibleStopArrivals() {
  stopArrivalObserver.disconnect();
  visibleStopArrivals.clear();
  if (state.tab !== 'stops' || sheet.mapOnly) return;
  $('sheet').querySelectorAll('.stop-visit').forEach((row) => stopArrivalObserver.observe(row));
}

function refreshVisibleStopArrivals() {
  if (document.hidden || state.tab !== 'stops' || sheet.mapOnly) return;
  const now = Date.now();
  for (const row of visibleStopArrivals) {
    if (!row.isConnected) continue;
    const { key, route, seq, op } = row.arrivalRequest;
    let record = stopArrivalCache.get(key);
    if (!record) {
      if (stopArrivalCache.size >= 256) stopArrivalCache.delete(stopArrivalCache.keys().next().value);
      stopArrivalCache.set(key, record = { checked: 0, etas: null, error: false });
    }
    if (now - record.checked >= VEHICLE_REFRESH && stopArrivalPending < STOP_ARRIVAL_MAX_PENDING) {
      record.checked = now;
      stopArrivalPending++;
      fetchETA(route, seq, state.db, state.lang, op).then((etas) => {
        record.etas = etas;
        record.error = false;
      }).catch(() => {
        record.etas = null;
        record.error = true;
      }).finally(() => {
        stopArrivalPending--;
        refreshVisibleStopArrivals();
      });
    }
    const next = record.etas?.find(stillDue), minutes = next && minutesUntil(next.date);
    const text = next ? (minutes ? t(`${minutes} 分鐘`, `${minutes} min`) : t('即到', 'Now'))
      : record.etas ? t('暫無時間', 'No times')
        : record.error ? t('未能取得', 'Unavailable') : record.checked ? t('查詢中…', 'Checking…') : t('等候查詢', 'Waiting');
    const label = row.querySelector('.visit-next');
    if (label.dataset.text !== text) {
      label.dataset.text = text;
      label.textContent = text;
      label.classList.toggle('live', !!next);
      label.classList.toggle('muted', !next);
    }
    const detail = row.querySelector('.visit-arrivals');
    if (!detail) continue;
    const signature = record.etas ? record.etas.filter(stillDue).slice(0, 2).map((eta) => `${eta.date}:${minutesUntil(eta.date)}`).join('|') : text;
    if (detail.lastArrivals === record.etas && detail.lastSignature === signature) continue;
    detail.lastArrivals = record.etas;
    detail.lastSignature = signature;
    if (record.etas) fillArrivals(detail, record.etas);
    else clear(detail, h('span', { class: 'small muted', role: 'status' }, text));
  }
}

setInterval(refreshVisibleStopArrivals, 5_000);

// MARK: Plan tab

function renderPlaceHistory(field) {
  const slot = $('place-history');
  if (!slot) return;
  if (field && state[field].trim() && state.db) return clear(slot, placeSuggestions(field, (item) => fillPlace(field, item)));
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

function transitModePicker() {
  const options = [
    ['all', t('不限', 'Any transport')],
    ['mtr', t('優先港鐵', 'Prefer MTR')],
    ['bus', t('優先巴士', 'Prefer buses')],
  ];
  const picker = segments(options, state.transitMode, (mode) => {
    if (mode === state.transitMode) return;
    state.transitMode = mode;
    store.set('transitMode', mode);
    const hadFocus = picker.contains(document.activeElement);
    const updated = transitModePicker();
    picker.replaceWith(updated);
    if (hadFocus) updated.querySelector('[aria-pressed="true"]').focus({ preventScroll: true });
    if (state.from && state.to && plannedInputs?.[0] === state.origin && plannedInputs[1] === state.destination) {
      runPlan({ kind: 'replan' });
    }
  });
  picker.id = 'transport-preference';
  if (state.nav) picker.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  picker.setAttribute('role', 'group');
  picker.setAttribute('aria-label', t('交通工具偏好', 'Transport preference'));
  return picker;
}

function renderPlanTop() {
  if (!state.routeView) {
    const prompt = state.script === 'hans' ? '你想去哪里？' : '你想去邊度？';
    clear($('top'), h('div', { class: 'row' },
      h('label', { class: 'search-card single home-search' }, h('span', { class: 'muted' }, icon('search', 18)), h('input', {
        id: 'destination-input', value: state.destination, placeholder: t(prompt, 'Where do you want to go?'), enterkeyhint: 'search', autocomplete: 'off',
        oninput: (event) => {
          state.destination = event.target.value;
          suggestPlaces();
        },
        onfocus: () => sheet.snap('full'),
        onkeydown: (event) => { if (event.key === 'Enter') search(); },
      }))));
    return;
  }
  const place = (field, placeholder, trailing) => h('label', { class: 'place' },
    h('input', {
      id: `${field}-input`, value: state[field], placeholder, enterkeyhint: 'search', autocomplete: 'off',
      oninput: (event) => {
        editTripPlace(field, event.target.value);
        sheet.snap('full');
        suggestPlaces(field);
      },
      onfocus: () => {
        googlePlaces = [];
        renderPlaceHistory(field);
      },
      onblur: () => setTimeout(() => { if (!document.activeElement?.id?.endsWith('-input')) renderPlaceHistory(null); }, 150),
      onkeydown: (event) => { if (event.key === 'Enter') search(); },
    }), trailing);
  clear($('top'),
    h('div', { class: 'row' }, h('span', { class: 'title grow' }, t('路線', 'Directions')),
      h('button', { id: 'close-trip', class: 'round', disabled: !!state.nav, 'aria-label': t('關閉', 'Close'), onclick: closeTrip }, icon('close', 16))),
    h('fieldset', { id: 'route-inputs', class: 'search-card', disabled: !!state.nav },
      h('div', { class: 'places' },
        h('div', { class: 'rail' }, h('i'), h('b'), h('i', { class: 'end' })),
        place('origin', t('我的位置', 'My location'), h('button', {
          class: 'icon-button on', 'aria-label': t('由我的位置出發', 'Start from my location'),
          onclick: (event) => {
            event.preventDefault();
            if (state.origin) editTripPlace('origin', '');
            syncPlaceInputs();
            getFix(true);
          },
        }, icon('locate', 19))),
        h('hr'),
        place('destination', t('要去哪裡？', 'Where to?'))),
      h('div', { class: 'stack', style: 'align-items:center' },
        h('button', { class: 'icon-button', 'aria-label': t('對調起點及目的地', 'Swap start and destination'), onclick: swapEnds }, icon('swap', 19)),
        h('button', { class: 'go', 'aria-label': t('搜尋', 'Search'), onclick: () => search() }, icon('search', 19)))),
    transitModePicker(),
    h('div', { id: 'plan-when' }),
    h('div', { id: 'place-history' }));
  renderWhen();
}

const HK_OFFSET_MS = 8 * 3_600_000, DAY_MS = 86_400_000, FIVE_MINUTES_MS = 300_000;
const hkDay = (ms) => Math.floor((ms + HK_OFFSET_MS) / DAY_MS);
// Hong Kong has no daylight saving, and the picker means Hong Kong time wherever the phone is.
const timeParts = (ms) => {
  const minutes = Math.floor(((ms + HK_OFFSET_MS) % DAY_MS) / 60_000);
  return { day: hkDay(ms), hour: Math.floor(minutes / 60), minute: minutes % 60 };
};
const fromParts = ({ day, hour, minute }) => day * DAY_MS - HK_OFFSET_MS + (hour * 60 + minute) * 60_000;
const DAYS_OFFERED = 7, WHEEL_ROW = 36, WHEEL_SETTLES_MS = 140;
let whenOpen = false, whenTimer = 0;

function whenLabel() {
  if (!state.when) return t('現在出發', 'Leave now');
  const { mode, at } = state.when, days = hkDay(at) - hkDay(Date.now());
  const date = new Date(at).toLocaleDateString(state.lang === 'zh' ? 'zh-HK' : 'en-HK', { month: 'short', day: 'numeric', timeZone: 'Asia/Hong_Kong' });
  const day = days === 0 ? '' : days === 1 ? t('明天 ', 'tomorrow ') : `${date} `;
  return mode === 'arrive' ? t(`${day}${clock(at)} 前到達`, `Arrive by ${day}${clock(at)}`) : t(`${day}${clock(at)} 出發`, `Leave ${day}${clock(at)}`);
}

/** Times the trip on screen again; with no trip yet, the time waits for the search. */
function planAgainForTime() {
  clearTimeout(whenTimer);
  if (state.from && state.to && !state.planDirty && !state.nav) runPlan({ kind: 'replan' });
}

/** The choices take up the sheet's half, so it opens fully to keep the routes in view as they change. */
function showWhen(open) {
  whenOpen = open;
  sheet.snap(open ? 'full' : 'half');
}

function chooseWhen(mode) {
  if (mode === 'now') {
    state.when = null;
    showWhen(false);
  } else {
    const soon = Date.now() + (mode === 'arrive' ? 60 : 15) * 60_000;
    state.when = { mode, at: state.when?.at ?? Math.ceil(soon / FIVE_MINUTES_MS) * FIVE_MINUTES_MS };
  }
  renderWhen();
  planAgainForTime();
}

/** Takes a day, an hour or a minute. A time already gone moves up to the next one still possible. */
function pickWhen(change) {
  if (!state.when) return;
  const wanted = fromParts({ ...timeParts(state.when.at), ...change });
  const at = Math.max(wanted, Math.ceil((Date.now() + 60_000) / FIVE_MINUTES_MS) * FIVE_MINUTES_MS), moved = at !== state.when.at;
  state.when.at = at;
  if (at !== wanted || 'day' in change) renderWhen();
  if (!moved) return;
  $('when-label').textContent = whenLabel();
  clearTimeout(whenTimer);
  whenTimer = setTimeout(planAgainForTime, 700);
}

function dayLabel(day, index) {
  if (index < 2) return index ? t('明天', 'Tomorrow') : t('今天', 'Today');
  const date = new Date(day * DAY_MS); // Shifted to Hong Kong already, so read in UTC.
  const weekday = date.toLocaleDateString(state.lang === 'zh' ? 'zh-HK' : 'en-HK', { weekday: 'short', timeZone: 'UTC' });
  return `${weekday} ${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

/** A column of numbers that settles on one, like a clock's wheel. */
function wheel(values, value, label, pick) {
  const rows = values.map((number, index) => h('button', { onclick: () => list.scrollTo({ top: index * WHEEL_ROW, behavior: calm.matches ? 'auto' : 'smooth' }) }, String(number).padStart(2, '0')));
  const list = h('div', { class: 'wheel no-drag', role: 'group', 'aria-label': label }, h('i'), rows, h('i'));
  const mark = (index) => rows.forEach((row, at) => row.classList.toggle('on', at === index));
  let settling = 0;
  list.addEventListener('scroll', () => {
    const index = Math.min(values.length - 1, Math.max(0, Math.round(list.scrollTop / WHEEL_ROW)));
    mark(index);
    clearTimeout(settling);
    settling = setTimeout(() => { if (list.isConnected) pick(values[index]); }, WHEEL_SETTLES_MS);
  });
  const start = Math.max(0, values.indexOf(value));
  mark(start);
  requestAnimationFrame(() => { list.scrollTop = start * WHEEL_ROW; });
  return list;
}

function whenPicker() {
  const { day, hour, minute } = timeParts(state.when.at), today = hkDay(Date.now());
  const days = Array.from({ length: DAYS_OFFERED }, (_, index) => today + index);
  const count = (length, step = 1) => Array.from({ length }, (_, index) => index * step);
  return [
    h('div', { class: 'days' }, days.map((choice, index) => h('button', { 'aria-pressed': String(choice === day), onclick: () => pickWhen({ day: choice }) }, dayLabel(choice, index)))),
    h('div', { class: 'wheels' },
      wheel(count(24), hour, t('小時', 'Hour'), (value) => pickWhen({ hour: value })),
      h('b', {}, ':'),
      wheel(count(12, 5), minute, t('分鐘', 'Minute'), (value) => pickWhen({ minute: value }))),
  ];
}

function renderWhen() {
  const slot = $('plan-when');
  if (!slot) return;
  clear(slot,
    h('button', {
      class: 'when-chip', disabled: !!state.nav, 'aria-expanded': String(whenOpen),
      onclick: () => { showWhen(!whenOpen); renderWhen(); },
    }, icon('clock', 15), h('span', { id: 'when-label' }, whenLabel()), icon('down', 12)),
    h('span', { id: 'near-stops' }),
    whenOpen && h('div', { class: 'when-panel' },
      segments([['now', t('現在出發', 'Leave now')], ['depart', t('出發時間', 'Leave at')], ['arrive', t('抵達時間', 'Arrive by')]], state.when?.mode ?? 'now', chooseWhen),
      state.when && whenPicker()));
  renderNearStops();
}

/** Beside the time, and apart from it, so that planning again leaves a half-picked time alone. */
function renderNearStops() {
  const slot = $('near-stops');
  if (slot) clear(slot, !state.planDirty && state.to && h('button', { class: 'when-chip', onclick: () => showStopsNear(state.to) }, icon('bus', 15), t('目的地附近站點', 'Stops near destination')),
    !state.planDirty && state.to && inHongKong(state.to.location) && h('button', { id: 'explore-destination', class: 'when-chip', onclick: openExplore },
      icon('search', 15), t('探索目的地附近', 'Explore nearby')));
}

function showStopsNear(place) {
  state.stopQuery = place.name;
  setTab('stops');
  searchStops(false, place);
}

function clearExplore() {
  state.explore?.request?.abort();
  clearExplorePreview(state.explore);
  state.explore = null;
}

function clearExplorePreview(view) {
  if (!view?.preview) return;
  view.preview = null;
  mapView.previewPlace(null);
}

function openExplore() {
  if (state.explore || !state.to || !inHongKong(state.to.location)) return;
  state.explore = { destination: state.to, snap: sheet.current, scroll: $('sheet').scrollTop };
  sheet.snap('full');
  void searchExplore('food', 800);
  document.querySelector('#explore-panel > .back')?.focus({ preventScroll: true });
}

function closeExplore() {
  const view = state.explore;
  if (!view) return;
  const refocus = !!view.preview;
  clearExplore();
  renderSheet();
  $('sheet').scrollTop = view.scroll;
  sheet.snap(view.snap);
  if (refocus) fitPlanMap();
  $('explore-destination')?.focus({ preventScroll: true });
}

async function searchExplore(category, radius) {
  const view = state.explore;
  view.request?.abort();
  clearExplorePreview(view);
  if (category !== view.category) {
    view.ai = null;
  }
  const request = new AbortController();
  Object.assign(view, { category, radius, request, places: [], sources: [], selected: null, busy: true, choosing: false, notice: null });
  renderSheet();
  $('sheet').scrollTop = 0;
  const results = await exploreDestination(view.destination, category, radius, state.lang, request.signal)
    .catch(() => ({ places: [], sources: [] }));
  if (state.explore !== view || request.signal.aborted) return;
  Object.assign(view, results, { busy: false });
  renderSheet();
}

const exploreLocale = () => state.lang === 'en' ? 'en' : state.script === 'hans' ? 'zh-Hans' : 'zh-Hant';

async function showExploreAI(view) {
  const assistant = client();
  if (!assistant || view.ai?.busy) return;
  if (view.ai?.suggestions.length) {
    view.ai.open = !view.ai.open;
    if (!view.ai.open && view.preview?.kind === 'ai') clearExplorePreview(view);
    return renderSheet();
  }
  const ai = view.ai = { open: true, busy: true, suggestions: [], failed: false };
  renderSheet();
  // Keep receiving the usage if the rider leaves the panel before the model finishes.
  const answer = await assistant.explore(view.destination, view.category, exploreLocale())
    .catch((error) => ({ failed: true, status: error.status }));
  if (state.explore !== view || view.ai !== ai) return;
  Object.assign(ai, { busy: false, suggestions: answer.suggestions ?? [], failed: answer.failed, status: answer.status });
  renderSheet();
}

function showExplorePlace(view, place) {
  if (view.choosing) return;
  view.selected = view.selected === place ? null : place;
  view.notice = null;
  if (!view.selected) {
    clearExplorePreview(view);
    return renderSheet();
  }
  void focusExploredPlace(view, place, 'map');
  if (mapView === googleMap) {
    googleWalk(view.destination.location, place.location).then(() => {
      if (state.explore === view && view.selected === place) renderSheet();
    });
  }
}

const explorePlaceKey = (text) => normalizePlace(toSimplified(text ?? ''));
const exploreAddressKey = (text) => explorePlaceKey(text).normalize('NFKC').replace(/[\s,]+/g, '');

/** Margin moves the geographic target into the portion of the map beside or above the panel. */
function exploreMapOffset() {
  if (sheet.mapOnly) return [0, 0];
  const height = $('map').clientHeight, panel = $('panel');
  if (window.matchMedia('(min-width: 820px)').matches) return [-panel.getBoundingClientRect().right / 2, 0];
  const visible = Math.max(0, height - sheet.targetHeight() - (parseFloat(getComputedStyle(panel).bottom) || 0));
  return [0, height / 2 - visible * 0.6];
}

async function focusExploredPlace(view, item, kind) {
  const previous = view.preview;
  const engine = mapView;
  if (previous?.item === item && previous.engine === engine && previous.pending) return;
  const target = previous?.item === item && previous.engine === engine ? previous.target : null;
  clearExplorePreview(view);
  const preview = view.preview = { item, kind, engine, pending: true, target: null };
  sheet.snap('half');
  renderSheet();

  preview.target = target ?? await (kind === 'ai' ? resolveExploreAI(view, item) : resolveExplorePlace(view, item))
    .catch(() => null);
  if (state.explore !== view || view.preview !== preview || mapView !== engine) return;
  preview.pending = false;
  if (preview.target) {
    const location = preview.target.location;
    const delay = engine.follow(location, 17, true, exploreMapOffset());
    engine.previewPlace({ name: item.name, location }, delay);
  }
  renderSheet();
}

async function resolveExplorePlace(view, place) {
  if (view.provider !== 'google' || mapView === googleMap) return place;
  const [government, osm] = await Promise.all([governmentSearch(place.name), photonSearch(place.name, place.location, 180)]);
  return withinArea([...government, ...osm], { center: place.location, radius: 180 })
    .find((candidate) => [candidate.name, candidate.nameEn].some((name) => explorePlaceKey(name) === explorePlaceKey(place.name)));
}

async function planToExplorePlace(view, place) {
  if (view.choosing) return;
  view.choosing = true;
  view.notice = null;
  renderSheet();
  const cached = view.preview?.item === place && view.preview.engine === mapView ? view.preview.target : null;
  const target = cached ?? await resolveExplorePlace(view, place);
  if (state.explore !== view || view.selected !== place) return;
  view.choosing = false;
  if (!target) {
    view.notice = t('未能配對到這個地點。可以在 Google 地圖查看。', "Couldn't match this place for routing. You can open it in Google Maps.");
    return renderSheet();
  }
  routeToExploredPlace(place.name, target.location);
}

function routeToExploredPlace(name, location) {
  const start = state.from;
  state.destination = name;
  state.discovery = null;
  syncPlaceInputs();
  runPlan({ kind: 'place', place: { name, location }, start });
}

async function resolveExploreAI(view, item) {
  const key = explorePlaceKey;
  const center = view.destination.location, radius = 1500;
  const match = (places) => {
    const nearby = withinArea(places.filter((place) => [place.name, place.nameEn].some((name) => key(name) === key(item.name))),
      { center, radius });
    const address = exploreAddressKey(item.address);
    if (address) return nearby.find((place) => {
      const candidate = exploreAddressKey(place.address);
      return candidate.length >= 6 && address.length >= 6 && (candidate.includes(address) || address.includes(candidate));
    });
    return nearby.length && nearby.every((place) => meters(nearby[0].location, place.location) < 40) ? nearby[0] : null;
  };
  const known = match(view.provider !== 'google' || mapView === googleMap ? view.places : []);
  if (known) return known;
  const [google, government, osm] = await Promise.all([
    mapView === googleMap ? googleSearch([item.name, item.address].filter(Boolean).join(' '), center, radius, state.lang) : null,
    governmentSearch(item.name),
    photonSearch(item.name, center, radius),
  ]);
  return match([...(mapView === googleMap ? (google ?? []) : []), ...government, ...osm]);
}

async function planToExploreAI(view, item) {
  const ai = view.ai;
  if (ai.choosing) return;
  ai.choosing = item;
  ai.unmatched = null;
  renderSheet();
  const cached = view.preview?.item === item && view.preview.engine === mapView ? view.preview.target : null;
  const target = cached ?? await resolveExploreAI(view, item);
  if (state.explore !== view || view.ai !== ai) return;
  ai.choosing = null;
  if (target) return routeToExploredPlace(item.name, target.location);
  ai.unmatched = item;
  renderSheet();
}

function googleDirections() {
  const coords = ({ location }) => `${location.lat},${location.lng}`;
  const params = new URLSearchParams({ api: '1', origin: coords(state.from), destination: coords(state.to), travelmode: 'transit' });
  return `https://www.google.com/maps/dir/?${params}`;
}

function journeyCard(journey) {
  const id = journeyID(journey), isOpen = state.expanded === id, isNavigating = state.nav?.id === id;
  const shown = journey.legs.filter((leg) => leg.type === 'ride' || leg.minutes >= 0.5);
  const changes = transfers(journey);
  const arrive = clock(arrivalTime(journey));
  const shuttle = includesEdUHK(journey);
  const universityShuttle = shuttle && rides(journey).some((ride) => ride.route === 'EdUHK University' && ride.op === 'eduhk');
  const cents = journeyFare(journey, planningDB(), railFares.get(state.fareProfile), state.fareProfile);
  const money = cents == null ? null : `HK$${(cents / 100).toFixed(2)}`;
  const fare = money ? (cents === 0 ? t(`全程車費 ${money}`, `Total fare ${money}`) : t(`全程車費約 ${money}`, `Est. fare ${money}`))
    : railFareRequests.has(state.fareProfile) && usesRail(journey) ? t('正在查詢車費…', 'Checking fare…')
      : t('全程車費暫缺資料', 'Total fare unavailable');
  const canNavigate = !shuttle && rides(journey).every((ride) => ride.routeKey || ride.providerStops?.length >= 2);
  return h('div', { class: `card${isOpen ? ' open' : ''}${state.onMap === id ? ' on-map' : ''}${state.justOpened === id ? ' reveal' : ''}`, 'data-journey': id },
    h('button', {
      class: 'tap', 'aria-expanded': String(isOpen), onclick: () => {
        state.onMap = id;
        state.pickedJourney = true;
        state.expanded = isOpen ? null : id;
        state.justOpened = isOpen ? null : id;
        state.focus = null;
        clearMapStop();
        renderSheet();
        renderNavBanner();
        // The route is what was asked for, so a sheet covering the map makes way for it.
        if (!isOpen) closeSheetForMap();
        fitPlanMap();
        if (!isOpen) document.querySelector('.card.open')?.scrollIntoView({ block: 'nearest', behavior: calm.matches ? 'auto' : 'smooth' });
      },
    },
      h('div', { class: 'journey-heading' },
        h('span', { class: 'journey-duration' },
          h('span', { class: 'minutes' }, Math.round(totalMinutes(journey))),
          h('span', { class: 'small muted' }, t('分鐘', 'min'))),
        h('span', { class: `journey-arrival${arrivesLate(journey) ? ' late' : ''}` }, t(`${arrive} 到達`, `Arrive ${arrive}`))),
      h('div', { class: 'chips journey-chips' }, shown.flatMap((leg, index) => [
        index > 0 && icon('next', 13),
        leg.type === 'walk' ? h('span', { class: 'walk' }, icon('walk', 15), Math.max(1, Math.round(leg.minutes)))
          : h('span', { class: 'journey-ride' }, badge(leg.op, leg.route),
            leg.liveDeparture && h('span', { class: 'journey-live' }, leg.isProjected ? t('實時推算', 'Live estimate') : t('實時', 'Live'))),
      ])),
      (state.when || isNavigating) && h('div', { class: 'journey-summary tiny muted' },
        state.when && h('span', {}, t(`${clock(journey.departure)} 出發`, `Leave ${clock(journey.departure)}`)),
        isNavigating && h('span', { class: 'live bold' }, t('導航中', 'Navigating'))),
      h('div', { class: 'journey-summary tiny muted' },
        h('span', {}, `${changes ? t(`轉 ${changes} 次`, `${changes} change${changes > 1 ? 's' : ''}`) : t('直達', 'Direct')} · ${t(`步行 ${Math.round(walkingMeters(journey))} 米`, `walk ${Math.round(walkingMeters(journey))} m`)}`),
        shuttle && h('span', { class: 'late bold' }, t('只限教大師生', 'EdUHK students and staff only')),
        h('span', { class: cents == null ? 'journey-fare' : 'journey-fare bold' }, fare))),
    isOpen && h('div', { class: 'timeline' }, journey.legs.map(legDetail)),
    isOpen && h('div', { class: 'tiny muted' }, t('規劃來源', 'Route source'), ' · ',
      journey.provider === 'transitous' ? 'Transitous' : journey.provider === 'google' ? 'Google Maps' : t('內置規劃', 'Built-in planner')),
    isOpen && shuttle && h('div', { class: 'stack' },
      h('div', { class: 'small muted' }, t('上車須拍教大學生證或職員證。開車時間按校方班表，車程和地圖位置為估算。', 'Tap your EdUHK student or staff card when boarding. Departure times follow the timetable. Journey times and map locations are approximate.')),
      h('a', { class: 'link', href: universityShuttle ? EDUHK_UNIVERSITY : EDUHK_TIMETABLE, target: '_blank', rel: 'noopener' },
        universityShuttle ? t('校方大學站線服務資料', 'University Station shuttle information') : t('校方時刻表及車費', 'Official timetable and fares'))),
    isOpen && cents > 0 && h('div', { class: 'tiny muted' },
      t('按設定的票價類別估算，實付金額視乎付款方式及優惠。', 'Estimated using the fare profile in Settings. Payment method and discounts may change the actual fare.')),
    isOpen && !canNavigate && !shuttle && h('a', { class: 'link', href: googleDirections(), target: '_blank', rel: 'noopener' }, t('在 Google 地圖查看', 'View in Google Maps')),
    isOpen && canNavigate && h('button', {
      class: `primary wide${isNavigating ? ' danger' : ''}`,
      onclick: () => {
        stopNavigation();
        if (!isNavigating) return startNavigation(journey);
        renderSheet();
        fitPlanMap();
      },
    }, icon(isNavigating ? 'stop' : 'navigate', 18, true), isNavigating ? t('結束導航', 'End navigation')
      : state.nav ? t('切換到此路線導航', 'Switch navigation to this route') : t('開始導航', 'Start navigation')));
}

function legDetail(leg) {
  if (leg.type === 'walk') {
    const minutes = Math.max(1, Math.round(leg.minutes)), target = leg.targetName ?? (leg.to ? name(leg.to) : t('目的地', 'destination'));
    // Google's walks follow the streets; without one, the time is from the straight line.
    const source = leg.walkSource === 'transitous' ? t('（Transitous 步行路線）', ' (Transitous walking route)')
      : leg.walkFromMap ? t('（Google 步行路線）', ' (Google walking route)') : t('（按直線估算）', ' (estimated from the straight line)');
    return h('div', { class: 'leg walking' }, h('div', { class: 'track' }),
      h('div', { class: 'body small muted' }, t(`步行約 ${minutes} 分鐘（${Math.round(leg.meters)} 米）到 ${target}`, `Walk about ${minutes} min (${Math.round(leg.meters)} m) to ${target}`) + source));
  }
  const wait = Math.round(leg.waitMinutes), platform = leg.livePlatform ? ` · ${nameText(leg.livePlatform, state.lang)}` : '';
  const scheduledPlatform = leg.scheduledPlatform ? t(` · 月台 ${leg.scheduledPlatform}`, ` · Platform ${leg.scheduledPlatform}`) : '';
  const when = leg.op === 'eduhk' ? t(`班表 ${clock(leg.scheduledDeparture)} 開出`, `Timetable departure ${clock(leg.scheduledDeparture)}`)
    : !leg.liveDeparture && leg.scheduledDeparture != null ? t(`預計 ${clock(leg.scheduledDeparture)} 開出`, `Expected departure ${clock(leg.scheduledDeparture)}`) + scheduledPlatform
    : !leg.liveDeparture ? t(`估算：等候約 ${wait} 分鐘（暫無實時資料）`, `Estimate: about ${wait} min wait (no live data)`)
    : leg.isProjected ? t(`實時推算：約 ${clock(leg.liveDeparture)} 開出（等候約 ${wait} 分鐘）`, `Projected from live: about ${clock(leg.liveDeparture)} (${wait} min wait)`) + platform
      : t(`實時：${clock(leg.liveDeparture)} 開出（等候約 ${wait} 分鐘）`, `Live: departs ${clock(leg.liveDeparture)} (${wait} min wait)`) + platform;
  const stops = leg.stopCount ?? (leg.alightPosition - leg.boardPosition);
  const board = leg.boardName ?? name(leg.boardStopID), alight = leg.alightName ?? name(leg.alightStopID);
  const duration = t(`約 ${Math.round(leg.rideMinutes)} 分鐘`, `about ${Math.round(leg.rideMinutes)} min`);
  const element = h('div', { class: 'leg' },
    h('div', { class: 'track' }, h('i', { class: 'node' })),
    h('div', { class: 'body' },
      h('div', { class: 'row' }, h('span', { class: 'bold ellipsis' }, board), badge(leg.op, leg.route)),
      h('div', { class: 'tiny muted' }, t(`往 ${leg.dest.zh}`, `To ${leg.dest.en}`)),
      h('div', { class: `tiny ${leg.liveDeparture ? 'live' : 'muted'}` }, when),
      h('div', { class: 'tiny muted', style: 'margin-top:4px' }, Number.isFinite(stops) ? t(`${stops} 個站 · ${duration}`, `${stops} stops · ${duration}`) : duration),
      h('div', { class: 'bold small', style: 'margin-top:4px' }, t(`${alight} 下車`, `Get off at ${alight}`))));
  element.style.setProperty('--leg', lineColor(leg.op, leg.route));
  return element;
}

const PRICE_SIGNS = { PRICE_LEVEL_INEXPENSIVE: '$', PRICE_LEVEL_MODERATE: '$$', PRICE_LEVEL_EXPENSIVE: '$$$', PRICE_LEVEL_VERY_EXPENSIVE: '$$$$' };

function shopFacts(place) {
  const facts = [
    place.rating && h('b', { class: 'stars' }, `★ ${place.rating.toFixed(1)}`),
    place.rating && place.ratings && `(${place.ratings.toLocaleString()})`,
    PRICE_SIGNS[place.price],
    place.kind,
    place.open === true && h('span', { class: 'open' }, t('營業中', 'Open')),
    place.open === false && h('span', { class: 'shut' }, t('休息中', 'Closed')),
  ].filter(Boolean);
  return facts.length > 0 && h('div', { class: 'shop-facts tiny' }, facts);
}

function shopLinks(place, suggestion) {
  const links = [
    embedShops() && suggestion.isGoogle && h('a', { href: '#', onclick: (event) => { event.preventDefault(); event.stopPropagation(); planToShop(suggestion); } }, t('規劃路線', 'Plan a route')),
    place.phone && h('a', { href: `tel:${place.phone.replace(/\s/g, '')}`, onclick: (event) => event.stopPropagation() }, place.phone),
    place.mapsUrl && h('a', { href: place.mapsUrl, target: '_blank', rel: 'noopener', onclick: (event) => event.stopPropagation() }, t('在 Google 地圖查看', 'View on Google Maps')),
  ].filter(Boolean);
  return links.length > 0 && h('div', { class: 'shop-links tiny' }, links);
}

const EXPLORE_KINDS = {
  restaurant: ['餐廳', 'Restaurant'], cafe: ['咖啡店', 'Café'], fast_food: ['快餐', 'Fast food'],
  bakery: ['麵包店', 'Bakery'], attraction: ['景點', 'Attraction'], museum: ['博物館', 'Museum'],
  gallery: ['藝廊', 'Gallery'], park: ['公園', 'Park'], monument: ['古蹟', 'Monument'],
};

function explorePreviewStatus(view, item) {
  const preview = view.preview;
  if (preview?.item !== item || preview.target) return null;
  return h('div', { class: 'tiny muted', role: 'status' }, preview.pending
    ? t('正在確認地圖位置…', 'Finding the map location…')
    : t('暫時未能確認地圖位置。', 'The map location could not be confirmed.'));
}

function exploreAISection(view) {
  const ai = view.ai;
  const disabled = !state.aiConfig;
  const cards = ai?.suggestions.map((item) => {
    const query = [item.name, item.address, 'Hong Kong'].filter(Boolean).join(' ');
    const maps = new URLSearchParams({ api: '1', query });
    const focused = view.preview?.item === item;
    return h('article', { class: `card explore-ai-card${focused ? ' on-map' : ''}` },
      h('button', {
        class: 'tap explore-ai-place', 'aria-pressed': String(focused), onclick: () => {
          view.selected = null;
          void focusExploredPlace(view, item, 'ai');
        },
      },
      h('span', { class: 'row' }, h('strong', { class: 'grow' }, item.name), icon('pin', 15)),
      item.address && h('span', { class: 'tiny muted' }, item.address),
      h('span', { class: 'small' }, item.reason)),
      explorePreviewStatus(view, item),
      ai.unmatched === item && h('div', { class: 'tiny muted', role: 'status' }, t('未能確認地點，可先在地圖查看。', "Couldn't confirm the location. You can check it on a map.")),
      h('div', { class: 'explore-actions tiny' },
        h('button', { class: 'link', disabled: !!ai.choosing, onclick: () => planToExploreAI(view, item) },
          ai.choosing === item ? t('正在確認地點…', 'Confirming place…') : t('規劃到這裡', 'Plan a route here')),
        h('a', { class: 'link', href: item.source.url, target: '_blank', rel: 'noopener noreferrer', title: item.source.title },
          t('查看來源', 'Read source')),
        h('a', { class: 'link', href: `https://www.google.com/maps/search/?${maps}`, target: '_blank', rel: 'noopener noreferrer' },
          t('在地圖查看', 'Find on a map'))));
  });
  return [
    h('button', { class: 'link explore-ai-button', 'aria-expanded': String(!!ai?.open), disabled: disabled || ai?.busy,
      title: disabled ? enableAIHint() : null, onclick: () => showExploreAI(view) },
      icon('spark', 15), t('AI 建議', 'AI suggestions')),
    disabled && h('div', { class: 'tiny muted' }, enableAIHint()),
    ai?.open && h('section', { class: 'explore-ai-results', 'aria-busy': String(ai.busy) },
      ai.busy && h('div', { class: 'status', role: 'status' }, h('span', { class: 'spinner' }), t('AI 正在搜尋網頁及整理建議…', 'AI is searching the web and preparing suggestions…')),
      !ai.busy && !cards.length && h('div', { class: 'notice', role: 'status' }, ai.failed ? aiErrorMessage(ai.status)
        : t('暫時找不到有網頁來源支持的建議。', 'No suggestions with usable web sources were found.')),
      cards.length > 0 && h('div', { class: 'tiny muted' },
        t(`找到 ${cards.length} 個有來源的建議 · 搜尋範圍約 1.5 公里`, `${cards.length} suggestions with sources · Search area about 1.5 km`)),
      cards),
  ];
}

function exploreSheet(view) {
  const { category, destination, radius, places, sources, selected, busy, provider } = view;
  const tabs = segments([['food', t('美食', 'Food')], ['sights', t('好去處', 'Things to do')]], category, (choice) => {
    if (choice !== category) void searchExplore(choice, radius);
  });
  const sourceLink = (source) => h('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer' }, source.title);
  const placeCards = places.map((place) => {
    const open = selected === place;
    const walk = open && knownWalkTime(destination.location, place.location);
    const kind = EXPLORE_KINDS[place.kind];
    return h('article', { class: `card explore-place${view.preview?.item === place ? ' on-map' : ''}` },
      h('button', { class: 'tap', disabled: view.choosing, 'aria-expanded': String(open), onclick: () => showExplorePlace(view, place) },
        h('span', { class: 'row' }, h('span', { class: 'bold grow' }, place.name), icon(open ? 'down' : 'next', 14)),
        h('span', { class: 'explore-facts tiny muted' }, [
          kind ? t(...kind) : place.kind, t(`直線 ${distanceText(place.meters)}`, `${distanceText(place.meters)} straight-line`),
        ].filter(Boolean).join(' · '))),
      open && h('div', { class: 'stack small' },
        explorePreviewStatus(view, place),
        place.address && h('div', { class: 'muted' }, place.address),
        walk && h('div', { class: 'muted' }, t(`由目的地步行約 ${Math.max(1, Math.round(walk.minutes))} 分鐘 · Google Maps`, `About ${Math.max(1, Math.round(walk.minutes))} min on foot from the destination · Google Maps`)),
        place.source && h('div', { class: 'explore-evidence tiny' }, h('p', {}, place.source.snippet), sourceLink(place.source)),
        view.notice && h('div', { class: 'notice', role: 'status' }, view.notice),
        h('div', { class: 'explore-actions' },
          h('button', { class: 'link', disabled: view.choosing, onclick: () => planToExplorePlace(view, place) },
            view.choosing ? t('正在確認地點…', 'Confirming place…') : t('規劃到這裡', 'Plan a route here')),
          place.mapsUrl && h('a', { class: 'link', href: place.mapsUrl, target: '_blank', rel: 'noopener noreferrer', translate: 'no' }, 'Google Maps'))));
  });
  return h('section', { id: 'explore-panel', 'aria-busy': String(busy), onkeydown: (event) => { if (event.key === 'Escape') closeExplore(); } },
    h('button', { class: 'back', onclick: closeExplore }, icon('back', 17), t('返回路線', 'Back to route')),
    h('div', {},
      h('div', { class: 'title' }, t(`探索「${destination.name}」附近`, `Explore around ${destination.name}`)),
      h('div', { class: 'tiny muted' }, t(`目的地周邊 ${distanceText(radius)}`, `Within ${distanceText(radius)} of the destination`))),
    tabs,
    exploreAISection(view),
    busy && h('div', { class: 'status', role: 'status' }, h('span', { class: 'spinner' }), t('搜尋附近地點及網頁…', 'Searching nearby places and guides…')),
    !busy && !places.length && h('div', { class: 'notice', role: 'status' }, t('這個範圍內暫時找不到合適的地點。', 'No places found in this area.')),
    places.length > 0 && (provider === 'google' ? h('div', { class: 'explore-google', translate: 'no' }, 'Google Maps')
      : h('a', { class: 'tiny muted', href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, '© OpenStreetMap contributors')),
    placeCards,
    !busy && radius === 800 && places.length < 6 && h('button', { class: 'link', onclick: () => searchExplore(category, 1500) },
      t('擴大到 1.5 公里', 'Expand to 1.5 km')),
    h('div', { class: 'card explore-sources small' },
      h('strong', {}, t('附近網頁及攻略', 'Nearby guides and web sources')),
      sources.slice(0, 4).map(sourceLink),
      h('a', { class: 'link', href: exploreWebSearchURL(destination.name, category, exploreLocale()), target: '_blank', rel: 'noopener noreferrer' },
        icon('search', 14), t('在瀏覽器搜尋更多', 'Search the web'))));
}

function suggestionList({ wish, areaName, suggestions, notice }) {
  return [
    notice && h('div', { class: 'notice' }, notice),
    h('div', { class: 'row' }, h('span', { class: 'title grow' }, wish.anywhere ? t(`「${wish.want}」的結果`, `Results for "${wish.want}"`) : t(`${areaName}的${wish.want}`, `${wish.want} around ${areaName}`)),
      h('button', { class: 'link', onclick: () => { state.discovery = { stage: 'asking', wish: { ...wish, area: null, question: null, options: [] } }; renderSheet(); drawMap(); renderBottomStatus(); } }, t('換範圍', 'Change area'))),
    h('div', { class: 'tiny muted' }, suggestions.some((suggestion) => suggestion.isGoogle)
      ? t('資料及排序來自 Google 地圖。出發前請確認仍在營業。', 'Details and order from Google Maps. Check it is open before you go.')
      : t('地點來自地圖搜尋，沒有菜單資料，未必有售，出發前請先確認。', 'Places come from a map search, which has no menus. Check before you go.')),
    suggestions.map((suggestion, index) => h('div', {
      class: 'card tap', role: 'button', tabindex: 0, onclick: () => (embedShops() && suggestion.isGoogle ? showOnEmbed(suggestion) : choosePlace(suggestion)),
      onkeydown: (event) => { if (event.key === 'Enter') choosePlace(suggestion); },
    },
      h('div', { class: 'row', style: 'align-items:flex-start' }, h('span', { class: 'num' }, index + 1),
        h('div', { class: 'grow' },
          h('div', { class: 'row' }, h('span', { class: 'bold ellipsis grow' }, suggestion.place.name), h('span', { class: 'tiny muted' }, distanceText(suggestion.place.meters))),
          shopFacts(suggestion.place),
          suggestion.place.address && h('div', { class: 'tiny muted ellipsis' }, suggestion.place.address),
          shopLinks(suggestion.place, suggestion))))),
  ];
}

/** Shortcuts and recent searches, under the search field. */
function homeSheet() {
  const go = (text) => { state.destination = text; search(); };
  const recent = history.entries('destination');
  const list = h('div', { class: 'list' });
  let open = false;
  const draw = () => clear(list, (open ? recent : recent.slice(0, HISTORY_SHOWN)).map((text) => h('button', { class: 'item', onclick: () => go(text) },
    h('span', { class: 'dot' }, icon('clock', 17)), h('span', { class: 'grow ellipsis' }, text), icon('next', 15))));
  draw();
  const examples = state.lang === 'zh' ? ['沙田到中環', '去機場不想轉車', '我想吃螺螄粉'] : ['Sha Tin to Central', 'Airport, no transfers'];
  return [
    h('div', { class: 'shortcuts' }, [['stops', 'pin', t('站點', 'Stops')], ['routes', 'bus', t('路線', 'Routes')], ['saved', 'star', t('收藏', 'Saved')], ['settings', 'settings', t('設定', 'Settings')]]
      .map(([tab, key, label]) => h('button', { onclick: () => setTab(tab) }, h('i', {}, icon(key, 22)), label))),
    recent.length ? [
      h('div', { class: 'section' }, h('span', {}, t('最近', 'Recents')),
        recent.length > HISTORY_SHOWN && h('button', { class: 'link', onclick: (event) => { open = !open; event.target.textContent = open ? t('收起', 'Less') : t('更多', 'More'); draw(); } }, t('更多', 'More'))),
      list,
    ] : [
      h('div', { class: 'section' }, t('試試問 AI', 'Try asking AI')),
      h('div', { class: 'examples' }, examples.map((text) => h('button', { disabled: !state.aiConfig,
        onclick: () => { state.chat = text; sendChat(); } }, text))),
    ],
  ];
}

const PHASES = {
  understanding: () => t('理解要求…', 'Reading your request…'),
  findingPlaces: () => (googleShops() ? t('正在 Google 地圖搜尋…', 'Searching Google Maps…') : t('正在搜尋地點…', 'Searching for places…')),
  locating: () => t('正在尋找起點及目的地…', 'Finding places…'),
  planning: () => t('正在比較公共交通路線…', 'Comparing public transport routes…'),
  checkingLive: () => t('正在核對實時到站時間…', 'Checking live arrivals…'),
};

function planSheet() {
  if (state.explore) return exploreSheet(state.explore);
  const items = [];
  if (!state.db) {
    items.push(state.dbError
      ? [h('div', { class: 'notice' }, state.dbError), h('button', { class: 'primary', onclick: loadDB }, t('重試', 'Retry'))]
      : h('div', { class: 'status' }, h('span', { class: 'spinner' }), t('正在載入路線資料…', 'Loading route data…')));
    return items;
  }
  items.push(h('div', { id: 'plan-stop' }, planStopCard()));
  if (state.planDirty) return [...items, h('div', { class: 'notice', role: 'status' },
    t('起點或目的地已更改，請重新搜尋路線。', 'The start or destination has changed. Search again to update the route.'),
    h('button', { class: 'link', disabled: !state.destination.trim(), onclick: () => search() }, t('搜尋新路線', 'Search new route')))];
  // While the AI thinks, its card says so.
  if (PHASES[state.phase] && !(state.phase === 'understanding' && state.thread)) items.push(h('div', { class: 'status' }, h('span', { class: 'spinner' }), PHASES[state.phase]()));
  if (PHASES[state.phase] && !state.journeys.length) items.push(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
  if (state.error && !state.thread?.reply) items.push(h('div', { class: 'notice' }, state.error));
  const best = state.journeys[0];
  if (best && arrivesLate(best)) items.push(h('div', { class: 'notice' }, t(`${clock(best.arriveBy)} 前趕不及，最快約 ${clock(arrivalTime(best))} 到達。`, `You can't make it by ${clock(best.arriveBy)}. The earliest is about ${clock(arrivalTime(best))}.`)));
  if (state.candidates.length && state.phase === 'done') {
    if (!state.nav) items.push(segments([['lessWalking', t('少行路', 'Less walking')], ['fewerTransfers', t('少轉車', 'Fewer changes')], ['fastest', t('最快', 'Fastest')]], state.preference, (preference) => {
      if (state.preference === preference) return;
      state.preference = preference;
      runPlan({ kind: 'replan' });
    }));
    const shownTransit = state.journeys.some((journey) => rides(journey).length);
    const longTransit = state.candidates.some((journey) => rides(journey).length && !fitsWalkLimit(journey));
    if (!state.allowLongWalk && (!state.journeys.length || (!shownTransit && longTransit))) items.push(h('div', { class: 'notice' },
      t(`步行較長的方案至少有一段超過 ${MAX_WALK_LEG_MINUTES} 分鐘。`, `The longer routes include a walk over ${MAX_WALK_LEG_MINUTES} minutes.`),
      h('button', { class: 'link', onclick: () => {
        state.allowLongWalk = true;
        showTripOptions(state.candidates);
        renderSheet();
        fitPlanMap();
      } }, t('查看步行較長的方案', 'Show routes with longer walks'))));
    if (state.explanation && !state.thread) items.push(h('div', { class: 'advice' }, state.explanation));
  }
  if (state.discovery?.stage === 'choosing') {
    if (state.journeys.length || state.phase !== 'idle') {
      items.push(h('button', { class: 'back', onclick: backToSuggestions }, icon('back', 17), t('返回推薦地點', 'Back to recommendations')));
    } else {
      items.push(suggestionList(state.discovery));
    }
  }
  if (state.candidates.some((journey) => journey.provider === 'transitous')) {
    items.push(h('div', { class: 'tiny muted' },
      h('a', { href: 'https://transitous.org/sources/', target: '_blank', rel: 'noopener' }, t('Transitous 資料來源', 'Transitous data sources')),
      ' · ',
      h('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, '© OpenStreetMap contributors')));
  }
  items.push(state.journeys.map(journeyCard));
  const isWaitingForAnswer = state.discovery?.stage === 'asking';
  if (!state.routeView && (!state.discovery || isWaitingForAnswer) && state.phase === 'idle') items.push(state.destination.trim() && state.db ? placeSuggestions() : homeSheet());
  return items;
}

/** The AI's turn in the conversation; null while it only has a question to add. */
function answer(reply) {
  if (!state.thread?.busy) return;
  state.thread = { said: state.thread.said, reply };
  if (reply) remember('App', reply);
  renderBottomStatus();
}

function endChat() {
  if (state.discovery?.stage === 'asking') state.discovery = null;
  Object.assign(state, { thread: null, talk: [], lastSearch: null });
  renderBottomStatus();
  renderSheet();
}

/** One card for the last exchange: what the rider said, then the answer. The results are in the sheet. */
function renderBottomStatus() {
  const slot = $('ai-status');
  if (!slot) return;
  const wish = state.discovery?.stage === 'asking' ? state.discovery.wish : null;
  // The AI's own question, or just "where?" when the search couldn't find the rider.
  const question = wish && (wish.question ?? t(`想找${wish.want}，要在哪裡找？`, `Where should I look for ${wish.want}?`));
  const options = wish ? (wish.question ? wish.options : [t('附近', 'Nearby'), '旺角', '銅鑼灣', '尖沙咀', '中環']) : [];
  const { said, reply, busy } = state.thread ?? {}, text = [reply, question].filter(Boolean).join(' ');
  const isNew = !slot.querySelector('.ai-card');
  clear(slot,
    (said || text) && h('div', { class: `ai-card${isNew ? ' fresh' : ''}` },
      h('i', { class: 'ai-mark' }, icon('spark', 15, true)),
      h('div', { class: 'ai-body' },
        said && h('div', { class: 'ai-said ellipsis' }, said),
        busy ? h('div', { class: 'typing', role: 'status', 'aria-label': t('AI 正在回覆', 'AI is replying') }, h('i'), h('i'), h('i')) : h('div', { class: 'ai-text' }, text),
        !busy && options.length > 0 && h('div', { class: 'choices' }, options.map((option) => h('button', { onclick: () => askAI(option) }, option))),
        state.aiNotice && h('div', { class: 'tiny muted' }, state.aiNotice)),
      !busy && h('button', { class: 'ai-close', 'aria-label': t('結束對話', 'End conversation'), onclick: endChat }, icon('close', 13))),
    !said && !text && state.aiNotice && h('div', { class: 'tiny muted' }, state.aiNotice));
  renderChatControls();
}

const speechLabels = () => ({ 'zh-HK': t('粵語', 'Cantonese'), 'zh-CN': t('普通話', 'Mandarin'), 'en-US': 'English' });

function renderPlanBottom() {
  const disabled = !state.aiConfig;
  clear($('bottom'),
    h('div', { id: 'ai-status' }),
    h('div', { id: 'chat-history' }),
    h('div', { id: 'composer', class: `field composer${Recognition ? '' : ' no-mic'}${state.chat.trim() ? ' typing' : ''}`,
      'aria-disabled': String(disabled) },
      h('span', { class: disabled ? 'muted' : 'ai' }, icon('spark', 18)),
      h('input', {
        id: 'chat-input', disabled, value: state.chat, placeholder: chatPrompt(), enterkeyhint: 'send', autocomplete: 'off',
        oninput: (event) => {
          state.chat = event.target.value;
          syncComposer();
        },
        onfocus: () => renderChatHistory(true),
        onblur: () => setTimeout(() => renderChatHistory(false), 150),
        onkeydown: (event) => { if (event.key === 'Enter') sendChat(); },
      }),
      Recognition && h('button', { id: 'mic', class: 'icon-button', disabled, 'aria-label': t('語音輸入', 'Voice input'), onclick: toggleSpeech }, icon('mic', 20)),
      h('button', { class: 'go', disabled, 'aria-label': t('傳送', 'Send'), onmousedown: (event) => event.preventDefault(), onclick: sendChat }, icon('send', 19))),
    disabled && h('div', { class: 'tiny muted', style: 'padding:0 6px' }, state.aiKeyRejected ? aiErrorMessage(401) + ' ' + enableAIHint() : enableAIHint()));
  renderBottomStatus();
}

// MARK: Stops tab

/** The title row of a view opened from the home sheet. */
function viewHeader(title) {
  return h('div', { class: 'row' }, h('span', { class: 'view-title grow' }, title),
    h('button', { class: 'round', 'aria-label': t('關閉', 'Close'), onclick: () => setTab('plan') }, icon('close', 16)));
}

function renderStopsTop() {
  clear($('top'), viewHeader(t('站點', 'Stops')),
    h('div', { class: 'search-card single' },
      h('span', { class: 'muted' }, icon('search', 19)),
      h('input', {
        id: 'stop-input', value: state.stopQuery, placeholder: t('搜尋站名或地點', 'Search for a stop or place'), enterkeyhint: 'search', autocomplete: 'off',
        oninput: (event) => {
          cancelStopSearch();
          state.stopQuery = event.target.value;
          state.stopSuggesting = !!state.stopQuery.trim();
          getFix();
          renderSheet();
        },
        onfocus: () => sheet.snap('full'),
        onkeydown: (event) => { if (event.key === 'Enter') { event.target.blur(); searchStops(); } },
      }),
      h('button', { class: 'icon-button on', 'aria-label': t('查看我附近的站點', 'Show stops around me'), onclick: () => searchStops(true) }, icon('locate', 20))),
    historyBar('stops', (text) => {
      state.stopQuery = text;
      $('stop-input').value = text;
      searchStops();
    }));
}

function stopFilters() {
  return [
    segments([['all', t('全部', 'All')], ['bus', t('巴士', 'Bus')], ['minibus', t('小巴', 'Minibus')], ['mtr', t('港鐵', 'MTR')], ['lightRail', t('輕鐵', 'LRT')]], state.stopMode, (mode) => {
      state.stopMode = mode;
      if (!visibleStops().some((stop) => stop.site.id === state.stopOpen)) selectNearbyStop(null);
      renderSheet();
      drawMap();
    }),
    segments([[300, '300 m'], [500, '500 m'], [1000, '1 km']], state.stopRadius, (radius) => {
      state.stopRadius = radius;
      state.stops = state.stopPlace ? stopsNear(siteIndex(), state.stopPlace.location, radius) : [];
      if (!visibleStops().some((stop) => stop.site.id === state.stopOpen)) selectNearbyStop(null);
      renderSheet();
      drawMap();
    }),
  ];
}

const visibleStops = () => state.stops.filter((stop) => siteHasMode(stop.site, state.stopMode));
let stopListView = null;

function selectNearbyStop(id) {
  if (id === state.stopOpen) return;
  state.stopOpen = id;
  state.stopVisit = null;
  clearMapStop();
}

function stopCard(stop, isNearest) {
  const isOpen = state.stopOpen === stop.site.id;
  const numbers = [...new Set(stop.site.visits.map((v) => lineName(v.op, state.db.routes[v.routeKey].route, state.lang)))];
  return h('div', { class: `card${isOpen ? ' open' : ''}`, id: `stop-${stop.site.id}` },
    h('button', { class: 'tap', 'aria-expanded': String(isOpen), onclick: () => {
      selectNearbyStop(isOpen ? null : stop.site.id);
      renderSheet();
      $(`stop-${stop.site.id}`)?.querySelector('button')?.focus({ preventScroll: true });
    } },
      h('div', { class: 'row' }, h('span', { class: 'bold grow' }, nameText(stop.site.name, state.lang)),
        h('span', { class: `small ${isNearest ? 'live bold' : 'muted'}` }, distanceText(stop.distance)), h('span', { class: 'muted' }, icon(isOpen ? 'up' : 'down', 16))),
      h('div', { class: 'tiny muted ellipsis' }, numbers.slice(0, 8).join(' · ') + (numbers.length > 8 ? ` +${numbers.length - 8}` : ''))),
    isOpen && [
      h('div', { class: 'tiny muted' }, t('點選路線查看最近兩班', 'Tap a route to see its next two arrivals')),
      stop.site.visits.filter(MODES[state.stopMode]).map(visitRow),
      h('button', { class: 'link visit-route', onclick: () => planTo(stop.site) }, icon('route', 16), t('規劃路線到這裡', 'Plan a trip here')),
    ]);
}

function stopsSheet() {
  if (state.stopSuggesting) return stopSuggestions();
  if (!state.db) return h('div', { class: 'status' }, h('span', { class: 'spinner' }), t('正在載入站點資料…', 'Loading stops…'));
  if (state.focus) {
    return routeDetail(state.db.routes[state.focus.routeKey], state.focus.op, () => {
      state.focus = null;
      renderSheet();
      leaveFocus();
      if (stopListView) {
        sheet.snap(stopListView.size);
        $('sheet').scrollTop = stopListView.scroll;
      }
    });
  }
  const stops = visibleStops();
  return [
    state.stopBusy && h('div', { class: 'status' }, h('span', { class: 'spinner' }), t('搜尋中…', 'Searching…')),
    state.stopError && h('div', { class: 'notice' }, state.stopError),
    state.stopPlace && !state.stopBusy && [h('div', { class: 'title' }, t(`${state.stopPlace.name}附近 ${stops.length} 個站點`, `${stops.length} stops around ${state.stopPlace.name}`)), stopFilters()],
    !state.stopPlace && !state.stopBusy && !state.stopError && [h('div', { class: 'title' }, t('附近有咩車？', "What's around here?")),
      h('div', { class: 'small muted' }, t('輸入站名或地點，查看附近所有巴士、小巴、港鐵及輕鐵站，以及到站時間。', 'Search a stop or place to see every stop around it, with arrivals.'))],
    state.stopPlace && !stops.length && !state.stopBusy && h('div', { class: 'small muted' }, t('此範圍內沒有這類站點，可擴大範圍或改選「全部」。', 'No stops of this kind here. Try a larger radius or All.')),
    stops.map((stop, index) => stopCard(stop, index === 0)),
  ];
}

// MARK: Routes tab

function renderRoutesTop() {
  clear($('top'), viewHeader(t('路線', 'Routes')),
    h('label', { class: 'search-card single' }, h('span', { class: 'muted' }, icon('search', 19)), h('input', {
      id: 'route-input', value: state.routeQuery, placeholder: t('搜尋路線，例如 1A、960、505', 'Search routes, e.g. 1A, 960, 505'), enterkeyhint: 'search', autocomplete: 'off',
      inputmode: state.routeKeyboard ? 'text' : 'none',
      onfocus: () => { if (state.routeKey) leaveRoute(); },
      oninput: (event) => {
        state.routeQuery = event.target.value;
        state.routeKey = null;
        renderSheet();
        if (state.focus) leaveFocus();
      },
      onkeydown: (event) => { if (event.key === 'Enter') event.target.blur(); },
    }),
    h('button', {
      class: `icon-button${state.routeKeyboard ? ' on' : ''}`, 'aria-label': t('用系統鍵盤輸入', 'Type with the system keyboard'), 'aria-pressed': String(state.routeKeyboard),
      onclick: (event) => {
        event.preventDefault();
        state.routeKeyboard = !state.routeKeyboard;
        renderRoutesTop();
        renderRoutePad();
        if (state.routeKeyboard) $('route-input').focus();
      },
    }, icon('keyboard', 20))));
}

/** Back from a route's stops to the search, with room for the keypad. */
function leaveRoute() {
  state.routeKey = null;
  state.focus = null;
  renderSheet();
  leaveFocus();
  sheet.snap('full');
}

function typeRoute(text) {
  state.routeQuery = text;
  $('route-input').value = text;
  $('sheet').scrollTop = 0;
  renderSheet();
}

const LETTERS_SHOWN = 8;

/** Only keys that lead to a real route work: most routes are three or four presses away. */
function renderRoutePad() {
  if (state.tab !== 'routes') return;
  if (!state.db || state.routeKey || state.focus || state.routeKeyboard) return clear($('bottom'));
  const query = state.routeQuery, next = nextRouteKeys(state.db, query), keepFocus = (event) => event.preventDefault();
  const key = (text, kind = '') => h('button', { class: `key ${kind}`, disabled: !next.has(text), onmousedown: keepFocus, onclick: () => typeRoute(query + text) }, text);
  const letters = [...next].filter((text) => /[A-Z]/.test(text)).sort();
  const action = (label, symbol, press) => h('button', { class: 'key action', 'aria-label': label, disabled: !query, onmousedown: keepFocus, onclick: press }, symbol);
  clear($('bottom'), h('div', { class: 'route-pad' },
    h('div', { class: 'digits' }, [...'123456789'].map((digit) => key(digit)),
      action(t('清除', 'Clear'), icon('close', 20), () => typeRoute('')),
      key('0'),
      action(t('刪除', 'Delete'), icon('backspace', 22), () => typeRoute(query.slice(0, -1)))),
    h('div', { class: `letters no-drag${letters.length > LETTERS_SHOWN ? ' more' : ''}` }, letters.map((letter) => key(letter, 'letter')))));
}

const MOST_RECENT_ROUTES = 12;

function keepRecentRoutes(keys) {
  state.recentRoutes = keys.slice(0, MOST_RECENT_ROUTES);
  store.set('recentRoutes', state.recentRoutes);
}

/** A route is kept once, in the direction last looked at. */
function rememberRoute(route) {
  const { routes } = routeFamily(state.db, route);
  keepRecentRoutes([route.key, ...state.recentRoutes.filter((key) => !routes.some((other) => other.key === key))]);
}

function routeCard(main) {
  const { opposite } = routeWays(state.db, main), { routes } = routeFamily(state.db, main);
  const end = nameText(main.dest, state.lang);
  return h('button', {
    class: 'card tap', onclick: () => {
      const route = routes.find((other) => state.recentRoutes.includes(other.key)) ?? main;
      rememberRoute(route);
      state.routeKey = route.key;
      renderSheet();
      $('sheet').scrollTop = 0;
      focusRoute(route.key, route.operators[0]);
    },
  }, h('div', { class: 'row' }, badge(main.operators[0], main.route),
    h('div', { class: 'grow', style: 'min-width:0' }, h('div', { class: 'small bold ellipsis' }, opposite ? `${nameText(main.orig, state.lang)} ⇄ ${end}` : `→ ${end}`),
      h('div', { class: 'tiny muted ellipsis' }, main.operators.map((op) => OP_LABELS[op]).join(' · ')))));
}

function recentRoutes() {
  const routes = [...new Set(state.recentRoutes.flatMap((key) => (state.db.routes[key] ? routeFamily(state.db, state.db.routes[key]).main : [])))];
  if (!routes.length) return h('div', { class: 'small muted' }, t('輸入路線號碼，查看沿線站點及到站時間。按星號可收藏常用車站。', 'Type a route number to see its stops and arrivals. Press the star to save a stop.'));
  return [
    h('div', { class: 'section' }, h('span', {}, t('最近查看', 'Recent')),
      h('button', { class: 'link', onclick: () => { keepRecentRoutes([]); renderSheet(); } }, t('清除', 'Clear'))),
    routes.map((route) => h('div', { class: 'route-row' }, routeCard(route),
      h('button', {
        class: 'ai-close', 'aria-label': t('移除', 'Remove'),
        onclick: () => {
          const { routes: family } = routeFamily(state.db, route);
          keepRecentRoutes(state.recentRoutes.filter((key) => !family.some((other) => other.key === key)));
          renderSheet();
        },
      }, icon('close', 13)))),
  ];
}

function routesSheet() {
  renderRoutePad();
  if (!state.db) return h('div', { class: 'status' }, h('span', { class: 'spinner' }), t('正在載入路線資料…', 'Loading route data…'));
  if (state.routeKey) {
    const route = state.db.routes[state.routeKey];
    return routeDetail(route, state.focus?.op ?? route.operators[0], leaveRoute);
  }
  if (!state.routeQuery.trim()) return recentRoutes();
  const routes = searchRoutes(state.db, state.routeQuery);
  if (!routes.length) return h('div', { class: 'small muted' }, t('找不到這條路線。', 'No such route.'));
  return routes.map(routeCard);
}

function stopRow(route, seq, id, op, dot) {
  return swipeable(h('div', { class: `card stop-row${state.focus?.position === seq ? ' chosen' : ''}` },
    h('div', { class: 'row' },
      h('button', { class: 'tap grow small', onclick: () => chooseFocusStop(seq) }, dot, `${seq + 1}. ${name(id)}`),
      starButton(route.key, seq, op))), (side) => addStopToTrip(id, side));
}

const SWIPE_STARTS = 10, SWIPE_OPENS = 44, SWIPE_OPEN_AT = 124;
let closeOpenSwipe = null;

/** A card dragged sideways uncovers a button: swiping right 'start', swiping left 'end'. Only a tap on it counts. */
function swipeable(card, chosen) {
  let startX = 0, startY = 0, opened = 0, moved = 0, isDown = false, isSwiping = false, swallowClick = false;
  const moveTo = (offset) => {
    opened = offset;
    card.style.transform = offset ? `translateX(${offset}px)` : '';
    row.classList.toggle('open', !!offset);
  };
  const close = () => {
    moveTo(0);
    if (closeOpenSwipe === close) closeOpenSwipe = null;
  };
  const action = (side, text) => h('button', {
    class: `swipe-action ${side}`,
    onclick: () => {
      close();
      chosen(side);
    },
  }, text);
  const row = h('div', { class: 'swipe' }, action('start', t('設為出發地', 'Start here')), action('end', t('設為目的地', 'Go here')), card);
  card.addEventListener('pointerdown', (event) => {
    if (closeOpenSwipe && closeOpenSwipe !== close) closeOpenSwipe();
    if (event.button !== 0) return;
    [startX, startY, moved, isDown, swallowClick] = [event.clientX, event.clientY, opened, true, false];
  });
  card.addEventListener('pointermove', (event) => {
    if (!isDown) return;
    const across = event.clientX - startX, along = event.clientY - startY;
    if (!isSwiping) {
      if (Math.max(Math.abs(across), Math.abs(along)) <= SWIPE_STARTS) return;
      if (Math.abs(along) > Math.abs(across)) {
        isDown = false;
        return;
      }
      isSwiping = true;
      card.setPointerCapture(event.pointerId);
      row.classList.add('swiping');
    }
    moved = Math.max(-SWIPE_OPEN_AT * 1.2, Math.min(SWIPE_OPEN_AT * 1.2, opened + across));
    card.style.transform = `translateX(${moved}px)`;
    if (moved) row.dataset.side = moved > 0 ? 'start' : 'end';
  });
  const release = () => {
    const wasSwiping = isSwiping;
    isDown = isSwiping = false;
    row.classList.remove('swiping');
    return wasSwiping;
  };
  card.addEventListener('pointerup', () => {
    if (!release()) {
      // A tap on a card that is open only shuts it.
      swallowClick = !!opened;
      if (opened) close();
      return;
    }
    swallowClick = true;
    if (Math.abs(moved) < SWIPE_OPENS) return close();
    moveTo(Math.sign(moved) * SWIPE_OPEN_AT);
    closeOpenSwipe = close;
  });
  card.addEventListener('pointercancel', () => {
    release();
    moveTo(opened);
  });
  card.addEventListener('click', (event) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.stopPropagation();
    event.preventDefault();
  }, true);
  return row;
}

function showToast(text) {
  document.querySelector('.toast')?.remove();
  const toast = h('div', { class: 'toast', role: 'status' }, text);
  $('app').append(toast);
  setTimeout(() => toast.remove(), 2600);
}

/** A stop goes into its box on the route page. The trip plans as soon as it has a destination. */
function addStopToTrip(id, side) {
  const stop = name(id);
  pickedPlaces.set(stop, { name: stop, location: state.db.stops[id].location });
  state[side === 'start' ? 'origin' : 'destination'] = stop;
  state.routeView = true;
  setTab('plan');
  syncPlaceInputs();
  if (state.destination.trim()) return search();
  return $('destination-input')?.focus();
}

// MARK: Saved tab

function savedSheet() {
  if (!state.db) return h('div', { class: 'status' }, h('span', { class: 'spinner' }), t('正在載入…', 'Loading…'));
  if (!state.saved.length) return h('div', { class: 'small muted' }, t('還沒有收藏。在「路線」或「站點」按星號，常用車站就會出現在這裡。', 'Nothing saved yet. Press the star on the Routes or Stops page.'));
  return state.saved.flatMap((saved) => {
    const route = state.db.routes[saved.routeKey];
    if (!route) return [];
    const id = route.stops[saved.op]?.[saved.seq];
    return [h('div', { class: 'card' },
      h('div', { class: 'row' }, badge(saved.op, route.route),
        h('div', { class: 'grow' }, h('div', { class: 'small bold ellipsis' }, `→ ${nameText(route.dest, state.lang)}`), h('div', { class: 'tiny muted ellipsis' }, name(id))),
        h('button', { class: 'icon-button on', 'aria-label': t('移除', 'Remove'), onclick: () => { toggleSaved(saved.routeKey, saved.seq, saved.op); renderSheet(); } }, icon('star', 20, true))),
      etaWidget(route, saved.seq, saved.op))];
  });
}

// MARK: Settings tab

const settingGroup = (title, ...rows) => h('section', { class: 'settings' }, h('h2', {}, title), h('div', { class: 'card' }, rows));
const setting = (label, control) => h('div', { class: 'setting' }, h('span', {}, label), control);
const aboutItem = (title, ...body) => h('details', { class: 'about' }, h('summary', {}, title), h('div', { class: 'small muted' }, body));

function fareProfilePicker() {
  const group = h('div', { class: 'fare-profiles', role: 'group', 'aria-label': t('票價類別', 'Fare profile') });
  for (const [profile, labels] of Object.entries(FARE_PROFILES)) {
    group.append(h('button', {
      'aria-pressed': String(profile === state.fareProfile),
      onclick: (event) => {
        if (profile === state.fareProfile) return;
        state.fareProfile = profile;
        store.set('fareProfile', profile);
        group.querySelector('[aria-pressed="true"]').setAttribute('aria-pressed', 'false');
        event.currentTarget.setAttribute('aria-pressed', 'true');
        if (state.candidates.some(usesRail)) loadRailFares();
      },
    }, t(...labels)));
  }
  return group;
}

/** A button that asks once more before it clears anything. */
function clearButton(label, count, clearAll) {
  const button = h('button', { class: 'danger', disabled: !count }, label);
  let asked = false;
  button.addEventListener('click', () => {
    if (!asked) {
      asked = true;
      button.textContent = t('再按一次確認', 'Tap again to confirm');
      setTimeout(() => {
        asked = false;
        if (button.isConnected) button.textContent = label;
      }, 3000);
      return;
    }
    clearAll();
    renderTab();
  });
  return button;
}

function aiSettings() {
  const current = state.aiConfig;
  const pick = (id, options, value) => {
    const select = h('select', { id }, options.map(([value, label]) => h('option', { value }, label)));
    select.value = value;
    return select;
  };
  const field = (label, control) => h('label', { class: 'setting ai-api-field' }, label, control);
  const text = (id, props = {}) => h('input', {
    id, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', ...props,
  });

  const provider = pick('ai-provider', Object.entries(AI_PROVIDERS).map(([id, preset]) =>
    [id, preset.name ?? t('自訂平台', 'Custom provider')]), current?.provider ?? 'openai');
  const model = text('ai-model', { required: true, maxlength: 160, value: current?.model ?? AI_PROVIDERS[provider.value].model });
  const protocol = pick('ai-protocol', [['chat', 'OpenAI Chat Completions'], ['responses', 'OpenAI Responses'],
    ['messages', 'Anthropic Messages']], current?.protocol ?? 'chat');
  const base = text('ai-base-url', { type: 'url', maxlength: 500, value: current?.baseUrl, placeholder: 'https://api.example.com/v1' });
  const custom = h('div', { class: 'ai-api-custom' },
    field(t('接口格式', 'API format'), protocol), field(t('API 基礎地址', 'API base URL'), base),
    h('div', { class: 'tiny muted' }, t('使用公開 HTTPS 地址。驗證會傳送一個簡短請求，平台可能收費。', 'Use a public HTTPS endpoint. Verification sends a short request that may incur a charge.')));
  const key = text('ai-api-key', { type: 'password', maxlength: 2048 });
  const currency = pick('ai-currency', ['USD', 'CNY', 'HKD'].map((code) => [code, code]), current?.rates?.[0] ?? 'USD');
  const price = (id, value) => text(id, { type: 'number', min: 0, max: 1_000_000, step: 'any', inputmode: 'decimal', value });
  const input = price('ai-input-rate', current?.rates?.[1]);
  const output = price('ai-output-rate', current?.rates?.[2]);
  const rates = h('details', { class: 'about' },
    h('summary', {}, t('模型費率（可選）', 'Model rates (optional)')),
    h('div', { class: 'ai-api-custom' }, field(t('貨幣', 'Currency'), currency),
      field(t('每百萬輸入 tokens', 'Per million input tokens'), input),
      field(t('每百萬輸出 tokens', 'Per million output tokens'), output),
      h('div', { class: 'tiny muted' }, t('平台未提供金額時，使用已知或填寫的模型費率估算。', 'When no charge is reported, estimates use known model rates or the rates entered here.'))));
  const canReuseKey = () => current && provider.value === current.provider && (provider.value !== 'custom'
    || (base.value.trim() === current.baseUrl && protocol.value === current.protocol));
  function refreshFields() {
    custom.hidden = provider.value !== 'custom';
    base.disabled = protocol.disabled = custom.hidden;
    base.required = !custom.hidden;
    key.required = !canReuseKey();
    key.placeholder = canReuseKey() ? t('已儲存，可輸入新 Key', 'Saved. Enter a new key to replace it') : t('輸入平台的 API Key', 'Enter your provider’s API key');
    const preset = AI_PROVIDERS[provider.value];
    const listedRates = preset.model === model.value.trim() ? preset.rates : null;
    input.placeholder = listedRates ? `${listedRates[0]} ${listedRates[1]}` : '';
    output.placeholder = listedRates ? `${listedRates[0]} ${listedRates[2]}` : '';
  }
  provider.addEventListener('change', () => {
    model.value = AI_PROVIDERS[provider.value].model ?? '';
    key.value = input.value = output.value = '';
    refreshFields();
  });
  protocol.addEventListener('change', refreshFields);
  [model, base].forEach((control) => control.addEventListener('input', refreshFields));
  refreshFields();

  const status = h('div', { class: 'tiny muted', role: 'status' }, state.aiKeyRejected && aiErrorMessage(401));
  const save = h('button', { class: 'link', type: 'submit' }, t('驗證並儲存', 'Verify and save'));
  const form = h('form', { class: 'setting', onsubmit: async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    const config = { provider: provider.value, model: model.value.trim(), key: key.value.trim() || (canReuseKey() ? current.key : '') };
    if (!config.key || !config.model) return;
    if (config.provider === 'custom') Object.assign(config, { baseUrl: base.value.trim().replace(/\/+$/, ''), protocol: protocol.value });
    if (input.value || output.value) {
      if (!Number.isFinite(input.valueAsNumber) || !Number.isFinite(output.valueAsNumber)) {
        rates.open = true;
        status.textContent = t('請同時填寫輸入及輸出費率。', 'Enter both the input and output rates.');
        return;
      }
      config.rates = [currency.value, input.valueAsNumber, output.valueAsNumber];
    }
    save.disabled = true;
    status.textContent = t('正在驗證 API 設定…', 'Verifying API settings…');
    try {
      await verifyAIKey(config, recordAICost);
      if (!form.isConnected) return;
      key.value = '';
      status.textContent = t('已儲存。', 'Saved.');
      setAIConfig(config);
    } catch (error) {
      status.textContent = aiErrorMessage(error.status);
    } finally {
      save.disabled = false;
    }
  } }, field(t('平台', 'Provider'), provider), field(t('模型', 'Model'), model), custom,
  field('API Key', key), rates, h('div', {}, save), status);
  const active = current && (AI_PROVIDERS[current.provider]?.name ?? t('自訂平台', 'Custom provider'));
  return settingGroup('AI API',
    h('div', { class: 'setting inline' }, h('span', {}, t('狀態', 'Status')),
      h('span', { class: current ? 'ok' : 'muted' }, current ? active : t('未啟用', 'Disabled'))),
    form,
    current && h('button', { class: 'link', onclick: () => setAIConfig(null) }, t('移除 API Key', 'Remove API key')),
    h('div', { class: 'setting inline ai-cost-row' }, h('span', {}, t('今日 AI 費用', 'Today’s AI cost')),
      h('strong', { id: 'ai-cost' }, aiCostText())),
    h('div', { class: 'tiny muted' }, t('按香港時間統計此瀏覽器在本站的用量，金額可能為估算。', 'Totals cover this browser’s usage on this site by Hong Kong date. Amounts may be estimates.')),
    h('div', { class: 'tiny muted' }, t('API Key 儲存在此瀏覽器，使用時經本站轉送至你選擇的平台。', 'Your browser stores the API key, and this site forwards it to your chosen provider when needed.')));
}

function settingsSheet() {
  const searches = Object.values(store.get('history', {})).flat().length + state.recentRoutes.length;
  const simplified = state.script === 'hans';
  return [
    settingGroup(t('一般', 'General'),
      setting(t('語言', 'Language'), segments([['hant', '繁體中文'], ['hans', '简体中文'], ['en', 'English']], state.lang === 'en' ? 'en' : state.script, (choice) => {
        state.lang = choice === 'en' ? 'en' : 'zh';
        if (choice !== 'en') state.script = choice;
        store.set('lang', state.lang);
        store.set('script', state.script);
        applyScript();
        mapView.setLanguage();
        renderTab();
      })),
      Recognition && setting(t('語音輸入', 'Voice input'), segments(Object.entries(speechLabels()), state.speechLang, (language) => {
        state.speechLang = language;
        store.set('speechLang', language);
        renderTab();
      })),
      setting(t('預設路線', 'Default route'), segments([['fastest', t('最快', 'Fastest')], ['fewerTransfers', t('少轉車', 'Fewer changes')], ['lessWalking', t('少行路', 'Less walking')]], state.preference, (preference) => {
        state.preference = preference;
        store.set('preference', preference);
        renderTab();
      }))),
    settingGroup(t('校巴', 'Campus shuttles'),
      setting(t('教大校巴', 'EdUHK shuttles'), segments([[false, t('關閉', 'Off')], [true, t('開啟', 'On')]], state.eduhkShuttle, (enabled) => {
        if (enabled === state.eduhkShuttle) return;
        state.eduhkShuttle = enabled;
        store.set('eduhkShuttle', enabled);
        replanEdUHK = Boolean(state.from && state.to && !state.planDirty && !state.nav);
        if (!enabled && state.candidates.some(includesEdUHK)) showTripOptions(state.candidates.filter((journey) => !includesEdUHK(journey)), true);
        renderSheet();
      })),
      h('div', { class: 'tiny muted' }, t('包括大圍站往返大埔校園，以及大學站往大埔校園的回校班次。只限教大學生及教職員，按校方班表估算。', 'Includes Tai Wai–Tai Po Campus in both directions and University Station to Tai Po Campus. For EdUHK students and staff only. Times are based on the published timetable.')),
      h('a', { class: 'link', href: EDUHK_TRANSPORT, target: '_blank', rel: 'noopener' }, t('教大交通及最新安排', 'EdUHK transport and service updates'))),
    settingGroup(t('票價', 'Fares'),
      fareProfilePicker(),
      h('div', { class: 'tiny muted' },
        t('按所選的八達通票價類別估算。個別路線、轉乘及限時優惠以營辦商公布為準。', 'Estimates use the selected Octopus fare profile. Check operators for route-specific, interchange and limited-time offers.')),
      h('div', { class: 'row' },
        h('a', { class: 'link', href: 'https://www.mtr.com.hk/en/customer/tickets/octopus_fares.html', target: '_blank', rel: 'noopener' }, t('港鐵票價', 'MTR fares')),
        h('a', { class: 'link', href: 'https://www.td.gov.hk/tc/gov_public_transport_fare_concession/index.html', target: '_blank', rel: 'noopener' }, t('兩蚊兩折', 'Government fare scheme')))),
    aiSettings(),
    settingGroup(t('我的資料', 'My data'),
      h('div', { class: 'setting inline' }, h('span', {}, t(`搜尋記錄（${searches}）`, `Search history (${searches})`)),
        clearButton(t('清除', 'Clear'), searches, () => {
          store.set('history', {});
          keepRecentRoutes([]);
        })),
      h('div', { class: 'setting inline' }, h('span', {}, t(`收藏（${state.saved.length}）`, `Saved (${state.saved.length})`)),
        clearButton(t('清除', 'Clear'), state.saved.length, () => {
          state.saved = [];
          store.set('saved', []);
        })),
      h('div', { class: 'tiny muted' }, t('這些資料只保存在這部裝置。', 'These stay on this device.'))),
    settingGroup(t('關於', 'About'),
      aboutItem(t('關於作者', 'About the author'),
        h('p', {}, t(
          simplified
            ? '你好，我是 Kevin，hktransport 的作者。我做这个工具，是希望大家在香港乘坐公共交通时，能更快查到下一班车什么时候到，也能一眼看清整段路线。'
            : '你好，我係 Kevin，hktransport 係我整嘅。我想喺香港搭車嗰陣，可以快啲睇到下班車幾時到，又可以一眼睇清楚成程點行，所以就整咗呢個工具。',
          'Hi, I’m Kevin, the creator of hktransport. I built it so I could quickly see when the next ride is due and how the whole trip fits together when getting around Hong Kong.')),
        h('p', {}, t(
          simplified
            ? '感谢你使用 hktransport！也谢谢每一位愿意花时间告诉我哪些地方好用、哪些地方还能改进的朋友。希望这个工具能让你出行时少一点猜测，少一点等待。'
            : '多謝你用 hktransport！亦都多謝每一位肯花時間同我講邊度好用、邊度仲可以改嘅朋友。希望呢個工具可以幫你搭車嗰陣少啲估、少啲等。',
          'Thanks for using hktransport! And thanks to everyone who has taken the time to tell me what works well and what I could improve. I hope it makes your trips a little easier, with less guesswork and less waiting.')),
        'Kevin · ',
        h('a', { class: 'link', href: 'https://github.com/kevinwentao07-zwt', target: '_blank', rel: 'noopener' }, 'GitHub @kevinwentao07-zwt')),
      aboutItem(t('安裝到手機', 'Install on your phone'), t('iPhone：在 Safari 按分享，再選「加入主畫面」。Android：在 Chrome 選單按「安裝應用程式」。', 'iPhone: in Safari, tap Share, then Add to Home Screen. Android: in the Chrome menu, tap Install app.')),
      aboutItem(t('私隱', 'Privacy'), t(
        '此網站不收集個人資料。收藏及搜尋記錄只保存在你的瀏覽器。到站查詢直接連到各營辦商。使用「附近」找地點時，你的座標會經本站伺服器傳送給 Google，或在額度用完時傳送給 OpenStreetMap 的 Photon 服務，用來搜尋你身邊 5 公里內的地點。AI 請求由本站伺服器轉送至你設定的 AI 平台，店舖搜尋會轉送至 Google。本站伺服器不會保存 API Key 或請求內容。規劃公共交通路線時，起終點座標及所選時間會經本站伺服器傳送給 Transitous 或 Google。Google 亦會收到步行路段兩端的座標。Google 地圖會由你的瀏覽器直接載入，並受 Google 私隱政策約束。',
        'This site collects no personal data. Saved stops and history stay in your browser. Arrivals come straight from the operators. When finding places nearby, your coordinates go through this site\'s server to Google, or to OpenStreetMap\'s Photon service once the allowance is used up, to search within 5 km of you. This site forwards AI requests to the provider you configure and shop searches to Google. The server does not store your AI key or request content. For public transport directions, the start and end coordinates and selected time go through this site\'s server to Transitous or Google. Google also receives the two ends of walking segments. Google Maps loads straight into your browser under Google\'s privacy policy.')),
      aboutItem(t('資料來源', 'Data sources'), t('路線資料來自 hkbus.app；到站時間來自各營辦商；公共交通路線由 Transitous、Google 地圖或內置演算法規劃；地圖、地點、步行路線及店舖來自 Google，額度用完後改用 OpenFreeMap、OpenStreetMap 及政府地理資訊。', 'Route data from hkbus.app; arrivals from the operators; public transport routes from Transitous, Google Maps or the built-in planner; maps, places, walking routes and shops from Google, and after the allowance, OpenFreeMap, OpenStreetMap and Government GIS.')),
      aboutItem(t('探索目的地附近', 'Explore nearby'), t('開啟探索後，目的地座標會用於 Google 地圖或 OpenStreetMap 的 Photon 地點搜尋，目的地名稱會用於維基導遊或 Brave Search 的網頁搜尋。點選 AI 建議時，本站使用網頁搜尋結果及你選擇的模型整理建議。', 'Opening Explore uses the destination coordinates to find places through Google Maps or OpenStreetMap Photon. It uses the destination name to search Wikivoyage or Brave Search for web sources. AI suggestions combine web search results with the model you select.')),
      h('a', { class: 'small link', href: 'https://data.gov.hk/en-data/dataset/mtr-data-routes-fares-barrier-free-facilities', target: '_blank', rel: 'noopener' },
        t('八達通鐵路車費 © 港鐵公司（資料來自 DATA.GOV.HK）', 'Octopus rail fares © MTR Corporation Limited via DATA.GOV.HK')),
      h('a', { class: 'small link', href: 'https://www.google.com/help/terms_maps/', target: '_blank', rel: 'noopener' }, t('Google 地圖使用條款', 'Google Maps Terms of Service')),
      h('a', { class: 'small link', href: 'https://policies.google.com/privacy', target: '_blank', rel: 'noopener' }, t('Google 私隱政策', 'Google Privacy Policy')),
      h('a', { class: 'small link', href: 'https://github.com/kevinwentao07-zwt/hktransport', target: '_blank', rel: 'noopener' }, t('GitHub 原始碼（GPL-3.0）', 'Source on GitHub (GPL-3.0)'))),
  ];
}

// MARK: Bottom sheet

function clearMapStop() {
  $('map-stop-preview')?.remove();
}

function showMapStop(stopName, reveal = () => { $('sheet').scrollTop = 0; }) {
  clearMapStop();
  $('app').append(h('div', { id: 'map-stop-preview', class: 'row map-stop-preview' },
    h('span', { class: 'small bold grow', role: 'status' }, stopName),
    h('button', { class: 'link', onclick: () => {
      mapTouched = true;
      sheet.snap('half');
      sheet.setMapOnly(false);
      requestAnimationFrame(reveal);
    } }, t('查看到站', 'View arrivals')),
    h('button', { class: 'round', 'aria-label': t('關閉', 'Close'), onclick: clearMapStop }, icon('close', 15))));
}

const PANEL_SIZES = ['map', 'peek', 'half', 'full'];
let mapGestureHintSeen = store.get('mapGestureHintSeen', false);

function rememberMapGesture() {
  if (mapGestureHintSeen) return;
  mapGestureHintSeen = true;
  store.set('mapGestureHintSeen', true);
}

function showMapGestureHint() {
  if (state.tab !== 'plan' || !state.journeys.length || state.planDirty || state.nav || state.explore || sheet.mapOnly || wideLayout.matches) {
    return $('map-gesture-hint')?.remove();
  }
  if (sheet.current === 'full' || mapGestureHintSeen) return;
  const hint = h('div', { id: 'map-gesture-hint', role: 'status' }, icon('down', 15), t('向下拉可查看全圖', 'Pull down to see the full map'));
  $('app').append(hint);
  rememberMapGesture();
  setTimeout(() => hint.remove(), 6500);
}

/** Keep the last menu size while the panel is hidden. */
const sheet = {
  current: 'half',
  mapOnly: false,
  heights() {
    const app = $('app').clientHeight;
    const peek = $('grabber').offsetHeight + $('top').offsetHeight + $('bottom').offsetHeight + 6;
    const full = app - 54;
    return { map: 0, peek: Math.min(peek, full), half: Math.max(peek, Math.min(full, Math.round(app * 0.52))), full };
  },
  measure() {
    if ($('panel').classList.contains('dragging')) return;
    this.apply(this.targetHeight());
  },
  apply(height) {
    $('app').style.setProperty('--panel-h', `${height}px`);
  },
  /** Where the sheet is heading, which the map must clear even mid-animation. */
  targetHeight() {
    return this.mapOnly ? 0 : this.heights()[this.current];
  },
  snap(name) {
    this.current = name;
    this.measure();
    this.updateControls();
    showMapGestureHint();
  },
  updateControls() {
    const size = this.mapOnly ? 'map' : this.current;
    $('app').classList.toggle('sheet-full', size === 'full');
    $('grabber').setAttribute('aria-valuenow', PANEL_SIZES.indexOf(size));
    $('grabber').setAttribute('aria-valuetext', {
      map: t('只看地圖', 'Map only'), peek: t('部分展開', 'Compact'), half: t('半開', 'Half open'), full: t('完全展開', 'Fully open'),
    }[size]);
  },
  setMapOnly(on) {
    this.mapOnly = on;
    if (on && !wideLayout.matches) rememberMapGesture();
    $('map-gesture-hint')?.remove();
    const panel = $('panel'), open = $('open-panel');
    if (on && panel.contains(document.activeElement)) document.activeElement.blur();
    $('app').classList.toggle('sheet-hidden', on);
    panel.inert = on;
    open.hidden = !on;
    this.measure();
    this.updateControls();
    if (!on) clearMapStop();
    watchVisibleStopArrivals();
    (on ? open : wideLayout.matches ? $('hide-panel') : $('grabber')).focus({ preventScroll: true });

    if (showsEmbed()) return showEmbed();
    if (!on && (mapTouched || (!wideLayout.matches && this.current === 'full'))) return;
    const preview = state.explore?.preview?.target;
    if (state.tab === 'plan' && showingNavigation()) {
      if (state.nav.here && state.nav.following) mapView.follow(state.nav.here);
    } else if (preview) mapView.follow(preview.location, 17, true, exploreMapOffset());
    else if (state.tab === 'plan' && (state.from || state.to)) fitPlanMap();
    else if (state.focus) fitWholeRoute();
    else if (state.tab === 'stops' && state.stopPlace) fitStopArea();
  },
  attach() {
    const grabber = $('grabber'), panel = $('panel'), list = $('sheet');
    const chooseSize = (size) => size === 'map' ? this.setMapOnly(true) : this.snap(size);
    $('hide-panel').addEventListener('click', () => this.setMapOnly(true));
    $('open-panel').addEventListener('click', () => this.setMapOnly(false));
    let startX = 0, startY = 0, startHeight = 0, lastY = 0, lastTime = 0, speed = 0;
    let tracking = false, dragging = false, fromGrabber = false, swallowClick = false;
    // The sheet resizes from its body, but only the grabber can hide it entirely.
    panel.addEventListener('pointerdown', (event) => {
      swallowClick = false;
      if (!event.isPrimary || event.button !== 0 || !grabber.offsetParent || event.target.closest?.('.no-drag')) return;
      if ((this.current === 'full' || state.explore || (state.tab === 'stops' && state.stopOpen && !state.focus)) && list.contains(event.target)) return;
      fromGrabber = grabber.contains(event.target);
      if (!fromGrabber && event.target === document.activeElement) return;
      startX = event.clientX;
      startY = lastY = event.clientY;
      lastTime = event.timeStamp;
      startHeight = panel.offsetHeight;
      speed = 0;
      tracking = true;
      dragging = false;
    });
    panel.addEventListener('pointermove', (event) => {
      if (!event.isPrimary || !tracking) return;
      if (!dragging) {
        const across = Math.abs(event.clientX - startX), along = Math.abs(event.clientY - startY);
        if (Math.max(across, along) <= 6) return;
        if (across > along) { // A sideways swipe belongs to whatever is under the finger.
          tracking = false;
          return;
        }
        dragging = true;
        panel.setPointerCapture(event.pointerId);
        panel.classList.add('dragging');
      }
      const elapsed = event.timeStamp - lastTime;
      if (elapsed > 0) speed = (lastY - event.clientY) / elapsed; // Pixels per ms; up is positive.
      lastY = event.clientY;
      lastTime = event.timeStamp;
      const { peek, full } = this.heights(), wanted = startHeight + startY - event.clientY;
      const minimum = fromGrabber ? 0 : peek;
      // Past either end the sheet resists like a rubber band.
      const height = wanted > full ? full + (wanted - full) * 0.18 : Math.max(minimum, wanted);
      this.apply(height);
    });
    const finish = (event) => {
      if (!event.isPrimary || !tracking) return;
      tracking = false;
      if (!dragging) {
        if (fromGrabber && event.type === 'pointerup') {
          // A tap keeps cycling through the open sizes.
          const index = PANEL_SIZES.indexOf(this.current);
          this.snap(PANEL_SIZES[index + 1] ?? 'peek');
        }
        return;
      }
      const heights = this.heights(), height = panel.offsetHeight;
      panel.classList.remove('dragging');
      swallowClick = true;
      if (event.type === 'pointercancel') return this.snap(this.current);
      const order = fromGrabber ? PANEL_SIZES : PANEL_SIZES.slice(1), index = order.indexOf(this.current);
      const nearest = order.reduce((best, key) => (Math.abs(heights[key] - height) < Math.abs(heights[best] - height) ? key : best));
      const flick = Math.abs(speed) > 0.5 && event.timeStamp - lastTime < 100;
      const next = order[Math.max(0, Math.min(order.length - 1, index + Math.sign(speed)))];
      chooseSize(flick && (speed > 0 || nearest !== 'map') ? next : nearest);
    };
    panel.addEventListener('pointerup', finish);
    panel.addEventListener('pointercancel', finish);
    // Letting go of a drag over a button doesn't press it.
    panel.addEventListener('click', (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    grabber.addEventListener('keydown', (event) => {
      const index = PANEL_SIZES.indexOf(this.current);
      const size = { ArrowUp: PANEL_SIZES[Math.min(3, index + 1)], ArrowDown: PANEL_SIZES[index - 1], Home: 'map', End: 'full' }[event.key];
      if (!size) return;
      event.preventDefault();
      chooseSize(size);
    });
  },
};

// MARK: Rendering

function renderSheet() {
  const sheets = { plan: planSheet, stops: stopsSheet, routes: routesSheet, saved: savedSheet, settings: settingsSheet };
  clear($('sheet'), sheets[state.tab]());
  showMapGestureHint();
  watchVisibleStopArrivals();
  state.justOpened = null;
  document.querySelectorAll('.reveal .leg, .reveal > .primary').forEach((element, index) => element.style.setProperty('--i', index));
  if (staggerNext) {
    staggerNext = false;
    const element = $('sheet');
    [...element.children].forEach((child, index) => child.style.setProperty('--i', Math.min(index, 8)));
    element.classList.add('stagger');
    setTimeout(() => element.classList.remove('stagger'), 1100);
  }
  if (state.tab === 'plan') drawMap();
}

let drawnScene = '', entering = null;

/**
 * Lines and pins animate in only when the scene really changes, not on every redraw.
 * True only for the first drawing of a scene: redrawing a line mid-animation started it
 * again from nothing, which left the route blank while navigation kept redrawing.
 */
function markScene(scene) {
  if (scene === drawnScene) return false;
  drawnScene = scene;
  $('map').classList.add('entering');
  clearTimeout(entering);
  entering = setTimeout(() => $('map').classList.remove('entering'), 1800);
  return true;
}

function drawMap() {
  showEmbed();
  const animate = markScene(`${state.tab}|${state.onMap ?? ''}|${state.nav?.id ?? ''}|${state.to?.name ?? ''}|${state.discovery?.stage ?? ''}|${state.stopPlace?.name ?? ''}`);
  mapView.clear();
  const here = state.nav?.here ?? state.fix;
  if (here) mapView.me(here);
  if (state.tab !== 'plan' && state.focus) {
    const path = focusPath(), { position, op, routeKey } = state.focus;
    mapView.path(withRoads(path), (segment, index) => chooseFocusStop(segment.positions[index]), animate);
    loadRoads(path).then((arrived) => { if (arrived && state.focus) drawMap(); });
    showChosenStop();
    moveVehicles();
    return;
  }
  if (state.tab === 'stops') {
    if (state.stopPlace) {
      const stops = visibleStops(), center = state.stopPlace.location;
      if (!stops.some((stop) => meters(stop.site.location, center) < 8)) mapView.ends(null, state.stopPlace);
      mapView.stops(stops, center, state.stopRadius, (stop) => {
        selectNearbyStop(stop.site.id);
        renderSheet();
        const reveal = () => $(`stop-${stop.site.id}`)?.scrollIntoView({ block: 'start', behavior: calm.matches ? 'auto' : 'smooth' });
        if (sheet.mapOnly) showMapStop(nameText(stop.site.name, state.lang), reveal);
        else reveal();
      });
    }
    return;
  }
  if (state.tab !== 'plan') return moveVehicles();
  if (showingNavigation()) {
    // Navigation shows only what is still ahead, and the legs not reached yet light.
    mapView.path(pathAhead(state.nav.path, state.nav.progress, state.nav.here), chooseLineStop, animate);
  } else {
    const path = state.planDirty ? null : selectedPath();
    if (path) {
      mapView.path(withRoads(path), chooseLineStop, animate);
      loadRoads(path).then((arrived) => {
        if (!arrived) return;
        drawMap();
        // The real road can bulge past the stops the view was framed on.
        if (!mapTouched && !state.nav && state.tab === 'plan') fitPlanMap();
      });
    }
  }
  const choosing = !state.planDirty && state.discovery?.stage === 'choosing' && !state.journeys.length && state.phase === 'idle';
  if (choosing && !showsEmbed()) mapView.numbered(state.discovery.suggestions, choosePlace);
  if (!state.planDirty || showingNavigation()) mapView.ends(state.from, state.to);
  showChosenStop();
  moveVehicles();
}

function closeSheetForMap() {
  if (whenOpen) {
    showWhen(false);
    renderWhen();
  }
  sheet.snap('half');
}

// Once the rider moves the map it is theirs, until they choose something to look at.
let mapTouched = false;
let mapPointer = null;
function pauseNavigationFollow() {
  if (!showingNavigation() || !state.nav.following) return;
  state.nav.following = false;
  renderNavBanner();
}
$('map').addEventListener('pointerdown', (event) => {
  mapTouched = true;
  if (!event.isPrimary && event.pointerType === 'touch') pauseNavigationFollow();
  if (event.isPrimary) mapPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
}, { capture: true, passive: true });
$('map').addEventListener('pointermove', (event) => {
  if (mapPointer?.id !== event.pointerId || !event.buttons) return;
  if (Math.hypot(event.clientX - mapPointer.x, event.clientY - mapPointer.y) > 6) pauseNavigationFollow();
}, { capture: true, passive: true });
for (const event of ['pointerup', 'pointercancel']) {
  window.addEventListener(event, (pointer) => { if (mapPointer?.id === pointer.pointerId) mapPointer = null; }, { capture: true, passive: true });
}
$('map').addEventListener('wheel', () => { mapTouched = true; pauseNavigationFollow(); }, { capture: true, passive: true });
$('map').addEventListener('keydown', (event) => {
  if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', '+', '-', '='].includes(event.key)) {
    mapTouched = true;
    pauseNavigationFollow();
  }
}, true);

function fitPlanMap(includeNavigation = false) {
  if (state.tab !== 'plan' || state.explore?.preview || state.planDirty || (showingNavigation() && !includeNavigation)) return;
  mapTouched = false;
  const path = selectedPath();
  const points = path ? withRoads(path).segments.flatMap((s) => s.line ?? s.points) : [state.from?.location, state.to?.location].filter(Boolean);
  if (points.length) mapView.fit(points, 16, !!path);
}

function renderTab() {
  $('grabber').setAttribute('aria-label', t('調整選單高度', 'Resize menu'));
  $('hide-panel').textContent = t('收起選單', 'Hide menu');
  $('open-panel').textContent = t('打開選單', 'Open menu');
  sheet.updateControls();
  clear($('top'));
  clear($('bottom'));
  if (state.tab === 'plan') {
    renderPlanTop();
    renderPlanBottom();
  } else if (state.tab === 'stops') {
    renderStopsTop();
  } else if (state.tab === 'routes') {
    renderRoutesTop();
  } else if (state.tab === 'saved') {
    clear($('top'), viewHeader(t('收藏', 'Saved')));
  } else {
    clear($('top'), viewHeader(t('設定', 'Settings')));
  }
  renderSheet();
  sheet.measure();
  mapView.resize();
  drawMap();
  renderNavBanner();
}

function fitStopArea() {
  mapView.fit([offset(state.stopPlace.location, state.stopRadius, -1), offset(state.stopPlace.location, state.stopRadius, 1)], 18);
}

function setTab(tab) {
  if (state.tab === 'stops' && tab !== 'stops') cancelStopSearch();
  clearMapStop();
  if (tab !== 'plan') clearExplore();
  const direction = tab === 'plan' ? 'back' : 'forward', hadFocus = !!state.focus;
  state.tab = tab;
  state.focus = null;
  stagger();
  renderTab();
  slideView(direction);
  sheet.snap(tab === 'plan' || tab === 'stops' ? 'half' : 'full');
  $('sheet').scrollTop = 0;
  if (tab === 'stops' && state.stopPlace) fitStopArea();
  else if (hadFocus && tab !== 'plan') showHomeMap();
  if (tab === 'plan') {
    if (replanEdUHK) {
      replanEdUHK = false;
      if (state.from && state.to && !state.planDirty && !state.nav) return void runPlan({ kind: 'replan' });
    }
    if (showingNavigation() && state.nav.following && state.nav.here) mapView.follow(state.nav.here);
    else if (state.from || state.to) fitPlanMap();
    else showHomeMap();
  }
}

const SMALLEST_KEYBOARD = 120;

/**
 * A phone's keyboard covers the page without resizing it, so the sheet rises to stay above it.
 * Safari's own toolbars shrink the visible area too, so only a box being typed in counts.
 */
function clearKeyboard() {
  const view = window.visualViewport, app = $('app');
  const isTyping = document.activeElement?.matches('input') && view.scale <= 1.01;
  const covered = isTyping ? Math.round(app.clientHeight - view.height - view.offsetTop) : 0;
  const isOpen = covered >= SMALLEST_KEYBOARD;
  app.style.setProperty('--keyboard', isOpen ? `${covered}px` : '0px');
  if (isOpen) app.style.setProperty('--room', `${Math.round(view.height)}px`);
  else app.style.removeProperty('--room');
}
window.visualViewport?.addEventListener('resize', clearKeyboard);
window.visualViewport?.addEventListener('scroll', clearKeyboard);
document.addEventListener('focusout', () => setTimeout(clearKeyboard, 50));

new ResizeObserver(() => mapView.resize()).observe($('map'));
new ResizeObserver(() => sheet.measure()).observe($('top'));
new ResizeObserver(() => sheet.measure()).observe($('bottom'));
sheet.attach();
// Retire the older unverified key and model settings.
try { for (const old of ['hkt.apiKey', 'hkt.model']) localStorage.removeItem(old); } catch { /* Private mode. */ }

applyScript();
mapView.init();
renderTab();
mapView.home();
clear($('locate'), icon('arrow', 20));
$('locate').addEventListener('click', async () => {
  if (state.tab === 'plan' && state.nav) return resumeNavigation();
  const fix = await getFix(true);
  if (!fix) return;
  drawMap();
  mapView.follow(fix, 15);
});
locateOnOpen();
checkServer();
loadDB();
window.addEventListener('storage', (event) => {
  if (event.key === 'hkt.aiConfig' || event.key === null) setAIConfig(savedAIConfig());
  if (event.key === 'hkt.aiUsage' || event.key === null) {
    aiUsage = store.get('aiUsage', null);
    renderAICost();
  }
});
setInterval(() => {
  if (state.tab === 'saved') renderSheet();
  if (state.tab === 'settings') renderAICost();
}, 30_000);
if ('serviceWorker' in navigator) {
  // A page left open would otherwise keep running the old release, so a new one reloads it.
  const hadWorker = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadWorker) location.reload(); });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
