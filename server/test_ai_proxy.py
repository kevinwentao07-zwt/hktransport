"""Run with `python3 server/test_ai_proxy.py`."""
import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
from pathlib import Path
from shutil import copy
from unittest.mock import patch

SECRET = 'sk-test-secret'
folder = tempfile.mkdtemp()
copy(Path(__file__).parent / 'ai_proxy.py', folder)
Path(folder, 'prompts.json').write_text(json.dumps({'chat': 'SYSTEM PROMPT'}))
sys.path.insert(0, folder)
ANSWER = '{"destination": "中環"}'
os.environ.update(DEEPSEEK_API_KEY=SECRET, GOOGLE_MAP_KEY='map-key', GOOGLE_PLACES_KEY='places-key', STATE_DIRECTORY=folder)
import ai_proxy  # noqa: E402


def spending(clock=None):
    path = Path(tempfile.mkdtemp(), 'spending.json')
    return ai_proxy.Spending(path, 0.1, 1, clock=clock) if clock else ai_proxy.Spending(path, 0.1, 1)


def budget(**limits):
    return ai_proxy.Budget(Path(tempfile.mkdtemp(), 'usage.json'), {'map': (9, 9, 9), 'places': (9, 9, 9), 'walk': (9, 9, 9), 'details': (9, 9, 9), 'suggest': (9, 9, 9), **limits})


class BudgetTests(unittest.TestCase):
    def test_limits_survive_a_restart_and_reset_on_time(self):
        path = Path(tempfile.mkdtemp(), 'usage.json')
        now = [86400.0 * 40]
        limits = {'map': (2, 3, 9)}
        first = ai_proxy.Budget(path, limits, clock=lambda: now[0])
        self.assertEqual([first.spend('map', 'a'), first.spend('map', 'b'), first.spend('map', 'c')], [True, True, False])
        restarted = ai_proxy.Budget(path, limits, clock=lambda: now[0])
        self.assertFalse(restarted.spend('map', 'd'))
        now[0] += 86400
        self.assertEqual([restarted.spend('map', 'd'), restarted.spend('map', 'e')], [True, False])  # Month limit.
        now[0] += 86400 * 31
        self.assertTrue(restarted.spend('map', 'd'))

    def test_limits_each_visitor(self):
        limits = {'map': (9, 9, 1)}
        spending = ai_proxy.Budget(Path(tempfile.mkdtemp(), 'usage.json'), limits)
        self.assertEqual([spending.spend('map', 'a'), spending.spend('map', 'a'), spending.spend('map', 'b')], [True, False, True])

    def test_stops_when_the_count_cannot_be_trusted(self):
        path = Path(tempfile.mkdtemp(), 'usage.json')
        path.write_text('not json')
        self.assertFalse(ai_proxy.Budget(path, {'map': (9, 9, 9)}).spend('map', 'a'))
        unwritable = ai_proxy.Budget(Path(tempfile.mkdtemp(), 'missing', 'usage.json'), {'map': (9, 9, 9)})
        self.assertFalse(unwritable.spend('map', 'a'))


