// The page itself: tabs, map, and the flows that tie the modules together.
import { meters,
  OP_COLORS, OP_LABELS, MODES, LIVE_AHEAD_MS, arrivalTime, arrivesLate, buildStopIndex, closestPosition, nextRouteKeys, planAdvice, routeFamily, routeWays, exactSite, instruction, journeyID, journeyPath, RETURN_COLOR, circularTurn, roadBetween, lineColor, lineName, matchingSites,
  nameText, normalizeDB, partialSite, placeOnTrack, primaryMode, progressAt, retime, rides, routeTrack, score, searchRoutes, siteHasMode, stopName, stopsNear, trackBetween, vehiclesOnRoute,
  totalMinutes, transfers, walkingMeters,
} from './transit.js?v=dev';
import { fetchETA, liveArrivalCache, routeArrivals } from './eta.js?v=dev';
import { toSimplified } from './hans.js?v=dev';
import { chatMessage, sharedAI, isCurrentLocation, normalizedOrigin, parseFollowUp, parseSearch, parseWish, searchMessage } from './ai.js?v=dev';
import { HONG_KONG, cleanArea, googlePlaceLocation, googleSearch, googleSuggest, googleWalk, inHongKong, insideArea, isNearby, knownShape, knownWalk, loadShape, lookupPlace, mergeShops, mergeSuggestions, photonSearch, withinArea } from './places.js?v=dev';

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
  lang: store.get('lang', 'zh'), script: store.get('script', 'hant'), tab: 'plan', db: null, dbError: null, index: null,
  origin: '', destination: '', when: null, chat: '', preference: store.get('preference', 'fastest'), phase: 'idle', error: null,
  from: null, to: null, journeys: [], onMap: null, expanded: null, explanation: null, aiNotice: null, lastChat: null,
  discovery: null,
  stopQuery: '', stopPlace: null, stops: [], stopMode: 'all', stopRadius: 500, stopBusy: false, stopError: null, stopOpen: null,
  routeQuery: '', routeKey: null, routeKeyboard: false, recentRoutes: store.get('recentRoutes', []), thread: null, lastSearch: null, saved: store.get('saved', []),
  talk: [], focus: null, routeView: false, nav: null, fix: null, speechLang: store.get('speechLang', 'zh-HK'), listening: false,
};
const t = (zh, en) => (state.lang === 'zh' ? zh : en);
const name = (id) => stopName(id, state.db, state.lang);
// Everything is written in Traditional, as stop names and replies are, so Simplified converts what
// lands on the page rather than each string on its way there.
const TEXT_ATTRIBUTES = ['placeholder', 'title', 'aria-label'];

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

