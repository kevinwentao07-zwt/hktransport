// The page itself: tabs, map, and the flows that tie the modules together.
import { meters,
  OP_COLORS, OP_LABELS, MODES, buildStopIndex, exactSite, instruction, journeyID, journeyPath, lineColor, lineName,
  nameText, normalizeDB, partialSite, primaryMode, progressAt, retime, rides, score, searchRoutes, siteHasMode, stopName, stopsNear,
  totalMinutes, transfers, walkingMeters,
} from './transit.js?v=dev';
import { fetchETA, liveArrivalCache } from './eta.js?v=dev';
import { chatMessage, deepSeek, sharedAI, isCurrentLocation, normalizedOrigin, parseFollowUp, parseWish, searchMessage } from './ai.js?v=dev';
import { HONG_KONG, cleanArea, districtAt, googleSearch, googleWalk, inHongKong, isNearby, knownWalk, lookupPlace, photonSearch, withinArea } from './places.js?v=dev';

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
  routeView: false, nav: null, fix: null, speechLang: store.get('speechLang', 'zh-HK'), listening: false,
};
const t = (zh, en) => (state.lang === 'zh' ? zh : en);
const name = (id) => stopName(id, state.db, state.lang);
const client = () => {
  const key = store.get('apiKey', '');
  if (key) return deepSeek(key, store.get('model', '') || undefined);
  return state.sharedAI ? sharedAI() : null;
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
const calm = window.matchMedia('(prefers-reduced-motion: reduce)');

const ICONS = {
  route: ['M6 19a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z', 'M18 10a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z', 'M8.5 16.5H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5'],
  pin: ['M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21Z', 'M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z'],
  bus: ['M6 17V6.5A2.5 2.5 0 0 1 8.5 4h7A2.5 2.5 0 0 1 18 6.5V17a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1Z', 'M6 12h12', 'M8.5 18v2', 'M15.5 18v2', 'M9 15h.01', 'M15 15h.01'],
  star: ['M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9L12 3.5Z'],
  settings: ['M4 7h10', 'M18 7h2', 'M4 17h2', 'M10 17h10', 'M16 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z', 'M8 19.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z'],
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

const leafletMap = (() => {
  let map, content, base, lastFit = '', flying = false;
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
      map = L.map('map', { zoomControl: false, attributionControl: true, minZoom: 10, maxZoom: 19 }).setView([22.34, 114.15], 11);
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
    clear() { content?.clearLayers(); },
    fit(points, maxZoom = 16) {
      if (!points.length) return;
      // Frame the part of the map the search card and panel leave uncovered.
      const wide = window.matchMedia('(min-width: 820px)').matches;
      const options = {
        maxZoom, paddingTopLeft: [wide ? 440 : 24, wide ? 30 : 50],
        paddingBottomRight: [wide ? 30 : 24, wide ? 30 : sheet.targetHeight() + 32],
      };
      const bounds = L.latLngBounds(points.map(point));
      // Leaflet can't fly to where it already is: its path works out to NaN.
      const fit = `${bounds.toBBoxString()}|${options.paddingBottomRight}`, still = fit === lastFit;
      lastFit = fit;
      if (calm.matches || !flying || still) map.fitBounds(bounds, { ...options, animate: false });
      else map.flyToBounds(bounds, { ...options, duration: 0.9, easeLinearity: 0.2 });
      flying = true;
    },
    follow(location, zoom = 16) {
      // Centred in the part of the map the sheet leaves showing.
      const level = Math.max(map.getZoom(), zoom);
      const target = map.unproject(map.project(point(location), level).add([0, sheet.targetHeight() / 2]), level);
      if (map.getCenter().distanceTo(target) > 1 || map.getZoom() !== level) map.flyTo(target, level, { duration: calm.matches ? 0 : 0.8 });
    },
    ends(from, to) {
      if (from) L.marker(point(from.location), { icon: pin('', 'pin start'), title: from.name }).addTo(content);
      if (to) L.marker(point(to.location), { icon: pin('', 'pin end', '#ff3b30'), title: to.name, zIndexOffset: 500 }).addTo(content);
    },
    path(path) {
      // A few station names always fit; a long bus route's only fit up close.
      $('map').classList.toggle('many-stops', path.segments.reduce((sum, s) => sum + s.stopIDs.length, 0) > 12);
      for (const segment of path.segments) {
        const line = segment.points.map(point);
        L.polyline(line, { color: '#fff', weight: 8, opacity: 0.95 }).addTo(content);
        const isWalk = segment.mode === 'walk';
        const stroke = L.polyline(line, {
          color: isWalk ? '#2f7bf6' : lineColor(segment.op, segment.route), weight: isWalk ? 4 : 5, dashArray: isWalk ? '1 9' : null,
          className: isWalk ? '' : 'route-line',
        }).addTo(content);
        // One unit long, so the line can be drawn on by animating its dash.
        if (!isWalk) stroke.getElement()?.setAttribute('pathLength', 1);
        segment.stopIDs.forEach((id, index) => {
          const dot = L.circleMarker(point(segment.points[index]), { radius: 4, color: lineColor(segment.op, segment.route), fillColor: '#fff', fillOpacity: 1, weight: 2, className: 'stop-dot' })
            .bindTooltip(name(id), { permanent: true, direction: 'right', offset: [6, 0], className: 'stop-label' }).addTo(content);
          dot.getElement()?.style.setProperty('--i', Math.min(index, 14));
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
  let map, Marker, items = [];
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
      marker.addListener('gmp-click', tap);
      element.addEventListener('click', tap);
    }
    return marker;
  };
  const line = (path, options) => keep(new google.maps.Polyline({ map, path, clickable: false, ...options }));
  /** Draws a line along its length, as the other map does with a dash. */
  const drawOn = (polyline, path) => {
    if (calm.matches || !$('map').classList.contains('entering') || path.length < 2) return;
    const started = performance.now();
    const step = (now) => {
      if (!items.includes(polyline)) return;
      const progress = Math.min(1, (now - started) / 900), eased = 1 - (1 - progress) ** 3;
      polyline.setPath(path.slice(0, Math.max(2, Math.ceil(path.length * eased))));
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  return {
    init() {
      Marker = google.maps.marker.AdvancedMarkerElement;
      map = new google.maps.Map($('map'), {
        center: { lat: 22.34, lng: 114.15 }, zoom: 11, minZoom: 10, maxZoom: 19, mapId: 'DEMO_MAP_ID',
        disableDefaultUI: true, clickableIcons: false, gestureHandling: 'greedy', colorScheme: 'FOLLOW_SYSTEM',
      });
      const markZoom = () => $('map').classList.toggle('far', map.getZoom() < 15);
      map.addListener('zoom_changed', markZoom);
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
    },
    fit(points, maxZoom = 16) {
      if (!points.length) return;
      if (points.length === 1) return this.follow(points[0], maxZoom);
      const bounds = new google.maps.LatLngBounds();
      points.forEach((location) => bounds.extend(location));
      map.fitBounds(bounds, padding());
      google.maps.event.addListenerOnce(map, 'idle', () => { if (map.getZoom() > maxZoom) map.setZoom(maxZoom); });
    },
    follow(location, zoom = 16) {
      map.setZoom(Math.max(map.getZoom(), zoom));
      map.setCenter(location);
      map.panBy(0, sheet.targetHeight() / 2);
    },
    ends(from, to) {
      if (from) mark(from.location, div('pin start'), { title: from.name, zIndex: 400 });
      if (to) mark(to.location, div('pin end', '', '#ff3b30'), { title: to.name, zIndex: 500 });
    },
    path(path) {
      $('map').classList.toggle('many-stops', path.segments.reduce((sum, s) => sum + s.stopIDs.length, 0) > 12);
      for (const segment of path.segments) {
        const color = lineColor(segment.op, segment.route), isWalk = segment.mode === 'walk';
        if (isWalk) {
          line(segment.points, {
            strokeOpacity: 0, zIndex: 2,
            icons: [{ icon: { path: google.maps.SymbolPath.CIRCLE, scale: 2, fillColor: '#2f7bf6', fillOpacity: 1, strokeOpacity: 0 }, repeat: '11px' }],
          });
        } else {
          drawOn(line(segment.points, { strokeColor: '#fff', strokeWeight: 8, strokeOpacity: 0.95, zIndex: 1 }), segment.points);
          drawOn(line(segment.points, { strokeColor: color, strokeWeight: 5, strokeOpacity: 1, zIndex: 2 }), segment.points);
        }
        segment.stopIDs.forEach((id, index) => {
          const stop = div('g-stop');
          stop.style.setProperty('--i', Math.min(index, 14));
          const dot = div('g-dot');
          dot.style.borderColor = color;
          stop.append(dot, div('stop-label', name(id)));
          mark(segment.points[index], stop, { zIndex: 100 });
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
    const language = state.lang === 'zh' ? 'zh-HK' : 'en';
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&libraries=marker&language=${language}&region=HK&callback=hktGoogleReady`;
    script.onerror = reject;
    document.head.append(script);
  });
}

/** Puts the map where the rider expects it after the map underneath changes. */
function frameMap() {
  drawMap();
  if (state.tab === 'plan' && (state.from || state.to)) fitPlanMap();
  else if (state.fix && inHongKong(state.fix)) mapView.follow(state.fix, 15);
  else mapView.home();
}

function useFreeMap() {
  state.google = false;
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

async function resolvePlace(text) {
  const site = exactSite(text, siteIndex());
  if (site) return { name: nameText(site.name, state.lang), location: site.location };
  // Google finds places while its free allowance lasts; the free sources take over after that.
  const near = state.fix && inHongKong(state.fix);
  const found = state.google ? (await googleSearch(text, near ? state.fix : HONG_KONG, near ? 5000 : 50_000, state.lang))?.[0] : null;
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
  Object.assign(state, { journeys: [], expanded: null, explanation: null, explaining: false, aiNotice: null, from: null, to: null, error: null });
}

function showRouteView() {
  sheet.snap('half');
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
  Object.assign(state, { origin: '', destination: '', discovery: null, lastChat: null, routeView: false, phase: 'idle' });
  stagger();
  renderTab();
  slideView('back');
  sheet.snap('half');
  mapView.home();
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
  }
  showRouteView();
  syncPlaceInputs();
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
  stagger();
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

const MOST_QUESTIONS = 2;

/** The AI decides whether it needs to ask anything. If not, the search starts at once. */
function startDiscovery(wish, run) {
  if (!wish.question) return discover(wish, run);
  state.discovery = { stage: 'asking', wish };
  setPhase('idle');
  renderBottomStatus();
}

async function answerQuestion(answer) {
  const { wish } = state.discovery, ai = client(), run = ++planRun, stale = () => run !== planRun;
  const asked = (wish.asked ?? 0) + 1;
  if (!ai) return discover({ ...wish, area: answer, question: null }, run);
  resetPlan();
  state.discovery = { stage: 'finding', wish };
  setPhase('understanding');
  renderBottomStatus();
  let next;
  try {
    next = await ai.refine(wish, answer, asked < MOST_QUESTIONS);
  } catch {
    next = { ...wish, area: answer, question: null };
  }
  if (stale()) return;
  startDiscovery({ ...next, asked, question: asked < MOST_QUESTIONS ? next.question : null }, run);
}

async function discover(wish, run = ++planRun) {
  const stale = () => run !== planRun;
  const giveUp = (message) => {
    state.discovery = { stage: 'asking', wish: { ...wish, area: null, question: null, options: [] } };
    setPhase('failed', message);
    renderBottomStatus();
  };
  resetPlan();
  state.discovery = { stage: 'finding', wish };
  setPhase('findingPlaces');
  renderBottomStatus();

  const place = cleanArea(wish.area ?? '附近');
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

  // The AI only picked out what to search for. Google, or the free map after it, finds the places.
  let suggestions = [];
  if (state.google) {
    const found = await googleSearch(`${wish.query} ${searchArea.name}`, searchArea.center, searchArea.radius, state.lang);
    if (stale()) return;
    suggestions = withinArea(found ?? [], searchArea).slice(0, 5).map((place) => ({ place, isGoogle: true }));
  }
  if (!suggestions.length) {
    const found = new Map();
    for (const term of wish.searchTerms) {
      for (const item of withinArea(await photonSearch(term, searchArea.center, searchArea.radius), searchArea)) {
        found.set(`${item.location.lat},${item.location.lng}`, item);
      }
    }
    if (stale()) return;
    suggestions = [...found.values()].sort((a, b) => a.meters - b.meters).slice(0, 5).map((place) => ({ place }));
    if (!suggestions.length) return giveUp(t(`${searchArea.name}找不到${wish.want}，請換一個範圍。`, `Couldn't find ${wish.want} around ${searchArea.name}. Try another area.`));
  }
  state.discovery = { stage: 'choosing', wish, areaName: searchArea.name, suggestions };
  stagger();
  setPhase('idle');
  renderBottomStatus();
  sheet.snap('half');
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

const SHORTEST_GOOGLE_WALK = 40;

/** The path with Google's walking lines in place of straight ones, where they have arrived. */
function withWalks(path) {
  return path && {
    ...path,
    segments: path.segments.map((segment) => (segment.mode === 'walk'
      ? { ...segment, points: knownWalk(segment.points[0], segment.points.at(-1)) ?? segment.points }
      : segment)),
  };
}

/** Only the route on screen asks, and each stretch only once. */
function loadWalks(path) {
  if (!state.google || !path) return Promise.resolve(false);
  const stretches = path.segments.filter((segment) => segment.mode === 'walk')
    .map((segment) => [segment.points[0], segment.points.at(-1)])
    .filter(([from, to]) => meters(from, to) >= SHORTEST_GOOGLE_WALK && !knownWalk(from, to));
  return Promise.all(stretches.map(([from, to]) => googleWalk(from, to))).then(() => stretches.some(([from, to]) => knownWalk(from, to)));
}

async function startNavigation(journey) {
  const path = journeyPath(journey, state.from.location, state.to.location, state.db), id = journeyID(journey);
  state.nav = { id, path, progress: null, here: null, issue: null };
  // Tracking follows the real walking line once it arrives.
  loadWalks(path).then(() => { if (state.nav?.id === id) state.nav.path = withWalks(path); });
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

function chatPrompt() {
  if (state.listening) return t('正在聆聽…', 'Listening…');
  if (state.discovery?.stage === 'asking') return t('輸入你的回答…', 'Type your answer…');
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
  document.activeElement?.blur();
  showRouteView();
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
  if (state.discovery?.stage === 'asking') return void answerQuestion(text);
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
  stagger();
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
  state.routeView = true;
  renderTab();
  sheet.snap('half');
  runPlan({ kind: 'place', place: { name: state.destination, location: site.location } });
}

// MARK: Arrival widgets

function etaWidget(route, seq, op) {
  const root = h('div', { class: 'eta-grid' }, h('div', { class: 'status' }, h('span', { class: 'spinner' }), t('查詢中…', 'Loading…')));
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
        h('div', { class: 'when' }, minutes ? t(`${minutes} 分鐘`, `${minutes} min`) : t('即到', 'Now')),
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
  if (!state.routeView) {
    clear($('top'), h('div', { class: 'row' },
      h('label', { class: 'search-card single' }, h('span', { class: 'muted' }, icon('search', 18)), h('input', {
        id: 'destination-input', value: state.destination, placeholder: t('搜尋地點或站名', 'Search places or stops'), enterkeyhint: 'search', autocomplete: 'off',
        oninput: (event) => { state.destination = event.target.value; },
        onfocus: () => sheet.snap('full'),
        onkeydown: (event) => { if (event.key === 'Enter') search(); },
      }))));
    return;
  }
  const place = (field, placeholder, trailing) => h('label', { class: 'place' },
    h('input', {
      id: `${field}-input`, value: state[field], placeholder, enterkeyhint: 'search', autocomplete: 'off',
      oninput: (event) => { state[field] = event.target.value; },
      onfocus: () => renderPlaceHistory(field),
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
    h('div', { id: 'place-history' }));
}

function journeyCard(journey) {
  const id = journeyID(journey), isOpen = state.expanded === id, isNavigating = state.nav?.id === id;
  const shown = journey.legs.filter((leg) => leg.type === 'ride' || leg.minutes >= 0.5);
  const changes = transfers(journey);
  const arrive = clock(journey.departure + totalMinutes(journey) * 60_000);
  return h('div', { class: `card${isOpen ? ' open' : ''}${state.justOpened === id ? ' reveal' : ''}`, 'data-journey': id },
    h('button', {
      class: 'tap', 'aria-expanded': String(isOpen), onclick: () => {
        state.expanded = isOpen ? null : id;
        state.justOpened = isOpen ? null : id;
        renderSheet();
        fitPlanMap();
        if (!isOpen) document.querySelector('.card.open')?.scrollIntoView({ block: 'nearest', behavior: calm.matches ? 'auto' : 'smooth' });
      },
    },
      h('div', { class: 'row', style: 'align-items:baseline' },
        h('span', { class: 'minutes' }, Math.round(totalMinutes(journey))),
        h('span', { class: 'small muted' }, t('分鐘', 'min')),
        h('span', { class: 'grow' }),
        rides(journey).some((ride) => ride.liveDeparture) && h('span', { class: 'row tiny live bold', style: 'gap:6px' }, h('i', { class: 'pulse' }), t('實時', 'Live')),
        h('span', { class: 'small muted' }, t(`${arrive} 到達`, `Arrive ${arrive}`))),
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

function suggestionList({ wish, areaName, suggestions }) {
  return [
    h('div', { class: 'row' }, h('span', { class: 'title grow' }, t(`${areaName}的${wish.want}`, `${wish.want} around ${areaName}`)),
      h('button', { class: 'link', onclick: () => { state.discovery = { stage: 'asking', wish: { ...wish, area: null, question: null, options: [] } }; renderSheet(); drawMap(); renderBottomStatus(); } }, t('換範圍', 'Change area'))),
    h('div', { class: 'tiny muted' }, suggestions[0]?.isGoogle
      ? t('資料來自 Google 地圖，出發前請確認仍在營業。', 'From Google Maps. Check it is open before you go.')
      : t('地點來自地圖搜尋，沒有菜單資料，未必有售，出發前請先確認。', 'Places come from a map search, which has no menus. Check before you go.')),
    suggestions.map((suggestion, index) => h('button', { class: 'card tap', onclick: () => choosePlace(suggestion) },
      h('div', { class: 'row', style: 'align-items:flex-start' }, h('span', { class: 'num' }, index + 1),
        h('div', { class: 'grow' },
          h('div', { class: 'row' }, h('span', { class: 'bold ellipsis grow' }, suggestion.place.name), h('span', { class: 'tiny muted' }, distanceText(suggestion.place.meters))),
          suggestion.place.address && h('div', { class: 'tiny muted ellipsis' }, suggestion.place.address))))),
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
  findingPlaces: () => (state.google ? t('正在 Google 地圖搜尋…', 'Searching Google Maps…') : t('正在搜尋地點…', 'Searching for places…')),
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
  if (PHASES[state.phase]) items.push(h('div', { class: 'status' }, h('span', { class: 'spinner' }), PHASES[state.phase]()));
  if (PHASES[state.phase] && !state.journeys.length) items.push(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
  if (state.error) items.push(h('div', { class: 'notice' }, state.error));
  if (state.journeys.length) {
    items.push(segments([['fastest', t('最快', 'Fastest')], ['fewerTransfers', t('少轉車', 'Fewer changes')], ['lessWalking', t('少行路', 'Less walking')]], state.preference, (preference) => {
      state.preference = preference;
      state.journeys = [...state.journeys].sort((a, b) => score(a, preference) - score(b, preference));
      renderSheet();
    }));
  }
  if (state.discovery?.stage === 'choosing') {
    if (state.journeys.length || state.phase !== 'idle') {
      items.push(h('button', { class: 'back', onclick: backToSuggestions }, icon('back', 17), t('返回推薦地點', 'Back to recommendations')));
    } else {
      items.push(suggestionList(state.discovery));
    }
  }
  items.push(state.journeys.map(journeyCard));
  if (!state.routeView && !state.discovery && state.phase === 'idle') items.push(homeSheet());
  return items;
}

function renderBottomStatus() {
  const slot = $('ai-status');
  if (!slot) return;
  const wish = state.discovery?.stage === 'asking' ? state.discovery.wish : null;
  let area = null;
  if (wish) {
    // The AI's own question, or just "where?" when the search couldn't find the rider.
    const question = wish.question ?? t(`想找${wish.want}，要在哪裡找？`, `Where should I look for ${wish.want}?`);
    const options = wish.question ? wish.options : [t('附近', 'Nearby'), '旺角', '銅鑼灣', '尖沙咀', '中環'];
    area = h('div', { class: 'area' },
      h('div', { class: 'row' }, icon('spark', 17), h('span', { class: 'bold grow' }, question),
        h('button', { 'aria-label': t('取消', 'Cancel'), class: 'muted', onclick: () => { state.discovery = null; renderBottomStatus(); renderChatControls(); renderSheet(); } }, icon('close', 17))),
      options.length > 0 && h('div', { class: 'choices' }, options.map((option) => h('button', { onclick: () => answerQuestion(option) }, option))),
      h('div', { class: 'tiny muted' }, t('也可以在下方直接輸入', 'Or type your answer below')));
  }
  clear(slot,
    state.explanation && h('div', { class: 'reply' }, icon('spark', 15), h('span', {}, state.explanation)),
    state.explaining && !state.explanation && h('div', { class: 'status' }, h('span', { class: 'spinner' }), t('AI 整理建議中…', 'AI is summarising…')),
    state.aiNotice && h('div', { class: 'tiny muted' }, state.aiNotice),
    area);
  renderChatControls();
}

function renderPlanBottom() {
  const hasKey = !!client();
  const speechLabels = { 'zh-HK': t('粵語', 'Cantonese'), 'zh-CN': t('普通話', 'Mandarin'), 'en-US': 'English' };
  const speechButton = Recognition && h('button', {
    class: 'lang', onclick: (event) => {
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
      h('span', { class: hasKey ? 'ai' : 'muted' }, icon('spark', 18)),
      h('input', {
        id: 'chat-input', value: state.chat, placeholder: chatPrompt(), enterkeyhint: 'send', autocomplete: 'off',
        oninput: (event) => { state.chat = event.target.value; },
        onfocus: () => renderChatHistory(true),
        onblur: () => setTimeout(() => renderChatHistory(false), 150),
        onkeydown: (event) => { if (event.key === 'Enter') sendChat(); },
      }),
      speechButton,
      Recognition && h('button', { id: 'mic', class: 'icon-button', 'aria-label': t('語音輸入', 'Voice input'), onclick: toggleSpeech }, icon('mic', 20)),
      h('button', { class: 'go', 'aria-label': t('傳送', 'Send'), onclick: sendChat }, icon('send', 19))),
    !hasKey && h('button', { class: 'tiny muted', style: 'text-align:left;padding:0 6px', onclick: () => setTab('settings') }, t('未連接 AI，現時使用基本解析。到設定加入 key', 'AI not connected, using basic parsing. Add a key in Settings')));
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
        oninput: (event) => { state.stopQuery = event.target.value; },
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
    h('button', { class: 'tap', 'aria-expanded': String(isOpen), onclick: () => { state.stopOpen = isOpen ? null : stop.site.id; renderSheet(); } },
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
  if (!state.db) return h('div', { class: 'status' }, h('span', { class: 'spinner' }), t('正在載入站點資料…', 'Loading stops…'));
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
  if (!state.db) return h('div', { class: 'status' }, h('span', { class: 'spinner' }), t('正在載入路線資料…', 'Loading route data…'));
  if (state.routeKey) {
    const route = state.db.routes[state.routeKey], op = route.operators[0];
    return [
      h('button', { class: 'back', onclick: () => { state.routeKey = null; renderSheet(); } }, icon('back', 17), t('返回', 'Back')),
      h('div', { class: 'row' }, badge(op, route.route), h('span', { class: 'bold' }, `${nameText(route.orig, state.lang)} → ${nameText(route.dest, state.lang)}`)),
      route.stops[op].map((id, seq) => stopRow(route, seq, id, op)),
    ];
  }
  const routes = searchRoutes(state.db, state.routeQuery);
  if (!state.routeQuery.trim()) return h('div', { class: 'small muted' }, t('輸入路線號碼，查看沿線站點及到站時間。按星號可收藏常用車站。', 'Type a route number to see its stops and arrivals. Press the star to save a stop.'));
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
      state.sharedAI && h('div', { class: 'small muted' }, t('本站已提供 AI，不用設定就能使用。想用自己的額度才需要填寫 key。', 'AI is included with this site, with nothing to set up. Add a key only to use your own quota.')),
      h('label', { class: 'field plain' }, keyInput),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => { if (keyInput.value.trim()) { store.set('apiKey', keyInput.value.trim()); renderTab(); } } }, t('儲存', 'Save')),
        store.get('apiKey', '') && h('button', { class: 'link', onclick: () => { store.set('apiKey', ''); renderTab(); } }, t('移除', 'Remove'))),
      h('div', { class: 'tiny muted' }, t('你自己的 key 只保存在這部裝置的瀏覽器內，並由瀏覽器直接傳送給 DeepSeek，不經任何其他伺服器。不要在共用裝置上儲存。', 'Your own key stays in this browser and goes straight to DeepSeek, through no other server. Don\'t save it on a shared device.'))),
    h('div', { class: 'card' },
      h('div', { class: 'bold' }, t('私隱', 'Privacy')),
      h('div', { class: 'small muted' }, t(
        '此網站不收集個人資料。收藏及搜尋記錄只保存在你的瀏覽器。到站查詢直接連到各營辦商。使用「附近」找地點時，你的座標會傳送給 OpenStreetMap 的 Photon 服務以確定所在地區。AI 請求及店舖搜尋經本站伺服器轉送給 DeepSeek 及 Google，伺服器不會保存內容。傳送給 DeepSeek 的只有你輸入的文字、地區、站名及路線號碼，不包括座標；Google 地圖會由你的瀏覽器直接載入，並受 Google 私隱政策約束。',
        'This site collects no personal data. Saved stops and history stay in your browser. Arrivals come straight from the operators. When finding places nearby, your coordinates go to OpenStreetMap\'s Photon service to work out your district. AI requests and shop searches pass through this site\'s server to DeepSeek and Google, and the server keeps none of it. DeepSeek only receives your text, the district, stop names and route numbers, never coordinates. Google Maps loads straight into your browser under Google\'s privacy policy.'))),
    h('div', { class: 'card' },
      h('div', { class: 'bold' }, t('安裝到手機', 'Install on your phone')),
      h('div', { class: 'small muted' }, t('iPhone：在 Safari 按分享，再選「加入主畫面」。Android：在 Chrome 選單按「安裝應用程式」。', 'iPhone: in Safari, tap Share, then Add to Home Screen. Android: in the Chrome menu, tap Install app.'))),
    h('div', { class: 'tiny muted' }, t('路線資料來自 hkbus.app；地圖來自 Google、OpenFreeMap 及 OpenStreetMap；地點搜尋來自政府地理資訊及 OpenStreetMap。', 'Route data from hkbus.app; maps from Google, OpenFreeMap and OpenStreetMap; place search from Government GIS and OpenStreetMap.')),
    h('a', { class: 'tiny link', href: 'https://github.com/kevinwentao07-zwt/hktransport', target: '_blank', rel: 'noopener' }, t('GitHub 原始碼（GPL-3.0）', 'Source on GitHub (GPL-3.0)')),
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
      if (event.button !== 0 || !grabber.offsetParent || event.target === document.activeElement) return;
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
  markScene(`${state.tab}|${state.expanded ?? ''}|${state.nav?.id ?? ''}|${state.to?.name ?? ''}|${state.discovery?.stage ?? ''}|${state.stopPlace?.name ?? ''}`);
  mapView.clear();
  const here = state.nav?.here ?? state.fix;
  if (here) mapView.me(here);
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
  if (path) {
    mapView.path(withWalks(path));
    loadWalks(path).then((arrived) => { if (arrived) drawMap(); });
  }
  const choosing = state.discovery?.stage === 'choosing' && !state.journeys.length && state.phase === 'idle';
  if (choosing) mapView.numbered(state.discovery.suggestions, choosePlace);
  mapView.ends(state.from, state.to);
}

function fitPlanMap() {
  const path = selectedPath();
  const points = path ? path.segments.flatMap((s) => s.points) : [state.from?.location, state.to?.location].filter(Boolean);
  if (points.length) mapView.fit(points);
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

function setTab(tab) {
  const direction = tab === 'plan' ? 'back' : 'forward';
  state.tab = tab;
  stagger();
  renderTab();
  slideView(direction);
  sheet.snap(tab === 'plan' || tab === 'stops' ? 'half' : 'full');
  $('sheet').scrollTop = 0;
  if (tab === 'stops' && state.stopPlace) mapView.fit([offset(state.stopPlace.location, state.stopRadius, -1), offset(state.stopPlace.location, state.stopRadius, 1)], 18);
  if (tab === 'plan') {
    if (state.from || state.to) fitPlanMap();
    else mapView.home();
  }
}

new ResizeObserver(() => mapView.resize()).observe($('map'));
new ResizeObserver(() => sheet.measure()).observe($('top'));
new ResizeObserver(() => sheet.measure()).observe($('bottom'));
sheet.attach();

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
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
