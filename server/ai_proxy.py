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
import socket
import sys
import tempfile
import threading
import time
import urllib.error
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


limiter = Limiter(
    per_minute=int(os.environ.get('AI_PER_MINUTE', '12')),
    per_day=int(os.environ.get('AI_PER_DAY', '100')),
    site_per_day=int(os.environ.get('AI_SITE_PER_DAY', '2000')),
)
in_flight = threading.BoundedSemaphore(int(os.environ.get('AI_CONCURRENT', '16')))


# Free each month: 10,000 map loads, 5,000 searches, 10,000 walking routes and 1,000 web searches.
# These stop well short of all four.
budget = Budget(
    Path(os.environ.get('STATE_DIRECTORY', tempfile.gettempdir())) / 'usage.json',
    {'map': (300, 9000, 15), 'places': (150, 4500, 30), 'walk': (300, 9000, 40), 'web': (30, 900, 10)},
)


def api_key():
    return os.environ.get('DEEPSEEK_API_KEY', '').strip()


def map_key():
    return os.environ.get('GOOGLE_MAP_KEY', '').strip()


def places_key():
    return os.environ.get('GOOGLE_PLACES_KEY', '').strip()


def routes_key():
    return os.environ.get('GOOGLE_ROUTES_KEY', '').strip() or places_key()


def search_key():
    return os.environ.get('TAVILY_API_KEY', '').strip()


def ask_deepseek(system, message):
    """Returns the answer. Errors carry no upstream text, which could quote part of the key."""
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
        return json.load(response)['choices'][0]['message']['content'].strip()


def search_places(query, lat, lng, radius, language):
    """Asks only for the fields in the cheapest tier that has names, and for one page."""
    request = urllib.request.Request(
        'https://places.googleapis.com/v1/places:searchText',
        data=json.dumps({
            'textQuery': query, 'languageCode': language, 'regionCode': 'HK', 'pageSize': 5,
            'locationBias': {'circle': {'center': {'latitude': lat, 'longitude': lng}, 'radius': radius}},
        }).encode(),
        headers={
            'Content-Type': 'application/json', 'X-Goog-Api-Key': places_key(),
            'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location',
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        found = json.load(response).get('places', [])
    return [{
        'id': place['id'], 'name': place['displayName']['text'], 'address': place.get('formattedAddress'),
        'location': {'lat': place['location']['latitude'], 'lng': place['location']['longitude']},
    } for place in found]


def search_web(query):
    """The basic search costs one credit. Long pages are cut to what fits one AI request."""
    request = urllib.request.Request(
        'https://api.tavily.com/search',
        data=json.dumps({'query': query, 'search_depth': 'basic', 'max_results': 6}).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {search_key()}'},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        found = json.load(response).get('results', [])
    return [{'title': item.get('title', '')[:120], 'url': item.get('url', ''), 'content': item.get('content', '')[:450]} for item in found]


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
        body = {'available': bool(api_key()), 'mapKey': None, 'places': False, 'web': bool(search_key())}
        # Handing out the key is what starts a billed map load, so this is where it is counted.
        # Only the page itself asks this way, and Google locks the key to this site.
        if map_key() and self.headers.get('Sec-Fetch-Site') == 'same-origin' and budget.spend('map', self.visitor()):
            body.update(mapKey=map_key(), places=bool(places_key()))
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
        if self.path not in ('/api/ai', '/api/places', '/api/walk', '/api/web'):
            return self.send(404, {'error': 'Not found'})
        body = self.read_json()
        if body is None:
            return None
        return {'/api/places': self.places, '/api/walk': self.walk, '/api/web': self.web}.get(self.path, self.ask)(body)

    def web(self, body):
        query = body.get('query')
        if not isinstance(query, str) or not 0 < len(query.strip()) <= 100:
            return self.send(400, {'error': 'Bad request'})
        if not search_key() or not budget.spend('web', self.visitor()):
            return self.send(429, {'error': 'Limit reached'})
        try:
            self.send(200, {'results': search_web(query.strip())})
        except urllib.error.HTTPError as error:
            print(f'Web search returned {error.code}', file=sys.stderr, flush=True)
            self.send(502, {'error': 'Unavailable'})
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
            print(f'Web search failed: {type(error).__name__}', file=sys.stderr, flush=True)
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
        if not places_key() or not budget.spend('places', self.visitor()):
            return self.send(429, {'error': 'Limit reached'})
        language = 'en' if body.get('lang') == 'en' else 'zh-HK'
        try:
            self.send(200, {'places': search_places(query.strip(), lat, lng, radius, language)})
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
        if not limiter.allow(self.visitor()):
            return self.send(429, {'error': 'AI 使用次數已達上限，請稍後再試'})
        if not in_flight.acquire(blocking=False):
            return self.send(503, {'error': 'AI 正忙，請稍後再試'})
        try:
            self.send(200, {'reply': ask_deepseek(system, message)})
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