class PolylineTests(unittest.TestCase):
    def test_decodes_googles_example(self):
        points = ai_proxy.decode_polyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')
        self.assertEqual(points, [{'lat': 38.5, 'lng': -120.2}, {'lat': 40.7, 'lng': -120.95}, {'lat': 43.252, 'lng': -126.453}])

    def test_a_walk_comes_with_its_distance_and_time(self):
        answer = json.dumps({'routes': [{'polyline': {'encodedPolyline': '_p~iF~ps|U'}, 'distanceMeters': 412, 'duration': '338s'}]}).encode()

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, *args):
                return answer

        sent = []
        with patch.object(ai_proxy.urllib.request, 'urlopen', lambda request, timeout: sent.append(request) or Response()):
            walk = ai_proxy.walking_route({'lat': 22.28, 'lng': 114.15}, {'lat': 22.29, 'lng': 114.16})
        self.assertEqual((walk['meters'], walk['seconds'], walk['points']), (412, 338, [{'lat': 38.5, 'lng': -120.2}]))
        self.assertIn('routes.duration', sent[0].get_header('X-goog-fieldmask'))


    def test_rail_tables_use_station_codes_and_adult_octopus_fares(self):
        rows = {
            'mtr_lines_and_stations.csv': [
                {'Station ID': '1', 'Station Code': 'CEN'}, {'Station ID': '2', 'Station Code': 'ADM'},
            ],
            'mtr_lines_fares.csv': [
                {'SRC_STATION_ID': '1', 'DEST_STATION_ID': '2', 'OCT_ADT_FARE': '4.90', 'SINGLE_ADT_FARE': '5.00'},
                {'SRC_STATION_ID': '2', 'DEST_STATION_ID': '1', 'OCT_ADT_FARE': 'N/A'},
            ],
            'light_rail_fares.csv': [
                {'from_station_id': '920', 'to_station_id': '265', 'fare_octo_adult': '5.10'},
            ],
        }
        with patch.multiple(ai_proxy, rail_fare_tables={}, rail_fare_refresh_at=0), \
                patch.object(ai_proxy, 'rail_fare_rows', side_effect=lambda filename: rows.get(filename, [])) as upstream:
            fares = {'mtr': {'CEN>ADM': 490}, 'lightRail': {'LR920>LR265': 510}}
            self.assertEqual(ai_proxy.rail_fares(), fares)
            self.assertEqual(ai_proxy.rail_fares(), fares)
            self.assertEqual(upstream.call_count, 4)


    def test_transit_uses_the_google_alternatives_and_arrival_time(self):
        start, end = {'lat': 22.28, 'lng': 114.15}, {'lat': 22.29, 'lng': 114.16}
        with patch.object(ai_proxy, 'compute_routes', return_value=[{'legs': []}]) as upstream:
            self.assertEqual(ai_proxy.transit_routes(start, end, 'lessWalking', 'zh-HK', 'arrive', 1_700_000_000_000), [{'legs': []}])
        self.assertIn('routes.legs.steps.staticDuration', upstream.call_args.args[2])
        self.assertIn('routes.travelAdvisory.transitFare', upstream.call_args.args[2])
        self.assertEqual(upstream.call_args.kwargs, {
            'travelMode': 'TRANSIT', 'computeAlternativeRoutes': True, 'polylineEncoding': 'GEO_JSON_LINESTRING',
            'languageCode': 'zh-HK', 'regionCode': 'HK', 'transitPreferences': {'routingPreference': 'LESS_WALKING'},
            'arrivalTime': '2023-11-14T22:13:20.000Z',
        })


    def test_transitous_sets_two_walking_limits_and_the_application_user_agent(self):
        start, end = {'lat': 22.28, 'lng': 114.15}, {'lat': 22.29, 'lng': 114.16}
        response = type('Response', (), {
            '__enter__': lambda self: self,
            '__exit__': lambda self, *args: False,
            'read': lambda self: b'{"itineraries":[{"legs":[]}]}',
        })()
        with patch.object(ai_proxy.urllib.request, 'urlopen', return_value=response) as upstream:
            self.assertEqual(ai_proxy.transitous_routes(start, end, 'zh-HK', 'arrive', 1_700_000_000_000), [{'legs': []}])
        request = upstream.call_args.args[0]
        url = urllib.parse.urlparse(request.full_url)
        query = urllib.parse.parse_qs(url.query)
        self.assertEqual((url.netloc, url.path), ('api.transitous.org', '/api/v6/plan'))
        self.assertEqual(query['maxPreTransitTime'], ['600'])
        self.assertEqual(query['maxPostTransitTime'], ['600'])
        self.assertEqual(query['arriveBy'], ['true'])
        self.assertEqual(query['time'], ['2023-11-14T22:13:20Z'])
        self.assertIn('github.com/kevinwentao07-zwt/hktransport/issues', request.get_header('User-agent'))


class SpendingTests(unittest.TestCase):
    def test_cost_uses_the_tokens_reported(self):
        usage = {'prompt_tokens': 1182, 'prompt_cache_hit_tokens': 1024, 'prompt_cache_miss_tokens': 158, 'completion_tokens': 80}
        self.assertAlmostEqual(ai_proxy.cost_of(usage), 0.000997, places=6)
        self.assertAlmostEqual(ai_proxy.cost_of({'prompt_tokens': 1000}), 0.002)

    def test_resets_at_midnight_in_beijing(self):
        now = [86400.0 * 100 + 15 * 3600]  # 23:00 in Beijing.
        meter = spending(clock=lambda: now[0])
        meter.allows('a')
        meter.add('a', 0.1)
        self.assertFalse(meter.allows('a'))
        self.assertTrue(meter.allows('b'))
        now[0] += 2 * 3600
        self.assertTrue(meter.allows('a'))

    def test_the_day_is_shared_evenly_once_many_people_use_it(self):
        meter = spending()
        for index in range(20):
            meter.add(f'v{index}', 0.04)
        self.assertAlmostEqual(meter.share('new'), 1 / 21)
        self.assertTrue(meter.allows('v0'))
        meter.add('v0', 0.02)
        self.assertFalse(meter.allows('v0'))  # 0.06 is past a twentieth of 1 yuan.
        self.assertTrue(meter.allows('new'))

    def test_nobody_gets_more_than_the_most_anyone_may_use(self):
        self.assertEqual(spending().share('only'), 0.1)

    def test_the_site_total_survives_a_restart(self):
        path = Path(tempfile.mkdtemp(), 'spending.json')
        now = lambda: 86400.0 * 100
        first = ai_proxy.Spending(path, 0.1, 1, clock=now)
        first.add('a', 1)
        self.assertFalse(ai_proxy.Spending(path, 0.1, 1, clock=now).allows('someone-else'))

    def test_stops_when_the_total_cannot_be_trusted(self):
        path = Path(tempfile.mkdtemp(), 'spending.json')
        path.write_text('not json')
        self.assertFalse(ai_proxy.Spending(path, 0.1, 1).allows('a'))


