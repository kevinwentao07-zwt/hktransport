"""Run with `python3 server/test_ai_proxy.py`."""
import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from shutil import copy

SECRET = 'sk-test-secret'
folder = tempfile.mkdtemp()
copy(Path(__file__).parent / 'ai_proxy.py', folder)
Path(folder, 'prompts.json').write_text(json.dumps({'chat': 'SYSTEM PROMPT'}))
sys.path.insert(0, folder)
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
        ai_proxy.ask_deepseek = lambda system, message: self.calls.append((system, message)) or ('answer', {})

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
        self.assertEqual((status, json.loads(text)), (200, {'reply': 'answer'}))
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
        self.assertEqual(json.loads(text), {'available': True, 'mapKey': 'map-key', 'places': True})
        self.assertNotIn(SECRET, text)
        self.assertNotIn('places-key', text)
        self.assertEqual(json.loads(self.get_status())['mapKey'], None)

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

    def test_walking_route_stops_at_the_limit(self):
        ai_proxy.budget = budget(walk=(1, 10, 10))
        ai_proxy.walking_route = lambda start, end: [start, end]
        leg = {'from': {'lat': 22.28, 'lng': 114.15}, 'to': {'lat': 22.29, 'lng': 114.16}}
        self.assertEqual(self.post({**leg, 'to': {'lat': 35, 'lng': 139}}, path='/api/walk')[0], 400)
        self.assertEqual(self.post(leg, origin=False, path='/api/walk')[0], 403)
        self.assertEqual(self.post(leg, path='/api/walk')[0], 200)
        self.assertEqual(self.post(leg, path='/api/walk')[0], 429)

    def test_each_visitor_stops_at_their_daily_spend(self):
        ai_proxy.ask_deepseek = lambda system, message: ('answer', {'prompt_cache_miss_tokens': 0, 'completion_tokens': 7000})
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

    def test_upstream_errors_reveal_nothing(self):
        def fail(system, message):
            raise urllib.error.HTTPError('u', 401, f'bad key {SECRET}', {}, None)
        ai_proxy.ask_deepseek = fail
        status, text = self.post({'task': 'chat', 'message': 'x'})
        self.assertEqual(status, 502)
        self.assertNotIn(SECRET, text)


if __name__ == '__main__':
    unittest.main()