const client = () => (state.sharedAI ? sharedAI() : null);
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
  let map, content, base, buses = new Map(), tag = null, chosen = null, approach = null, approachStops = [], approachKey = '', lastFit = '', flying = false;
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
      const wide = window.matchMedia('(min-width: 820px)').matches, margin = isSnug ? SNUG_MARGIN : 0;
      const options = {
        maxZoom, paddingTopLeft: [(wide ? 440 : 24) + margin, (wide ? 30 : 50) + margin / 2],
        paddingBottomRight: [(wide ? 30 : 24) + margin, wide ? 30 : sheet.targetHeight() + 32],
      };
      const bounds = L.latLngBounds(points.map(point));
      // Leaflet can't fly to where it already is: its path works out to NaN.
      const fit = `${bounds.toBBoxString()}|${options.paddingBottomRight}`, still = fit === lastFit;
      lastFit = fit;
      if (calm.matches || !flying || still) map.fitBounds(bounds, { ...options, animate: false });
      else map.flyToBounds(bounds, { ...options, duration: 0.9, easeLinearity: 0.2 });
      flying = true;
    },
    follow(location, zoom = 16, isExact = false) {
      // Centred in the part of the map the sheet leaves showing.
      const level = isExact ? zoom : Math.max(map.getZoom(), zoom);
      const target = map.unproject(map.project(point(location), level).add([0, sheet.targetHeight() / 2]), level);
      if (map.getCenter().distanceTo(target) > 1 || map.getZoom() !== level) map.flyTo(target, level, { duration: calm.matches ? 0 : 0.8 });
    },
    ends(from, to) {
      if (from) L.marker(point(from.location), { icon: pin('', 'pin start'), title: from.name }).addTo(content);
      if (to) L.marker(point(to.location), { icon: pin('', 'pin end', '#ff3b30'), title: to.name, zIndexOffset: 500 }).addTo(content);
    },
    path(path, choose) {
      // A few station names always fit; a long bus route's only fit up close.
      $('map').classList.toggle('many-stops', path.segments.reduce((sum, s) => sum + s.stopIDs.length, 0) > 12);
      for (const segment of path.segments) {
        const line = (segment.line ?? segment.points).map(point);
        L.polyline(line, { color: '#fff', weight: 8, opacity: 0.95 }).addTo(content);
        const isWalk = segment.mode === 'walk';
        for (const leg of segment.legs ?? [{ road: segment.line ?? segment.points, color: isWalk ? '#2f7bf6' : lineColor(segment.op, segment.route) }]) {
          const stroke = L.polyline(leg.road.map(point), {
            color: leg.color, weight: isWalk ? 4 : leg.weight ?? 5, dashArray: isWalk ? '1 9' : null, className: isWalk ? '' : 'route-line',
          }).addTo(content);
          // One unit long, so the line can be drawn on by animating its dash.
          if (!isWalk) stroke.getElement()?.setAttribute('pathLength', 1);
        }
        segment.stopIDs.forEach((id, index) => {
          const dot = L.circleMarker(point(segment.marks?.[index] ?? segment.points[index]), { radius: 4, color: segment.dots?.[index] ?? lineColor(segment.op, segment.route), fillColor: '#fff', fillOpacity: 1, weight: 2, className: 'stop-dot' })
            .bindTooltip(name(id), { permanent: true, direction: 'right', offset: [6, 0], className: 'stop-label' }).addTo(content);
          dot.getElement()?.style.setProperty('--i', Math.min(index, 14));
          if (choose) dot.on('click', () => choose(segment, index));
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
  let map, Marker, buses = new Map(), tag = null, chosen = null, glide = 0, hasFramed = false, approach = null, approachStops = [], approachKey = '', items = [];
  const padding = () => {
    const wide = window.matchMedia('(min-width: 820px)').matches;
    return { top: wide ? 30 : 50, left: wide ? 440 : 24, right: wide ? 30 : 24, bottom: wide ? 30 : sheet.targetHeight() + 32 };
  };
  const keep = (item) => { items.push(item); return item; };
  const div = (className, text, color) => {
    const element = document.createElement('div');
    element.className = className;
    if (text) element.textContent = text;
    if (color) element.style.background = color;
    return element;
  };
  /** A zero-sized anchor, so markers sit on the point as they do on the other map. */
  const mark = (location, element, { zIndex, title, click } = {}) => {
    const anchor = div('g-anchor');
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
      return map.moveCamera({ center, zoom });
    }
    const from = map.getCenter(), fromZoom = map.getZoom(), started = performance.now();
    const fromLat = from.lat(), fromLng = from.lng();
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
      const margin = isSnug ? SNUG_MARGIN : 0, { top: topEdge, bottom, left: leftEdge, right: rightEdge } = padding(), box = $('map');
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
    follow(location, zoom = 16, isExact = false) {
      const level = isExact ? zoom : Math.max(map.getZoom(), zoom), world = 256 * 2 ** level;
      const y = 0.5 - Math.log(Math.tan(Math.PI / 4 + (location.lat * Math.PI) / 360)) / (2 * Math.PI) + sheet.targetHeight() / 2 / world;
      moveSmoothly({ lat: (Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) * 360) / Math.PI - 90, lng: location.lng }, level);
    },
    ends(from, to) {
      if (from) mark(from.location, div('pin start'), { title: from.name, zIndex: 400 });
      if (to) mark(to.location, div('pin end', '', '#ff3b30'), { title: to.name, zIndex: 500 });
    },
    path(path, choose) {
      $('map').classList.toggle('many-stops', path.segments.reduce((sum, s) => sum + s.stopIDs.length, 0) > 12);
      for (const segment of path.segments) {
        const color = lineColor(segment.op, segment.route), isWalk = segment.mode === 'walk', road = segment.line ?? segment.points;
        if (isWalk) {
          line(road, {
            strokeOpacity: 0, zIndex: 2,
            icons: [{ icon: { path: google.maps.SymbolPath.CIRCLE, scale: 2, fillColor: '#2f7bf6', fillOpacity: 1, strokeOpacity: 0 }, repeat: '11px' }],
          });
        } else {
          line(road, { strokeColor: '#fff', strokeWeight: 8, strokeOpacity: 0.95, zIndex: 1 });
          (segment.legs ?? [{ road, color, weight: 5 }]).forEach((leg, index) => line(leg.road, { strokeColor: leg.color, strokeWeight: leg.weight, strokeOpacity: 1, zIndex: 2 + index }));
        }
        segment.stopIDs.forEach((id, index) => {
          const stop = div('g-stop');
          stop.style.setProperty('--i', Math.min(index, 14));
          const dot = div('g-dot');
          dot.style.borderColor = segment.dots?.[index] ?? color;
          stop.append(dot, div('stop-label', name(id)));
          mark(segment.marks?.[index] ?? segment.points[index], stop, { zIndex: 100, click: choose && (() => choose(segment, index)) });
        });
        if (segment.mode === 'ride') {
          const chip = div(`route-chip${isDarkText(segment.op) ? ' dark' : ''}`, lineName(segment.op, segment.route, state.lang), color);
          mark(segment.points[0], chip, { zIndex: 200 });
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
  if (state.tab === 'plan' && (state.from || state.to)) fitPlanMap();
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
  if (wasGoogle) frameMap();
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
  state.sharedAI = shared?.available === true;
  spareEmbedKey = shared?.embedKey ?? null;
  if (state.sharedAI) renderTab();
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
const SAME_PLACE_METERS = 30;

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

function resetPlan() {
  Object.assign(state, { focus: null, journeys: [], onMap: null, expanded: null, explanation: null, aiNotice: null, from: null, to: null, error: null });
}

function showRouteView() {
  if (!whenOpen) sheet.snap('half');
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

/** `request` is {kind: 'search'}, {kind: 'chat', text} or {kind: 'place', place}. */
async function runPlan(request) {
  const run = ++planRun, ai = client(), stale = () => run !== planRun, isChat = request.kind === 'chat', phaseBefore = state.phase;
  const startOver = () => {
    const notice = state.aiNotice;
    stopNavigation();
    resetPlan();
    state.aiNotice = notice;
    // A place already known stays reachable even if the trip to it can't be planned.
    if (request.place) state.to = request.place;
    renderNearStops();
  };
  state.aiNotice = null;
  if (!isChat) {
    state.thread = null;
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
      if (stale()) return;
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
      state.aiNotice = googleShops()
        ? t('AI 額度已用完或暫時未能使用，已直接用 Google 搜尋。', 'AI is used up or unavailable, so this went straight to Google.')
        : t('AI 暫時未能使用，已改用基本解析：', 'AI unavailable, used basic parsing: ') + error.message;
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

  setPhase('locating');
  const noLocation = t('未能取得你的位置：請允許定位，或在上方輸入起點。', "Couldn't get your location: allow Location access, or type a start above.");
  const start = intent.origin ? await resolvePlace(intent.origin) : await here();
  if (stale()) return;
  if (!start) return setPhase('failed', intent.origin ? t(`找不到起點「${intent.origin}」。`, `Couldn't find the start "${intent.origin}".`) : noLocation);
  // A shop on screen is already known, so it needs no search.
  let end = request.place ?? request.shops?.find((shop) => shop.name === intent.destination);
  if (!end) end = isCurrentLocation(intent.destination) ? await here() : await resolvePlace(intent.destination);
  if (stale()) return;
  if (!end) return setPhase('failed', t(`找不到目的地「${intent.destination}」。`, `Couldn't find "${intent.destination}".`));
  state.from = start;
  state.to = end;
  renderNearStops();
  // A search can land somewhere other than the words typed, so the boxes say where it went.
  if (request.kind === 'search') {
    if (intent.origin) state.origin = start.name;
    state.destination = end.name;
    syncPlaceInputs();
  }
  mapView.fit([start.location, end.location]);
  if (!inHongKong(start.location)) return setPhase('failed', t('起點不在香港範圍內。', 'The start is outside Hong Kong.'));
  if (meters(start.location, end.location) < SAME_PLACE_METERS) return setPhase('failed', t('出發地和目的地是同一個地方。', 'The start and destination are the same place.'));

  setPhase('planning');
  const now = Date.now();
  if (state.when?.at <= now) {
    state.when = null;
    renderWhen();
    showToast(t('所選時間已過，改為現在出發。', 'That time has passed, so this leaves now.'));
  }
  const { mode, at } = state.when ?? {};
  const { journeys } = await ask({
    type: 'plan', from: start.location, to: end.location, preference: state.preference,
    departure: mode === 'depart' ? at : now, arriveBy: mode === 'arrive' ? at : null,
  });
  if (stale()) return;
  if (!journeys.length) return setPhase('failed', t('找不到公共交通路線，可能已經收車，或距離太近／太遠。', 'No public transport route found. Services may have ended, or the trip is too short or too far.'));
  state.journeys = journeys;
  stagger();
  showBestJourney();
  setPhase('checkingLive');
  fitPlanMap();

  const arrivals = liveArrivalCache(state.db, state.lang);
  const live = await Promise.all(journeys.map((journey) => (journey.departure - now <= LIVE_AHEAD_MS ? retime(journey, arrivals) : journey)));
  if (stale()) return;
  state.journeys = live.sort((a, b) => score(a, state.preference) - score(b, state.preference));
  writeAdvice();
  const moved = showBestJourney();
  setPhase('done');
  if (moved && !mapTouched) fitPlanMap();
  const [best] = state.journeys, minutes = Math.round(totalMinutes(best)), changes = transfers(best);
  answer(t(
    `${start.name}到${end.name}：最佳方案 ${minutes} 分鐘，${changes ? `轉 ${changes} 次車` : '直達'}。`,
    `${start.name} to ${end.name}: best option ${minutes} min, ${changes ? `${changes} change${changes > 1 ? 's' : ''}` : 'direct'}.`,
  ));
}

/** The route the map shows until the rider picks another. Says whether that changed it. */
function showBestJourney() {
  const id = journeyID(state.journeys[0]), isNew = id !== state.onMap;
  state.onMap = id;
  return isNew;
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

const showsEmbed = () => embedShops() && state.tab === 'plan' && state.discovery?.stage === 'choosing' && !state.journeys.length
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
  return journey && state.from && state.to ? journeyPath(journey, state.from.location, state.to.location, state.db) : null;
}

const VEHICLE_REFRESH = 30_000, SAME_ARRIVAL_MS = 90_000;
let shownVehicles = [], gliding = false, lastGlide = 0, lastBusID = 0;
let vehicleRide = null, vehicleList = [], vehicleKey = '', vehicleArrivals = [], vehicleFetched = 0, vehicleFetching = '';
const arrivalsSeen = new Map();

/**
 * The route whose buses are on the map. On a planned trip that is always the bus the rider is waiting
 * for: tapping a stop only shows that stop's arrivals, and the bus and its road stay as they were.
 */
function rideOnScreen() {
  if (state.tab === 'plan') {
    const journey = state.journeys.find((j) => journeyID(j) === (state.nav?.id ?? state.onMap));
    // The buses out there now are not the ones a later trip will catch.
    if (!journey || (!state.nav && journey.departure - Date.now() > LIVE_AHEAD_MS)) return null;
    return rides(journey).find((ride) => !['mtr', 'lightRail'].includes(ride.op));
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
  vehicleRide = ride;
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
  const track = trackOf(route, ride.op);
  const previous = vehicleList;
  const shownTime = state.tab === 'plan' ? ride.liveDeparture : chosenStopArrival();
  vehicleList = vehiclesOnRoute(vehicleArrivals, vehicleRide, state.db, Date.now()).map((vehicle) => {
    // On the real road when that has arrived, by how far along the route it is.
    const placed = track ? { ...vehicle, ...placeOnTrack(track, vehicle.position) } : vehicle;
    // The two answers can be up to a refresh apart; the stop, the sheet and the bus say the same.
    const isShownBus = vehicle.isNext && shownTime && Math.abs(shownTime - vehicle.arrival) < SAME_ARRIVAL_MS;
    return isShownBus ? { ...placed, minutes: minutesUntil(shownTime), isLive: true } : placed;
  });
  if (previous !== vehicleList) glideVehicles();
  const coming = vehicleList.find((vehicle) => vehicle.isNext);
  if (state.tab !== 'plan') return mapView.approach(null);
  const ids = route.stops[ride.op], stop = stopOnRoad(route, ride.op, ride.boardPosition);
  const ahead = coming ? ids.slice(Math.ceil(coming.position), ride.boardPosition).flatMap((id, index) => {
    const location = stopOnRoad(route, ride.op, Math.ceil(coming.position) + index);
    return location ? [{ id, location, name: name(id) }] : [];
  }) : [];
  const road = coming && stop && (track ? trackBetween(track, coming.position, ride.boardPosition) : [coming.location, stop]);
  mapView.approach(road || null, coming?.color, ahead);
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
  if (position == null) return;
  const isSame = state.focus?.routeKey === segment.routeKey && state.focus.position === position;
  state.focus = isSame ? null : { routeKey: segment.routeKey, op: segment.op, position };
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
  clear($('plan-stop'), planStopCard());
  tagShown = '';
  showChosenStop();
  moveVehicles();
  if (!state.focus) return fitPlanMap();
  $('sheet').scrollTop = 0;
  sheet.snap('half');
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
    return { ...vehicle, location: same?.location ?? vehicle.location };
  });
  if (calm.matches) {
    shownVehicles = vehicleList;
    return mapView.vehicles(vehicleList);
  }
  mapView.vehicles(shownVehicles);
  if (gliding || !shownVehicles.length) return;
  gliding = true;
  requestAnimationFrame(glideFrame);
}

function glideFrame(now) {
  if (!vehicleList.length) {
    gliding = false;
    return;
  }
  // The eased share of the way there, so a corrected position slides rather than jumps.
  const share = 1 - Math.exp(-(now - lastGlide) / 700);
  lastGlide = now;
  shownVehicles = shownVehicles.map((vehicle, index) => {
    const target = vehicleList[index]?.location ?? vehicle.location;
    return {
      ...(vehicleList[index] ?? vehicle),
      location: { lat: vehicle.location.lat + (target.lat - vehicle.location.lat) * share, lng: vehicle.location.lng + (target.lng - vehicle.location.lng) * share },
    };
  });
  mapView.vehicles(shownVehicles);
  requestAnimationFrame(glideFrame);
}

const SHORTEST_GOOGLE_WALK = 40;

const hasRealLine = (segment) => segment.mode === 'ride' && !['mtr', 'lightRail'].includes(segment.op);

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

/** The path with real walking and bus lines in place of straight ones, where they have arrived. */
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

function withRoads(path) {
  return path && {
    ...path,
    segments: path.segments.map((segment) => {
      const first = segment.points[0], last = segment.points.at(-1);
      if (segment.mode === 'walk') return { ...segment, points: knownWalk(first, last) ?? segment.points };
      if (!hasRealLine(segment)) return segment;
      const track = trackOf(state.db.routes[segment.routeKey], segment.op);
      if (!track || !segment.positions) return segment;
      return { ...segment, line: roadBetween(track, segment.positions[0], segment.positions.at(-1)), marks: segment.positions.map((position) => track.passes[position]?.location) };
    }).map(withLegs),
  };
}

/** Only the route on screen asks, and each line only once. Bus lines are free; walks use Google's allowance. */
function loadRoads(path) {
  if (!path) return Promise.resolve(false);
  const buses = path.segments.filter(hasRealLine).map((segment) => [state.db.routes[segment.routeKey], segment.op])
    .filter(([route, op]) => !knownShape(route, op));
  const walks = !state.google ? [] : path.segments.filter((segment) => segment.mode === 'walk')
    .map((segment) => [segment.points[0], segment.points.at(-1)])
    .filter(([from, to]) => meters(from, to) >= SHORTEST_GOOGLE_WALK && !knownWalk(from, to));
  return Promise.all([...buses.map(([route, op]) => loadShape(route, op)), ...walks.map(([from, to]) => googleWalk(from, to))])
    .then(() => buses.some(([route, op]) => knownShape(route, op)) || walks.some(([from, to]) => knownWalk(from, to)));
}

async function startNavigation(journey) {
  const path = journeyPath(journey, state.from.location, state.to.location, state.db), id = journeyID(journey);
  state.nav = { id, path, progress: null, here: null, issue: null };
  // Tracking follows the real walking line once it arrives.
  loadRoads(path).then(() => { if (state.nav?.id === id) state.nav.path = withRoads(path); });
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
  sheet.snap('peek');
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
  $('app').append(h('div', { id: 'nav-banner', class: 'nav-banner' }, icon('navigate', 20, true),
    h('span', { class: 'grow' }, text),
    h('button', { onclick: () => { stopNavigation(); renderSheet(); drawMap(); fitPlanMap(); } }, progress?.hasArrived ? t('完成', 'Done') : t('結束', 'End'))));
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
    if (text.trim()) sendChat();
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
  if (state.listening) return t('正在聆聽…', 'Listening…');
  if (state.discovery?.stage === 'asking') return t('輸入你的回答…', 'Type your answer…');
  return t('問 AI，例如：去吃茶餐廳', 'Ask AI, e.g. Find a cha chaan teng');
}

// MARK: Actions

function search() {
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
  runPlan({ kind: 'search' });
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
  if (!text || !state.db) return;
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
  state.origin = isCurrentLocation(end) ? '' : end;
  state.destination = start || t('我的位置', 'My location');
  syncPlaceInputs();
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
  if (!state.db) return;
  const run = ++stopRun, text = state.stopQuery.trim(), index = siteIndex();
  state.stopSuggesting = false;
  state.focus = null;
  state.stopError = null;
  state.stopOpen = null;
  let place = null;
  state.stopBusy = true;
  renderSheet();
  if (chosen) {
    history.add('stops', text);
    place = chosen;
  } else if (aroundMe) {
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
  stagger();
  renderSheet();
  drawMap();
  if (place) mapView.fit([offset(place.location, state.stopRadius, -1), offset(place.location, state.stopRadius, 1)], 18);
}
let stopRun = 0;
const offset = (l, m, sign) => ({ lat: l.lat + (sign * m) / 111_000, lng: l.lng + (sign * m) / 103_000 });

function planTo(site) {
  planToPlace({ name: nameText(site.name, state.lang), location: site.location });
}

function planToPlace(place) {
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
  return h('div', { class: 'row' },
    h('button', {
      class: 'tap grow', onclick: () => {
        focusRoute(visit.routeKey, visit.op, visit.seq);
        renderSheet();
        $('sheet').scrollTop = 0;
      },
    }, h('div', { class: 'row' }, badge(visit.op, route.route), h('span', { class: 'small ellipsis grow' }, `→ ${nameText(route.dest, state.lang)}`), h('span', { class: 'muted' }, icon('down', 15)))),
    starButton(visit.routeKey, visit.seq, visit.op));
}

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

function renderPlanTop() {
  if (!state.routeView) {
    clear($('top'), h('div', { class: 'row' },
      h('label', { class: 'search-card single' }, h('span', { class: 'muted' }, icon('search', 18)), h('input', {
        id: 'destination-input', value: state.destination, placeholder: t('搜尋地點或站名', 'Search places or stops'), enterkeyhint: 'search', autocomplete: 'off',
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
        state[field] = event.target.value;
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
      h('button', { class: 'round', 'aria-label': t('關閉', 'Close'), onclick: closeTrip }, icon('close', 16))),
    h('div', { class: 'search-card' },
      h('div', { class: 'places' },
        h('div', { class: 'rail' }, h('i'), h('b'), h('i', { class: 'end' })),
        place('origin', t('我的位置', 'My location'), h('button', {
          class: 'icon-button on', 'aria-label': t('由我的位置出發', 'Start from my location'),
          onclick: (event) => { event.preventDefault(); state.origin = ''; syncPlaceInputs(); getFix(true); },
        }, icon('locate', 19))),
        h('hr'),
        place('destination', t('要去哪裡？', 'Where to?'))),
      h('div', { class: 'stack', style: 'align-items:center' },
        h('button', { class: 'icon-button', 'aria-label': t('對調起點及目的地', 'Swap start and destination'), onclick: swapEnds }, icon('swap', 19)),
        h('button', { class: 'go', 'aria-label': t('搜尋', 'Search'), onclick: search }, icon('search', 19)))),
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
  if (state.to) runPlan({ kind: 'place', place: state.to });
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
    settling = setTimeout(() => pick(values[index]), WHEEL_SETTLES_MS);
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
      class: 'when-chip', 'aria-expanded': String(whenOpen),
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
  if (slot) clear(slot, state.to && h('button', { class: 'when-chip', onclick: () => showStopsNear(state.to) }, icon('bus', 15), t('目的地附近站點', 'Stops near destination')));
}

function showStopsNear(place) {
  state.stopQuery = place.name;
  setTab('stops');
  searchStops(false, place);
}

function journeyCard(journey) {
  const id = journeyID(journey), isOpen = state.expanded === id, isNavigating = state.nav?.id === id;
  const shown = journey.legs.filter((leg) => leg.type === 'ride' || leg.minutes >= 0.5);
  const changes = transfers(journey);
  const arrive = clock(arrivalTime(journey));
  return h('div', { class: `card${isOpen ? ' open' : ''}${state.onMap === id ? ' on-map' : ''}${state.justOpened === id ? ' reveal' : ''}`, 'data-journey': id },
    h('button', {
      class: 'tap', 'aria-expanded': String(isOpen), onclick: () => {
        state.onMap = id;
        state.expanded = isOpen ? null : id;
        state.justOpened = isOpen ? null : id;
        state.focus = null;
        renderSheet();
        // The route is what was asked for, so a sheet covering the map makes way for it.
        if (!isOpen) closeSheetForMap();
        fitPlanMap();
        if (!isOpen) document.querySelector('.card.open')?.scrollIntoView({ block: 'nearest', behavior: calm.matches ? 'auto' : 'smooth' });
      },
    },
      h('div', { class: 'row', style: 'align-items:baseline' },
        h('span', { class: 'minutes' }, Math.round(totalMinutes(journey))),
        h('span', { class: 'small muted' }, t('分鐘', 'min')),
        h('span', { class: 'grow' }),
        rides(journey).some((ride) => ride.liveDeparture) && h('span', { class: 'row tiny live bold', style: 'gap:6px' }, h('i', { class: 'pulse' }), t('實時', 'Live')),
        h('span', { class: `small ${arrivesLate(journey) ? 'late' : 'muted'}` }, state.when ? `${clock(journey.departure)} – ${arrive}` : t(`${arrive} 到達`, `Arrive ${arrive}`))),
      h('div', { class: 'chips', style: 'margin-top:9px' }, shown.flatMap((leg, index) => [
        index > 0 && icon('next', 13),
        leg.type === 'walk' ? h('span', { class: 'walk' }, icon('walk', 15), Math.max(1, Math.round(leg.minutes))) : badge(leg.op, leg.route),
      ])),
      h('div', { class: 'tiny muted', style: 'margin-top:7px' }, `${changes ? t(`轉 ${changes} 次`, `${changes} change${changes > 1 ? 's' : ''}`) : t('直達', 'Direct')} · ${t(`步行 ${Math.round(walkingMeters(journey))} 米`, `walk ${Math.round(walkingMeters(journey))} m`)}`)),
    isOpen && h('div', { class: 'timeline' }, journey.legs.map(legDetail)),
    isOpen && h('button', {
      class: `primary wide${isNavigating ? ' danger' : ''}`,
      onclick: () => { if (isNavigating) { stopNavigation(); renderSheet(); drawMap(); fitPlanMap(); } else { stopNavigation(); startNavigation(journey); } },
    }, icon(isNavigating ? 'stop' : 'navigate', 18, true), isNavigating ? t('結束導航', 'End navigation') : t('開始導航', 'Start navigation')));
}

function legDetail(leg) {
  if (leg.type === 'walk') {
    const minutes = Math.max(1, Math.round(leg.minutes)), target = leg.to ? name(leg.to) : t('目的地', 'destination');
    return h('div', { class: 'leg walking' }, h('div', { class: 'track' }),
      h('div', { class: 'body small muted' }, t(`步行約 ${minutes} 分鐘（${Math.round(leg.meters)} 米）到 ${target}`, `Walk about ${minutes} min (${Math.round(leg.meters)} m) to ${target}`)));
  }
  const wait = Math.round(leg.waitMinutes), platform = leg.livePlatform ? ` · ${nameText(leg.livePlatform, state.lang)}` : '';
  const when = !leg.liveDeparture ? t(`估算：等候約 ${wait} 分鐘（暫無實時資料）`, `Estimate: about ${wait} min wait (no live data)`)
    : leg.isProjected ? t(`實時推算：約 ${clock(leg.liveDeparture)} 開出（等候約 ${wait} 分鐘）`, `Projected from live: about ${clock(leg.liveDeparture)} (${wait} min wait)`) + platform
      : t(`實時：${clock(leg.liveDeparture)} 開出（等候約 ${wait} 分鐘）`, `Live: departs ${clock(leg.liveDeparture)} (${wait} min wait)`) + platform;
  const stops = leg.alightPosition - leg.boardPosition, element = h('div', { class: 'leg' },
    h('div', { class: 'track' }, h('i', { class: 'node' })),
    h('div', { class: 'body' },
      h('div', { class: 'row' }, h('span', { class: 'bold ellipsis' }, name(leg.boardStopID)), badge(leg.op, leg.route)),
      h('div', { class: 'tiny muted' }, t(`往 ${leg.dest.zh}`, `To ${leg.dest.en}`)),
      h('div', { class: `tiny ${leg.liveDeparture ? 'live' : 'muted'}` }, when),
      h('div', { class: 'tiny muted', style: 'margin-top:4px' }, t(`${stops} 個站 · 約 ${Math.round(leg.rideMinutes)} 分鐘`, `${stops} stops · about ${Math.round(leg.rideMinutes)} min`)),
      h('div', { class: 'bold small', style: 'margin-top:4px' }, t(`${name(leg.alightStopID)} 下車`, `Get off at ${name(leg.alightStopID)}`))));
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
      h('div', { class: 'examples' }, examples.map((text) => h('button', { onclick: () => { state.chat = text; sendChat(); } }, text))),
    ],
  ];
}

const PHASES = {
  understanding: () => (client() ? t('AI 正在分析你的要求…', 'AI is analysing your request…') : t('理解要求…', 'Reading your request…')),
  findingPlaces: () => (googleShops() ? t('正在 Google 地圖搜尋…', 'Searching Google Maps…') : t('正在搜尋地點…', 'Searching for places…')),
  locating: () => t('正在尋找起點及目的地…', 'Finding places…'),
  planning: () => t('正在計算路線…', 'Planning routes…'),
  checkingLive: () => t('正在核對實時到站時間…', 'Checking live arrivals…'),
};

function planSheet() {
  const items = [];
  if (!state.db) {
    items.push(state.dbError
      ? [h('div', { class: 'notice' }, state.dbError), h('button', { class: 'primary', onclick: loadDB }, t('重試', 'Retry'))]
      : h('div', { class: 'status' }, h('span', { class: 'spinner' }), t('正在載入路線資料…', 'Loading route data…')));
    return items;
  }
  items.push(h('div', { id: 'plan-stop' }, planStopCard()));
  // While the AI thinks, its card says so.
  if (PHASES[state.phase] && !(state.phase === 'understanding' && state.thread)) items.push(h('div', { class: 'status' }, h('span', { class: 'spinner' }), PHASES[state.phase]()));
  if (PHASES[state.phase] && !state.journeys.length) items.push(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
  if (state.error && !state.thread?.reply) items.push(h('div', { class: 'notice' }, state.error));
  const best = state.journeys[0];
  if (best && arrivesLate(best)) items.push(h('div', { class: 'notice' }, t(`${clock(best.arriveBy)} 前趕不及，最快約 ${clock(arrivalTime(best))} 到達。`, `You can't make it by ${clock(best.arriveBy)}. The earliest is about ${clock(arrivalTime(best))}.`)));
  if (state.journeys.length) {
    items.push(segments([['fastest', t('最快', 'Fastest')], ['fewerTransfers', t('少轉車', 'Fewer changes')], ['lessWalking', t('少行路', 'Less walking')]], state.preference, (preference) => {
      state.preference = preference;
      state.journeys = [...state.journeys].sort((a, b) => score(a, preference) - score(b, preference));
      const moved = !state.expanded && showBestJourney();
      writeAdvice();
      renderSheet();
      if (moved) fitPlanMap();
    }));
    // The AI's card already sums up a trip it was asked for.
    if (state.explanation && !state.thread) items.push(h('div', { class: 'advice' }, state.explanation));
  }
  if (state.discovery?.stage === 'choosing') {
    if (state.journeys.length || state.phase !== 'idle') {
      items.push(h('button', { class: 'back', onclick: backToSuggestions }, icon('back', 17), t('返回推薦地點', 'Back to recommendations')));
    } else {
      items.push(suggestionList(state.discovery));
    }
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
  clear($('bottom'),
    h('div', { id: 'ai-status' }),
    h('div', { id: 'chat-history' }),
    h('div', { id: 'composer', class: `field composer${Recognition ? '' : ' no-mic'}${state.chat.trim() ? ' typing' : ''}` },
      h('span', { class: client() ? 'ai' : 'muted' }, icon('spark', 18)),
      h('input', {
        id: 'chat-input', value: state.chat, placeholder: chatPrompt(), enterkeyhint: 'send', autocomplete: 'off',
        oninput: (event) => {
          state.chat = event.target.value;
          syncComposer();
        },
        onfocus: () => renderChatHistory(true),
        onblur: () => setTimeout(() => renderChatHistory(false), 150),
        onkeydown: (event) => { if (event.key === 'Enter') sendChat(); },
      }),
      Recognition && h('button', { id: 'mic', class: 'icon-button', 'aria-label': t('語音輸入', 'Voice input'), onclick: toggleSpeech }, icon('mic', 20)),
      h('button', { class: 'go', 'aria-label': t('傳送', 'Send'), onmousedown: (event) => event.preventDefault(), onclick: sendChat }, icon('send', 19))),
    !client() && h('div', { class: 'tiny muted', style: 'padding:0 6px' }, t('AI 未連接，現時使用基本解析。', 'AI isn\'t connected, using basic parsing.')));
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
        id: 'stop-input', value: state.stopQuery, placeholder: t('站名或地點，例如：旺角、朗豪坊', 'Stop or place, e.g. Mong Kok'), enterkeyhint: 'search', autocomplete: 'off',
        oninput: (event) => {
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
      renderSheet();
      drawMap();
    }),
    segments([[300, '300 m'], [500, '500 m'], [1000, '1 km']], state.stopRadius, (radius) => {
      state.stopRadius = radius;
      state.stops = state.stopPlace ? stopsNear(siteIndex(), state.stopPlace.location, radius) : [];
      renderSheet();
      drawMap();
    }),
  ];
}

const visibleStops = () => state.stops.filter((stop) => siteHasMode(stop.site, state.stopMode));

function stopCard(stop, isNearest) {
  const isOpen = state.stopOpen === stop.site.id;
  const numbers = [...new Set(stop.site.visits.map((v) => lineName(v.op, state.db.routes[v.routeKey].route, state.lang)))];
  return h('div', { class: `card${isOpen ? ' open' : ''}`, id: `stop-${stop.site.id}` },
    h('button', { class: 'tap', 'aria-expanded': String(isOpen), onclick: () => { state.stopOpen = isOpen ? null : stop.site.id; renderSheet(); if (state.focus) leaveFocus(); } },
      h('div', { class: 'row' }, h('span', { class: 'bold grow' }, nameText(stop.site.name, state.lang)),
        h('span', { class: `small ${isNearest ? 'live bold' : 'muted'}` }, distanceText(stop.distance)), h('span', { class: 'muted' }, icon(isOpen ? 'up' : 'down', 16))),
      h('div', { class: 'tiny muted ellipsis' }, numbers.slice(0, 8).join(' · ') + (numbers.length > 8 ? ` +${numbers.length - 8}` : ''))),
    isOpen && [
      h('button', { class: 'primary wide', onclick: () => planTo(stop.site) }, icon('route', 18), t('規劃路線到這裡', 'Plan a trip here')),
      h('div', { class: 'tiny muted' }, t('此站路線 · 點選查看最近兩班', 'Routes at this stop · tap for arrivals')),
      stop.site.visits.filter(MODES[state.stopMode]).map(visitRow),
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
      $('sheet').scrollTop = 0;
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

/** The start waits for a destination, so the rider can look through other routes for one. */
function addStopToTrip(id, side) {
  const stop = name(id);
  pickedPlaces.set(stop, { name: stop, location: state.db.stops[id].location });
  if (side === 'start') {
    state.origin = stop;
    return showToast(t(`出發地：${stop}。再選一個站設為目的地。`, `Starting from ${stop}. Now pick a stop to go to.`));
  }
  state.destination = stop;
  setTab('plan');
  syncPlaceInputs();
  return search();
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

function settingsSheet() {
  const searches = Object.values(store.get('history', {})).flat().length + state.recentRoutes.length;
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
    settingGroup(t('AI 助手', 'AI assistant'),
      h('div', { class: 'setting inline' }, h('span', {}, t('狀態', 'Status')),
        h('span', { class: state.sharedAI ? 'ok' : 'muted' }, state.sharedAI ? t('已連接', 'Connected') : t('未連接', 'Not connected'))),
      h('div', { class: 'tiny muted' }, t('每人每日有使用上限，用完後會直接用 Google 搜尋，不影響查路線。', 'Everyone has a daily limit. After it, searches go straight to Google, and routes still work.'))),
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
      aboutItem(t('安裝到手機', 'Install on your phone'), t('iPhone：在 Safari 按分享，再選「加入主畫面」。Android：在 Chrome 選單按「安裝應用程式」。', 'iPhone: in Safari, tap Share, then Add to Home Screen. Android: in the Chrome menu, tap Install app.')),
      aboutItem(t('私隱', 'Privacy'), t(
        '此網站不收集個人資料。收藏及搜尋記錄只保存在你的瀏覽器。到站查詢直接連到各營辦商。使用「附近」找地點時，你的座標會經本站伺服器傳送給 Google，或在額度用完時傳送給 OpenStreetMap 的 Photon 服務，用來搜尋你身邊 5 公里內的地點。AI 請求及店舖搜尋經本站伺服器轉送給 DeepSeek 及 Google，伺服器不會保存內容。傳送給 DeepSeek 的只有你輸入的文字、地區、站名、路線號碼及店舖資料，不包括座標；Google 地圖會由你的瀏覽器直接載入，並受 Google 私隱政策約束。',
        'This site collects no personal data. Saved stops and history stay in your browser. Arrivals come straight from the operators. When finding places nearby, your coordinates go through this site\'s server to Google, or to OpenStreetMap\'s Photon service once the allowance is used up, to search within 5 km of you. AI requests and shop searches pass through this site\'s server to DeepSeek and Google, and the server keeps none of it. DeepSeek only receives your text, the district, stop names, route numbers and shop details, never coordinates. Google Maps loads straight into your browser under Google\'s privacy policy.')),
      aboutItem(t('資料來源', 'Data sources'), t('路線資料來自 hkbus.app；到站時間來自各營辦商；地圖及店舖來自 Google；額度用完後改用 OpenFreeMap、OpenStreetMap 及政府地理資訊。', 'Route data from hkbus.app; arrivals from the operators; maps and shops from Google; after the allowance, OpenFreeMap, OpenStreetMap and Government GIS.')),
      h('a', { class: 'small link', href: 'https://github.com/kevinwentao07-zwt/hktransport', target: '_blank', rel: 'noopener' }, t('GitHub 原始碼（GPL-3.0）', 'Source on GitHub (GPL-3.0)'))),
  ];
}

// MARK: Bottom sheet

/** The panel over the map: dragged between peek, half and full. */
const sheet = {
  current: 'half',
  heights() {
    const app = $('app').clientHeight;
    const peek = $('grabber').offsetHeight + $('top').offsetHeight + $('bottom').offsetHeight + 6;
    const full = app - 54;
    return { peek: Math.min(peek, full), half: Math.max(peek, Math.min(full, Math.round(app * 0.52))), full };
  },
  measure() {
    this.apply(this.heights()[this.current]);
  },
  apply(height) {
    $('app').style.setProperty('--panel-h', `${height}px`);
  },
  /** Where the sheet is heading, which the map must clear even mid-animation. */
  targetHeight() {
    return this.heights()[this.current];
  },
  snap(name) {
    this.current = name;
    this.apply(this.heights()[name]);
    $('app').classList.toggle('sheet-full', name === 'full');
    $('grabber').setAttribute('aria-valuetext', name);
  },
  attach() {
    const grabber = $('grabber'), panel = $('panel'), list = $('sheet');
    let startX = 0, startY = 0, startHeight = 0, lastY = 0, lastTime = 0, speed = 0;
    let tracking = false, dragging = false, fromGrabber = false, swallowClick = false;
    // The whole sheet is a handle. Once it is full, the list scrolls instead.
    panel.addEventListener('pointerdown', (event) => {
      swallowClick = false;
      if (event.button !== 0 || !grabber.offsetParent || event.target === document.activeElement || event.target.closest?.('.no-drag')) return;
      if (this.current === 'full' && list.contains(event.target)) return;
      fromGrabber = grabber.contains(event.target);
      startX = event.clientX;
      startY = lastY = event.clientY;
      lastTime = event.timeStamp;
      startHeight = panel.offsetHeight;
      speed = 0;
      tracking = true;
      dragging = false;
    });
    panel.addEventListener('pointermove', (event) => {
      if (!tracking) return;
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
      // Past either end the sheet resists like a rubber band.
      const height = wanted > full ? full + (wanted - full) * 0.18 : wanted < peek ? peek - (peek - wanted) * 0.18 : wanted;
      this.apply(height);
    });
    const finish = () => {
      if (!tracking) return;
      tracking = false;
      const order = ['peek', 'half', 'full'], index = order.indexOf(this.current);
      if (!dragging) {
        if (fromGrabber) this.snap(order[(index + 1) % order.length]); // A tap steps through the sizes.
        return;
      }
      panel.classList.remove('dragging');
      swallowClick = true;
      const heights = this.heights(), height = panel.offsetHeight;
      const nearest = order.reduce((best, key) => (Math.abs(heights[key] - height) < Math.abs(heights[best] - height) ? key : best));
      // A quick flick moves on a step, wherever the finger let go.
      this.snap(Math.abs(speed) > 0.5 ? order[Math.max(0, Math.min(2, index + Math.sign(speed)))] : nearest);
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
      const order = ['peek', 'half', 'full'], index = order.indexOf(this.current);
      if (event.key === 'ArrowUp') this.snap(order[Math.min(2, index + 1)]);
      if (event.key === 'ArrowDown') this.snap(order[Math.max(0, index - 1)]);
    });
  },
};

// MARK: Rendering

function renderSheet() {
  const sheets = { plan: planSheet, stops: stopsSheet, routes: routesSheet, saved: savedSheet, settings: settingsSheet };
  clear($('sheet'), sheets[state.tab]());
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

/** Lines and pins animate in only when the scene really changes, not on every redraw. */
function markScene(scene) {
  if (scene === drawnScene) return;
  drawnScene = scene;
  $('map').classList.add('entering');
  clearTimeout(entering);
  entering = setTimeout(() => $('map').classList.remove('entering'), 1800);
}

function drawMap() {
  showEmbed();
  markScene(`${state.tab}|${state.onMap ?? ''}|${state.nav?.id ?? ''}|${state.to?.name ?? ''}|${state.discovery?.stage ?? ''}|${state.stopPlace?.name ?? ''}`);
  mapView.clear();
  const here = state.nav?.here ?? state.fix;
  if (here) mapView.me(here);
  if (state.tab !== 'plan' && state.focus) {
    const path = focusPath(), { position, op, routeKey } = state.focus;
    mapView.path(withRoads(path), (segment, index) => chooseFocusStop(segment.positions[index]));
    loadRoads(path).then((arrived) => { if (arrived && state.focus) drawMap(); });
    showChosenStop();
    moveVehicles();
    return;
  }
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
  if (state.tab !== 'plan') return moveVehicles();
  const path = state.nav?.path ?? selectedPath();
  if (path) {
    mapView.path(withRoads(path), chooseLineStop);
    loadRoads(path).then((arrived) => {
      if (!arrived) return;
      drawMap();
      // The real road can bulge past the stops the view was framed on.
      if (!mapTouched && !state.nav && state.tab === 'plan') fitPlanMap();
    });
  }
  const choosing = state.discovery?.stage === 'choosing' && !state.journeys.length && state.phase === 'idle';
  if (choosing && !showsEmbed()) mapView.numbered(state.discovery.suggestions, choosePlace);
  mapView.ends(state.from, state.to);
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
for (const gesture of ['pointerdown', 'wheel']) $('map').addEventListener(gesture, () => { mapTouched = true; }, { passive: true });

function fitPlanMap() {
  mapTouched = false;
  const path = selectedPath();
  const points = path ? withRoads(path).segments.flatMap((s) => s.line ?? s.points) : [state.from?.location, state.to?.location].filter(Boolean);
  if (points.length) mapView.fit(points, 16, !!path);
}

function renderTab() {
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
    if (state.from || state.to) fitPlanMap();
    else showHomeMap();
  }
}

/** A phone's keyboard covers the page without resizing it, so the sheet rises to stay above it. */
function clearKeyboard() {
  const view = window.visualViewport, app = $('app');
  const covered = view.scale > 1.01 ? 0 : Math.max(0, Math.round(app.clientHeight - view.height - view.offsetTop));
  app.style.setProperty('--keyboard', `${covered}px`);
  app.style.setProperty('--room', `${Math.round(view.height)}px`);
}
window.visualViewport?.addEventListener('resize', clearKeyboard);
window.visualViewport?.addEventListener('scroll', clearKeyboard);

new ResizeObserver(() => mapView.resize()).observe($('map'));
new ResizeObserver(() => sheet.measure()).observe($('top'));
new ResizeObserver(() => sheet.measure()).observe($('bottom'));
sheet.attach();
// Keys were once saved here, and nothing needs them now.
try { for (const old of ['hkt.apiKey', 'hkt.model']) localStorage.removeItem(old); } catch { /* Private mode. */ }

applyScript();
mapView.init();
renderTab();
mapView.home();
clear($('locate'), icon('arrow', 20));
$('locate').addEventListener('click', async () => {
  const fix = await getFix(true);
  if (!fix) return;
  drawMap();
  mapView.follow(fix, 15);
});
locateOnOpen();
checkServer();
loadDB();
setInterval(() => { if (state.tab === 'saved') renderSheet(); }, 30_000);
if ('serviceWorker' in navigator) {
  // A page left open would otherwise keep running the old release, so a new one reloads it.
  const hadWorker = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadWorker) location.reload(); });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