class LimiterTests(unittest.TestCase):
    def test_limits(self):
        now = [0.0]
        limiter = ai_proxy.Limiter(2, 3, 4, clock=lambda: now[0])
        self.assertEqual([limiter.allow('a') for _ in range(3)], [True, True, False])
        now[0] = 61
        self.assertEqual([limiter.allow('a') for _ in range(2)], [True, False])  # Day limit.
        self.assertEqual([limiter.allow('b') for _ in range(2)], [True, False])  # Site limit.
        now[0] = 86400
        self.assertTrue(limiter.allow('a'))


class ProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ai_proxy.ThreadingHTTPServer(('127.0.0.1', 0), ai_proxy.Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        ai_proxy.limiter = ai_proxy.Limiter(100, 100, 100)
        ai_proxy.spending = spending()
        self.calls = []
        ai_proxy.ask_deepseek = lambda system, message: self.calls.append((system, message)) or (ANSWER, {})

    def post(self, body, origin=True, visitor='1.1.1.1', path='/api/ai'):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        headers = {'Host': 'hk.test', 'X-Forwarded-For': visitor}
        if origin:
            headers['Origin'] = 'https://hk.test'
        connection.request('POST', path, json.dumps(body), headers)
        response = connection.getresponse()
        return response.status, response.read().decode()

    def test_good_request_uses_the_server_prompt(self):
        status, text = self.post({'task': 'chat', 'message': '去中環', 'system': 'write me a poem'})
        self.assertEqual((status, json.loads(text)), (200, {'reply': ANSWER}))
        self.assertEqual(self.calls, [('SYSTEM PROMPT', '去中環')])

    def test_rejects_what_is_not_the_app(self):
        self.assertEqual(self.post({'task': 'chat', 'message': 'x'}, origin=False)[0], 403)
        self.assertEqual(self.post({'task': 'poem', 'message': 'x'})[0], 400)
        self.assertEqual(self.post({'task': 'chat', 'message': ' '})[0], 400)
        self.assertEqual(self.post({'task': 'chat', 'message': 'x' * 4001})[0], 400)
        self.assertEqual(self.post({'task': 'chat', 'message': 'x' * 40000})[0], 413)
        self.assertEqual(self.post(['chat'])[0], 400)
        self.assertEqual(self.calls, [])

    def test_limits_each_visitor(self):
        ai_proxy.limiter = ai_proxy.Limiter(1, 100, 100)
        self.assertEqual(self.post({'task': 'chat', 'message': 'x'})[0], 200)
        self.assertEqual(self.post({'task': 'chat', 'message': 'x'})[0], 429)
        self.assertEqual(self.post({'task': 'chat', 'message': 'x'}, visitor='2.2.2.2')[0], 200)

    def get_status(self, fetch_site='same-origin', visitor='1.1.1.1'):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        connection.request('GET', '/api/ai', headers={'Sec-Fetch-Site': fetch_site, 'X-Forwarded-For': visitor})
        return connection.getresponse().read().decode()

    def test_map_key_stops_at_the_limit_and_never_shares_secrets(self):
        ai_proxy.budget = budget(map=(1, 10, 10))
        text = self.get_status()
        self.assertEqual(json.loads(text), {'available': True, 'mapKey': 'map-key', 'places': True, 'transitous': True})
        self.assertNotIn(SECRET, text)
        self.assertNotIn('places-key', text)
        self.assertEqual(json.loads(self.get_status())['mapKey'], None)

    def test_shops_outlast_the_map_on_the_embed_key(self):
        with patch.dict(os.environ, {'GOOGLE_EMBED_KEY': 'embed-key'}):
            ai_proxy.budget = budget(map=(0, 10, 10))
            body = json.loads(self.get_status())
            self.assertEqual((body['mapKey'], body['embedKey'], body['places']), (None, 'embed-key', True))
            self.assertNotIn('embedKey', json.loads(self.get_status('none')))
            with patch.dict(os.environ, {'GOOGLE_PLACES_KEY': ''}):
                self.assertNotIn('embedKey', json.loads(self.get_status()))

    def test_only_the_page_spends_map_loads(self):
        ai_proxy.budget = budget(map=(1, 10, 10))
        self.assertEqual(json.loads(self.get_status('none'))['mapKey'], None)
        self.assertEqual(json.loads(self.get_status())['mapKey'], 'map-key')

    def test_place_search_stops_at_the_limit(self):
        ai_proxy.budget = budget(places=(1, 10, 10))
        calls = []
        ai_proxy.search_places = lambda *args: calls.append(args) or [{'name': 'Shop'}]
        good = {'query': '螺螄粉 旺角', 'lat': 22.32, 'lng': 114.17, 'radius': 2500, 'lang': 'zh'}
        self.assertEqual(self.post(good, path='/api/places')[0], 200)
        self.assertEqual(self.post(good, path='/api/places')[0], 429)
        self.assertEqual(calls, [('螺螄粉 旺角', 22.32, 114.17, 2500, 'zh-HK', False)])

    def test_shop_details_fall_back_to_a_plain_search_at_their_limit(self):
        ai_proxy.budget = budget(details=(1, 10, 10), places=(1, 10, 10))
        calls = []
        ai_proxy.search_places = lambda *args: calls.append(args[-1]) or []
        good = {'query': 'x', 'lat': 22.32, 'lng': 114.17, 'radius': 2500, 'details': True}
        self.assertEqual([self.post(good, path='/api/places')[0] for _ in range(3)], [200, 200, 429])
        self.assertEqual(calls, [True, False])

    def test_place_search_rejects_bad_requests_without_spending(self):
        ai_proxy.budget = budget(places=(1, 10, 10))
        ai_proxy.search_places = lambda *args: self.fail('Google was called')
        good = {'query': 'x', 'lat': 22.32, 'lng': 114.17, 'radius': 2500}
        self.assertEqual(self.post(good, origin=False, path='/api/places')[0], 403)
        self.assertEqual(self.post({**good, 'lat': 35.0}, path='/api/places')[0], 400)
        self.assertEqual(self.post({**good, 'radius': 60000}, path='/api/places')[0], 400)
        self.assertEqual(self.post({**good, 'query': 'x' * 101}, path='/api/places')[0], 400)

    def test_transit_validates_endpoints_and_stops_at_the_limit(self):
        ai_proxy.budget = budget(transit=(1, 10, 10))
        trip = {'from': {'lat': 22.28, 'lng': 114.15}, 'to': {'lat': 22.29, 'lng': 114.16}, 'preference': 'lessWalking'}
        with patch.object(ai_proxy, 'transit_routes', return_value=[{'legs': []}]) as upstream:
            self.assertEqual(self.post(trip, origin=False, path='/api/transit')[0], 403)
            self.assertEqual(self.post({**trip, 'preference': []}, path='/api/transit')[0], 400)
            self.assertEqual(self.post({**trip, 'mode': 'depart', 'at': True}, path='/api/transit')[0], 400)
            self.assertEqual(self.post({**trip, 'to': {'lat': 35, 'lng': 139}}, path='/api/transit')[0], 400)
            status, payload = self.post(trip, path='/api/transit')
            self.assertEqual((status, json.loads(payload)), (200, {'routes': [{'legs': []}]}))
            self.assertEqual(self.post(trip, path='/api/transit')[0], 429)
            upstream.assert_called_once()

    def test_transitous_has_its_own_quota_and_respects_the_trial_toggle(self):
        ai_proxy.budget = budget(transitous=(1, 10, 10))
        trip = {'from': {'lat': 22.28, 'lng': 114.15}, 'to': {'lat': 22.29, 'lng': 114.16}, 'preference': 'lessWalking'}
        with patch.object(ai_proxy, 'transitous_routes', return_value=[{'legs': []}]) as upstream:
            with patch.object(ai_proxy, 'TRANSITOUS_ENABLED', False):
                self.assertEqual(self.post(trip, path='/api/transitous')[0], 429)
            self.assertEqual(self.post(trip, origin=False, path='/api/transitous')[0], 403)
            self.assertEqual(self.post({**trip, 'to': {'lat': 42, 'lng': 114.16}}, path='/api/transitous')[0], 400)
            response = self.post(trip, path='/api/transitous')
            self.assertEqual((response[0], json.loads(response[1])), (200, {'routes': [{'legs': []}]}))
            self.assertEqual(self.post(trip, path='/api/transitous')[0], 429)
            upstream.assert_called_once()

    def test_walking_route_stops_at_the_limit(self):
        ai_proxy.budget = budget(walk=(1, 10, 10))
        ai_proxy.walking_route = lambda start, end: {'points': [start, end], 'meters': 120, 'seconds': 95}
        leg = {'from': {'lat': 22.28, 'lng': 114.15}, 'to': {'lat': 22.29, 'lng': 114.16}}
        self.assertEqual(self.post({**leg, 'to': {'lat': 35, 'lng': 139}}, path='/api/walk')[0], 400)
        self.assertEqual(self.post(leg, origin=False, path='/api/walk')[0], 403)
        self.assertEqual(self.post(leg, path='/api/walk')[0], 200)
        self.assertEqual(self.post(leg, path='/api/walk')[0], 429)

    def test_each_visitor_stops_at_their_daily_spend(self):
        ai_proxy.ask_deepseek = lambda system, message: (ANSWER, {'prompt_cache_miss_tokens': 0, 'completion_tokens': 7000})
        chat = {'task': 'chat', 'message': 'x'}
        self.assertEqual([self.post(chat)[0] for _ in range(3)], [200, 200, 429])  # ¥0.056 each.
        self.assertEqual(self.post(chat, visitor='2.2.2.2')[0], 200)

    def test_suggestions_stop_at_the_limit(self):
        ai_proxy.budget = budget(suggest=(1, 10, 10))
        ai_proxy.suggest_places = lambda query, origin, language: [{'name': query}]
        self.assertEqual(self.post({'query': 'x' * 61}, path='/api/suggest')[0], 400)
        self.assertEqual(self.post({'query': '朗', 'from': {'lat': 35, 'lng': 139}}, path='/api/suggest')[0], 400)
        self.assertEqual(self.post({'query': '朗'}, origin=False, path='/api/suggest')[0], 403)
        self.assertEqual(self.post({'query': '朗'}, path='/api/suggest')[0], 200)
        self.assertEqual(self.post({'query': '朗'}, path='/api/suggest')[0], 429)

    def test_place_lookups_stop_at_the_limit(self):
        ai_proxy.budget = budget(place=(1, 10, 10))
        ai_proxy.place_location = lambda place_id: {'lat': 22.3, 'lng': 114.1}
        self.assertEqual(self.post({'id': '../secret'}, path='/api/place')[0], 400)
        self.assertEqual(self.post({'id': 'ChIJabc-_1'}, origin=False, path='/api/place')[0], 403)
        self.assertEqual(self.post({'id': 'ChIJabc-_1'}, path='/api/place')[0], 200)
        self.assertEqual(self.post({'id': 'ChIJabc-_1'}, path='/api/place')[0], 429)

    def test_upstream_errors_reveal_nothing(self):
        def fail(system, message):
            raise urllib.error.HTTPError('u', 401, f'bad key {SECRET}', {}, None)
        ai_proxy.ask_deepseek = fail
        status, text = self.post({'task': 'chat', 'message': 'x'})
        self.assertEqual(status, 502)
        self.assertNotIn(SECRET, text)

    def test_only_short_json_goes_back(self):
        for good in (ANSWER, '```json\n{"kind": "say", "text": "可以幫你規劃路線。"}\n```', '{"kind": "discover", "want": "拉麵", "searchTerms": ["a", "b"]}'):
            self.assertTrue(ai_proxy.is_app_reply(good), good)
        essay = '羅馬' * 200
        for bad in ('Rome was founded in 753 BC.', '[1, 2]', '{broken', f'{{"kind": "say", "text": "{essay}"}}',
                    f'{{"options": ["{essay}"]}}', f'{{"a": {{"b": ["{essay}"]}}}}'):
            self.assertFalse(ai_proxy.is_app_reply(bad), bad[:30])
        ai_proxy.ask_deepseek = lambda system, message: ('Rome was founded in 753 BC.', {})
        self.assertEqual(self.post({'task': 'chat', 'message': 'x'})[0], 502)


if __name__ == '__main__':
    unittest.main()
