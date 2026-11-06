#!/usr/bin/env python3
"""Calls DeepSeek for the web app, so the API key never reaches a browser.

Visitors can only pick one of the app's own tasks and send their text. The prompts live
here, so this can't be used as a free general-purpose chatbot, and limits cap the cost.
Nothing a visitor sends is logged or kept.

It also holds Google use under the free allowance. Each map and place search is counted on
disk, and at the limit the site quietly goes back to its free map and search.
"""
import json
import os
import re
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Google limits the places key to the server's IPv4 address, so IPv6 routes would be refused.
_lookup = socket.getaddrinfo
socket.getaddrinfo = lambda host, port, family=0, *rest, **options: _lookup(host, port, socket.AF_INET, *rest, **options)

PORT = int(os.environ.get('AI_PORT', '8787'))
MODEL = os.environ.get('AI_MODEL', 'deepseek-flash')
MAX_BODY = 32 * 1024
MAX_MESSAGE = 4000
MAX_TOKENS = 2000
PROMPTS = json.loads((Path(__file__).parent / 'prompts.json').read_text('utf-8'))


class Limiter:
    """Per-visitor limits, plus a daily cap for the whole site."""

    def __init__(self, per_minute, per_day, site_per_day, clock=time.time):
        self.per_minute, self.per_day, self.site_per_day, self.clock = per_minute, per_day, site_per_day, clock
        self.lock = threading.Lock()
        self.day, self.total, self.recent, self.today = None, 0, {}, {}

    def allow(self, visitor):
        with self.lock:
            now = self.clock()
            day = int(now // 86400)
            if day != self.day:
                self.day, self.total, self.recent, self.today = day, 0, {}, {}
            recent = [moment for moment in self.recent.get(visitor, []) if now - moment < 60]
            self.recent[visitor] = recent
            if (self.total >= self.site_per_day or len(recent) >= self.per_minute
                    or self.today.get(visitor, 0) >= self.per_day):
                return False
            recent.append(now)
            self.today[visitor] = self.today.get(visitor, 0) + 1
            self.total += 1
            return True


class Budget:
    """Daily and monthly allowances that survive restarts. Unsure means no."""

    def __init__(self, path, limits, clock=time.time):
        self.path, self.limits, self.clock = Path(path), limits, clock
        self.lock = threading.Lock()
        self.visitors, self.visitors_day, self.broken = {}, None, False
        try:
            self.usage = json.loads(self.path.read_text())
        except FileNotFoundError:
            self.usage = {}
        except (OSError, ValueError):
            self.usage, self.broken = {}, True

    def spend(self, name, visitor):
        per_day, per_month, per_visitor = self.limits[name]
        with self.lock:
            if self.broken:
                return False
            # Google's billing runs on Pacific time.
            moment = time.gmtime(self.clock() - 8 * 3600)
            day, month = time.strftime('%Y-%m-%d', moment), time.strftime('%Y-%m', moment)
            if day != self.visitors_day:
                self.visitors, self.visitors_day = {}, day
            used = self.usage.setdefault(name, {})
            today = used.get('today', 0) if used.get('day') == day else 0
            this_month = used.get('this_month', 0) if used.get('month') == month else 0
            mine = self.visitors.get((name, visitor), 0)
            if today >= per_day or this_month >= per_month or mine >= per_visitor:
                return False
            used.update(day=day, month=month, today=today + 1, this_month=this_month + 1)
            try:
                scratch = self.path.with_suffix('.tmp')
                scratch.write_text(json.dumps(self.usage))
                os.replace(scratch, self.path)
            except OSError:
                self.broken = True
                return False
            self.visitors[(name, visitor)] = mine + 1
            return True


# deepseek-flash, in yuan per million tokens. Peak prices, so the real charge is never higher.
PRICE_CACHED, PRICE_INPUT, PRICE_OUTPUT = 0.04, 2, 8
DAILY_YUAN_PER_VISITOR, DAILY_YUAN_SITE = 0.1, 1


def cost_of(usage):
    """What a reply cost in yuan, from the tokens DeepSeek says it used."""
    cached = usage.get('prompt_cache_hit_tokens', 0)
    fresh = usage.get('prompt_cache_miss_tokens', usage.get('prompt_tokens', 0) - cached)
    return (cached * PRICE_CACHED + fresh * PRICE_INPUT + usage.get('completion_tokens', 0) * PRICE_OUTPUT) / 1_000_000


class Spending:
    """A day's DeepSeek money, Beijing time, split evenly among whoever uses it.

    The site's total is kept on disk so a restart can't reset it. What each visitor spent stays in
    memory, as addresses are never stored. Unsure means no.
    """

    def __init__(self, path, per_visitor, site, clock=time.time):
        self.path, self.per_visitor, self.site, self.clock = Path(path), per_visitor, site, clock
        self.lock = threading.Lock()
        self.spent, self.broken = {}, False
        try:
            saved = json.loads(self.path.read_text())
            self.day, self.total = saved['day'], float(saved['total'])
        except FileNotFoundError:
            self.day, self.total = None, 0.0
        except (OSError, ValueError, KeyError, TypeError):
            self.day, self.total, self.broken = None, 0.0, True

    def roll_over(self):
        day = int((self.clock() + 8 * 3600) // 86400)
        if day != self.day:
            self.day, self.total, self.spent = day, 0.0, {}

    def share(self, visitor):
        """One visitor's part of the day: an even split, but never above the most anyone may use."""
        return min(self.per_visitor, self.site / len({*self.spent, visitor}))

    def allows(self, visitor):
        with self.lock:
            self.roll_over()
            return not self.broken and self.total < self.site and self.spent.get(visitor, 0) < self.share(visitor)

    def add(self, visitor, yuan):
        with self.lock:
            self.roll_over()
            self.spent[visitor] = self.spent.get(visitor, 0) + yuan
            self.total += yuan
            try:
                scratch = self.path.with_suffix('.tmp')
                scratch.write_text(json.dumps({'day': self.day, 'total': self.total}))
                os.replace(scratch, self.path)
            except OSError:
                self.broken = True


limiter = Limiter(
    per_minute=int(os.environ.get('AI_PER_MINUTE', '12')),
    per_day=int(os.environ.get('AI_PER_DAY', '100')),
    site_per_day=int(os.environ.get('AI_SITE_PER_DAY', '2000')),
)
in_flight = threading.BoundedSemaphore(int(os.environ.get('AI_CONCURRENT', '16')))


spending = Spending(
    Path(os.environ.get('STATE_DIRECTORY', tempfile.gettempdir())) / 'spending.json',
    DAILY_YUAN_PER_VISITOR, DAILY_YUAN_SITE,
)

# Free each month: 10,000 map loads, 5,000 searches, 1,000 searches with shop details, 10,000 walking
# routes, 10,000 suggestions and 10,000 place lookups. These stop well short of all six.
budget = Budget(
    Path(os.environ.get('STATE_DIRECTORY', tempfile.gettempdir())) / 'usage.json',
    {'map': (300, 9000, 15), 'places': (150, 4500, 30), 'walk': (300, 9000, 40), 'details': (30, 900, 12), 'suggest': (300, 9000, 60), 'place': (300, 9000, 60)},
)


def api_key():
    return os.environ.get('DEEPSEEK_API_KEY', '').strip()


def map_key():
    return os.environ.get('GOOGLE_MAP_KEY', '').strip()


def embed_key():
    return os.environ.get('GOOGLE_EMBED_KEY', '').strip()


def places_key():
    return os.environ.get('GOOGLE_PLACES_KEY', '').strip()


def routes_key():
    return os.environ.get('GOOGLE_ROUTES_KEY', '').strip() or places_key()


def ask_deepseek(system, message):
    """Returns the answer and its token use. Errors carry no upstream text, which could quote the key."""
    request = urllib.request.Request(
        'https://api.deepseek.com/chat/completions',
        data=json.dumps({
            'model': MODEL, 'temperature': 0.2, 'max_tokens': MAX_TOKENS, 'stream': False,
            'thinking': {'type': 'disabled'},
            'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': message}],
        }).encode(),
        headers={'Authorization': f'Bearer {api_key()}', 'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(request, timeout=55) as response:
        reply = json.load(response)
    return reply['choices'][0]['message']['content'].strip(), reply.get('usage', {})


BASIC_FIELDS = 'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.primaryTypeDisplayName,places.businessStatus'
# These move a search into Google's dearest tier, with a far smaller free allowance.
SHOP_FIELDS = 'places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours.openNow,places.nationalPhoneNumber'


def search_places(query, lat, lng, radius, language, details=False):
    """Google charges per request, not per place, so one page takes as many as it can."""
    request = urllib.request.Request(
        'https://places.googleapis.com/v1/places:searchText',
        data=json.dumps({
            'textQuery': query, 'languageCode': language, 'regionCode': 'HK', 'pageSize': 20,
            'locationBias': {'circle': {'center': {'latitude': lat, 'longitude': lng}, 'radius': radius}},
        }).encode(),
        headers={
            'Content-Type': 'application/json', 'X-Goog-Api-Key': places_key(),
            'X-Goog-FieldMask': f'{BASIC_FIELDS},{SHOP_FIELDS}' if details else BASIC_FIELDS,
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        found = json.load(response).get('places', [])
    return [{
        'id': place['id'], 'name': place['displayName']['text'], 'address': place.get('formattedAddress'),
        'location': {'lat': place['location']['latitude'], 'lng': place['location']['longitude']},
        'mapsUrl': place.get('googleMapsUri'), 'kind': place.get('primaryTypeDisplayName', {}).get('text'),
        'status': place.get('businessStatus'), 'rating': place.get('rating'), 'ratings': place.get('userRatingCount'),
        'price': place.get('priceLevel'), 'open': place.get('currentOpeningHours', {}).get('openNow'),
        'phone': place.get('nationalPhoneNumber'),
    } for place in found]


def suggest_places(query, origin, language):
    """Names as the rider types. With a position, Google also says how far each one is."""
    body = {'input': query, 'languageCode': language, 'regionCode': 'hk', 'includedRegionCodes': ['hk']}
    if origin:
        point = {'latitude': origin['lat'], 'longitude': origin['lng']}
        body.update(origin=point, locationBias={'circle': {'center': point, 'radius': 5000}})
    request = urllib.request.Request(
        'https://places.googleapis.com/v1/places:autocomplete',
        data=json.dumps(body).encode(),
        headers={
            'Content-Type': 'application/json', 'X-Goog-Api-Key': places_key(),
            'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.distanceMeters',
        },
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        found = json.load(response).get('suggestions', [])
    places = [item['placePrediction'] for item in found if 'placePrediction' in item]
    return [{
        'id': place['placeId'], 'name': place['structuredFormat']['mainText']['text'],
        'address': place['structuredFormat'].get('secondaryText', {}).get('text'), 'meters': place.get('distanceMeters'),
    } for place in places]


def place_location(place_id):
    """Where a suggested place is, as it was only named."""
    request = urllib.request.Request(
        f"https://places.googleapis.com/v1/places/{urllib.parse.quote(place_id, safe='')}",
        headers={'X-Goog-Api-Key': places_key(), 'X-Goog-FieldMask': 'location'},
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        location = json.load(response)['location']
    return {'lat': location['latitude'], 'lng': location['longitude']}


def decode_polyline(encoded):
    """Google's compact line format, as a list of points."""
    points, index, lat, lng = [], 0, 0, 0
    while index < len(encoded):
        values = []
        for _ in range(2):
            shift = result = 0
            while True:
                byte = ord(encoded[index]) - 63
                index += 1
                result |= (byte & 0x1F) << shift
                shift += 5
                if byte < 0x20:
                    break
            values.append(~(result >> 1) if result & 1 else result >> 1)
        lat, lng = lat + values[0], lng + values[1]
        points.append({'lat': lat / 1e5, 'lng': lng / 1e5})
    return points


def walking_route(start, end):
    """Asks only for the line, which keeps this in the cheapest tier."""
    place = lambda point: {'location': {'latLng': {'latitude': point['lat'], 'longitude': point['lng']}}}
    request = urllib.request.Request(
        'https://routes.googleapis.com/directions/v2:computeRoutes',
        data=json.dumps({'origin': place(start), 'destination': place(end), 'travelMode': 'WALK'}).encode(),
        headers={
            'Content-Type': 'application/json', 'X-Goog-Api-Key': routes_key(),
            'X-Goog-FieldMask': 'routes.polyline.encodedPolyline',
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return decode_polyline(json.load(response)['routes'][0]['polyline']['encodedPolyline'])


def in_hong_kong(point):
    if not isinstance(point, dict):
        return False
    lat, lng = point.get('lat'), point.get('lng')
    numbers = all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in (lat, lng))
    return numbers and 22.1 <= lat <= 22.6 and 113.8 <= lng <= 114.5


class Handler(BaseHTTPRequestHandler):
    server_version = 'hktransport'
    sys_version = ''
    timeout = 20

    def log_message(self, format, *args):
        pass

    def send(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def visitor(self):
        # Caddy replaces this header, so the last address is the one that connected.
        return self.headers.get('X-Forwarded-For', '').split(',')[-1].strip() or self.client_address[0]

    def do_GET(self):
        if self.path != '/api/ai':
            return self.send(404, {'error': 'Not found'})
        body = {'available': bool(api_key()), 'mapKey': None, 'places': False}
        # Handing out the key is what starts a billed map load, so this is where it is counted.
        # Only the page itself asks this way, and Google locks the key to this site.
        is_page = self.headers.get('Sec-Fetch-Site') == 'same-origin'
        if map_key() and is_page and budget.spend('map', self.visitor()):
            body.update(mapKey=map_key(), places=bool(places_key()))
        # Embedded maps are free and unlimited, so shops stay on a Google map once the loads run out.
        # This key opens nothing else, which keeps it from being a way around the limit above.
        if embed_key() and places_key() and is_page:
            body.update(embedKey=embed_key(), places=True)
        self.send(200, body)

    def read_json(self):
        """The request body, or None once an error has been sent."""
        # Keeps other websites from spending the quota through their visitors' browsers.
        if self.headers.get('Origin') != f"https://{self.headers.get('Host')}":
            self.send(403, {'error': 'Forbidden'})
            return None
        try:
            length = int(self.headers.get('Content-Length', ''))
        except ValueError:
            self.send(411, {'error': 'Length required'})
            return None
        if not 0 < length <= MAX_BODY:
            self.send(413, {'error': 'Too large'})
            return None
        try:
            body = json.loads(self.rfile.read(length))
        except ValueError:
            body = None
        if not isinstance(body, dict):
            self.send(400, {'error': 'Bad request'})
            return None
        return body

    def do_POST(self):
        if self.path not in ('/api/ai', '/api/places', '/api/walk', '/api/suggest', '/api/place'):
            return self.send(404, {'error': 'Not found'})
        body = self.read_json()
        if body is None:
            return None
        return {'/api/places': self.places, '/api/walk': self.walk, '/api/suggest': self.suggest, '/api/place': self.place}.get(self.path, self.ask)(body)

    def suggest(self, body):
        query, origin = body.get('query'), body.get('from')
        if not isinstance(query, str) or not 0 < len(query.strip()) <= 60 or (origin is not None and not in_hong_kong(origin)):
            return self.send(400, {'error': 'Bad request'})
        if not places_key() or not budget.spend('suggest', self.visitor()):
            return self.send(429, {'error': 'Limit reached'})
        language = 'en' if body.get('lang') == 'en' else 'zh-HK'
        try:
            self.send(200, {'places': suggest_places(query.strip(), origin, language)})
        except urllib.error.HTTPError as error:
            print(f'Suggestions returned {error.code}', file=sys.stderr, flush=True)
            self.send(502, {'error': 'Unavailable'})
        except (OSError, ValueError, KeyError, TypeError) as error:
            print(f'Suggestions failed: {type(error).__name__}', file=sys.stderr, flush=True)
            self.send(502, {'error': 'Unavailable'})

    def place(self, body):
        place_id = body.get('id')
        if not isinstance(place_id, str) or not re.fullmatch(r'[\w-]{1,512}', place_id):
            return self.send(400, {'error': 'Bad request'})
        if not places_key() or not budget.spend('place', self.visitor()):
            return self.send(429, {'error': 'Limit reached'})
        try:
            self.send(200, {'location': place_location(place_id)})
        except urllib.error.HTTPError as error:
            print(f'Place returned {error.code}', file=sys.stderr, flush=True)
            self.send(502, {'error': 'Unavailable'})
        except (OSError, ValueError, KeyError, TypeError) as error:
            print(f'Place failed: {type(error).__name__}', file=sys.stderr, flush=True)
            self.send(502, {'error': 'Unavailable'})

    def walk(self, body):
        start, end = body.get('from'), body.get('to')
        if not in_hong_kong(start) or not in_hong_kong(end):
            return self.send(400, {'error': 'Bad request'})
        if not routes_key() or not budget.spend('walk', self.visitor()):
            return self.send(429, {'error': 'Limit reached'})
        try:
            self.send(200, {'points': walking_route(start, end)})
        except urllib.error.HTTPError as error:
            print(f'Routes returned {error.code}', file=sys.stderr, flush=True)
            self.send(502, {'error': 'Unavailable'})
        except (OSError, ValueError, KeyError, IndexError, TypeError) as error:
            print(f'Routes failed: {type(error).__name__}', file=sys.stderr, flush=True)
            self.send(502, {'error': 'Unavailable'})

    def places(self, body):
        query, lat, lng, radius = body.get('query'), body.get('lat'), body.get('lng'), body.get('radius')
        numbers = all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in (lat, lng, radius))
        if not isinstance(query, str) or not 0 < len(query.strip()) <= 100 or not numbers:
            return self.send(400, {'error': 'Bad request'})
        if not (22.1 <= lat <= 22.6 and 113.8 <= lng <= 114.5 and 0 < radius <= 50000):
            return self.send(400, {'error': 'Bad request'})
        # Shop details have their own allowance. Past it, a search still works without them.
        details = bool(places_key()) and body.get('details') is True and budget.spend('details', self.visitor())
        if not places_key() or not (details or budget.spend('places', self.visitor())):
            return self.send(429, {'error': 'Limit reached'})
        language = 'en' if body.get('lang') == 'en' else 'zh-HK'
        try:
            self.send(200, {'places': search_places(query.strip(), lat, lng, radius, language, details)})
        except urllib.error.HTTPError as error:
            print(f'Places returned {error.code}', file=sys.stderr, flush=True)
            self.send(502, {'error': 'Unavailable'})
        except (OSError, ValueError, KeyError, TypeError) as error:
            print(f'Places failed: {type(error).__name__}', file=sys.stderr, flush=True)
            self.send(502, {'error': 'Unavailable'})

    def ask(self, body):
        try:
            system, message = PROMPTS[body['task']], body['message']
        except (KeyError, TypeError):
            return self.send(400, {'error': 'Bad request'})
        if not isinstance(message, str) or not message.strip() or len(message) > MAX_MESSAGE:
            return self.send(400, {'error': 'Bad request'})
        if not api_key():
            return self.send(503, {'error': 'AI 未設定'})
        if not spending.allows(self.visitor()) or not limiter.allow(self.visitor()):
            return self.send(429, {'error': 'AI 使用次數已達上限，請稍後再試'})
        if not in_flight.acquire(blocking=False):
            return self.send(503, {'error': 'AI 正忙，請稍後再試'})
        try:
            answer, usage = ask_deepseek(system, message)
            spending.add(self.visitor(), cost_of(usage))
            self.send(200, {'reply': answer})
        except urllib.error.HTTPError as error:
            print(f'DeepSeek returned {error.code}', file=sys.stderr, flush=True)
            self.send(502, {'error': 'AI 暫時未能使用'})
        except (OSError, ValueError, KeyError, IndexError, TypeError, AttributeError) as error:
            print(f'DeepSeek failed: {type(error).__name__}', file=sys.stderr, flush=True)
            self.send(502, {'error': 'AI 暫時未能使用'})
        finally:
            in_flight.release()


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
