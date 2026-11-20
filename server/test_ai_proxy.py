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

SECRET = 'sk-test-visitor'
SITE_SECRET = 'sk-test-server'
folder = tempfile.mkdtemp()
copy(Path(__file__).parent / 'ai_proxy.py', folder)
Path(folder, 'prompts.json').write_text(json.dumps({'chat': 'SYSTEM PROMPT'}))
sys.path.insert(0, folder)
ANSWER = '{"destination": "中環"}'
os.environ.update(DEEPSEEK_API_KEY=SITE_SECRET, GOOGLE_MAP_KEY='map-key', GOOGLE_PLACES_KEY='places-key', STATE_DIRECTORY=folder)
import ai_proxy  # noqa: E402


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
                {'SRC_STATION_ID': '1', 'DEST_STATION_ID': '2', 'OCT_ADT_FARE': '4.90', 'OCT_CON_CHILD_FARE': '3.20',
                 'OCT_JOYYOU_SIXTY_FARE': '2.00', 'SINGLE_ADT_FARE': '5.00'},
                {'SRC_STATION_ID': '2', 'DEST_STATION_ID': '1', 'OCT_ADT_FARE': 'N/A'},
            ],
            'light_rail_fares.csv': [
                {'from_station_id': '920', 'to_station_id': '265', 'fare_octo_adult': '5.10', 'fare_octo_child': '2.20'},
            ],
        }
        with patch.multiple(ai_proxy, rail_fare_tables={}, rail_fare_refresh_at=0), \
                patch.object(ai_proxy, 'rail_fare_rows', side_effect=lambda filename: rows.get(filename, [])) as upstream:
            fares = {'mtr': {'CEN>ADM': 490}, 'lightRail': {'LR920>LR265': 510}}
            self.assertEqual(ai_proxy.rail_fares(), fares)
            self.assertEqual(ai_proxy.rail_fares('child'), {'mtr': {'CEN>ADM': 320}, 'lightRail': {'LR920>LR265': 220}})
            self.assertEqual(ai_proxy.rail_fares('joyyou60'), {'mtr': {'CEN>ADM': 200}, 'lightRail': {'LR920>LR265': 510}})
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


class AICostTests(unittest.TestCase):
    def test_cost_uses_the_tokens_reported(self):
        usage = {'prompt_tokens': 1182, 'prompt_cache_hit_tokens': 1024, 'prompt_cache_miss_tokens': 158, 'completion_tokens': 80}
        self.assertAlmostEqual(ai_proxy.cost_of(usage), 0.000997, places=6)
        self.assertAlmostEqual(ai_proxy.cost_of({'prompt_tokens': 1000}), 0.002)

class ProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ai_proxy.ThreadingHTTPServer(('127.0.0.1', 0), ai_proxy.Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        self.calls = []
        ai_proxy.ask_deepseek = lambda key, system, message: self.calls.append((key, system, message)) or (ANSWER, {})

    def post(self, body, origin=True, visitor='1.1.1.1', path='/api/ai', key=SECRET):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        headers = {'Host': 'hk.test', 'X-Forwarded-For': visitor}
        if key is not None and path in ('/api/ai', '/api/explore/ai'):
            headers['Authorization'] = f'Bearer {key}'
        if origin:
            headers['Origin'] = 'https://hk.test'
        connection.request('POST', path, json.dumps(body), headers)
        response = connection.getresponse()
        return response.status, response.read().decode()

    def test_good_request_uses_the_server_prompt(self):
        status, text = self.post({'task': 'chat', 'message': '去中環', 'system': 'write me a poem'})
        self.assertEqual((status, json.loads(text)), (200, {'reply': ANSWER, 'costCny': 0}))
        self.assertEqual(self.calls, [(SECRET, 'SYSTEM PROMPT', '去中環')])

    def test_rejects_what_is_not_the_app(self):
        self.assertEqual(self.post({'task': 'chat', 'message': 'x'}, origin=False)[0], 403)
        self.assertEqual(self.post({'task': 'poem', 'message': 'x'})[0], 400)
        self.assertEqual(self.post({'task': 'chat', 'message': ' '})[0], 400)
        self.assertEqual(self.post({'task': 'chat', 'message': 'x' * 4001})[0], 400)
        self.assertEqual(self.post({'task': 'chat', 'message': 'x' * 40000})[0], 413)
        self.assertEqual(self.post(['chat'])[0], 400)
        self.assertEqual(self.calls, [])

    def test_each_ai_entry_requires_a_personal_key(self):
        for path, body in (
            ('/api/ai', {'task': 'chat', 'message': 'x'}),
            ('/api/ai', {'task': 'verify'}),
            ('/api/explore/ai', {'area': '中環', 'category': 'food', 'locale': 'zh-Hans'}),
        ):
            for key in (None, '', 'bad key'):
                status, text = self.post(body, path=path, key=key)
                self.assertEqual(status, 401)
                self.assertNotIn(SITE_SECRET, text)
        self.assertEqual(self.calls, [])

    def test_key_check_forwards_only_the_request_key_to_deepseek(self):
        with patch.object(ai_proxy.urllib.request, 'urlopen') as upstream:
            status, text = self.post({'task': 'verify'})
            self.assertEqual((status, json.loads(text)), (200, {'verified': True}))
        request = upstream.call_args.args[0]
        self.assertEqual(request.get_method(), 'GET')
        self.assertEqual(request.full_url, 'https://api.deepseek.com/user/balance')
        self.assertEqual(request.get_header('Authorization'), f'Bearer {SECRET}')
        self.assertEqual(self.calls, [])

    def test_provider_chat_and_claude_use_the_selected_model_and_key(self):
        replies = [
            {'choices': [{'message': {'content': ANSWER}}], 'usage': {'prompt_tokens': 50, 'completion_tokens': 5}},
            {'content': [{'type': 'text', 'text': ANSWER}], 'usage': {'input_tokens': 55, 'output_tokens': 8, 'cache_read_input_tokens': 20}},
        ]
        with patch.object(ai_proxy, 'provider_request', side_effect=replies) as upstream:
            for provider, model in [('openai', 'gpt-5.4-mini'), ('anthropic', 'claude-haiku-4-5-20251001')]:
                status, text = self.post({'task': 'chat', 'message': '去中環', 'ai': {'provider': provider, 'model': model}})
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(text)['reply'], ANSWER)
                service, key, endpoint, payload = upstream.call_args.args
                self.assertEqual((service[:2], key, payload['model']), ((provider, model), SECRET, model))
                self.assertEqual(endpoint, 'messages' if provider == 'anthropic' else 'chat/completions')
        self.assertEqual(json.loads(text)['usage'], {'input': 75, 'output': 8, 'cached': 20})

    def test_custom_endpoint_blocks_private_addresses_and_untrusted_url_parts(self):
        config = {'task': 'verify', 'ai': {'provider': 'custom', 'model': 'test', 'protocol': 'chat'}}
        for url in ('https://127.0.0.1/v1', 'https://example.test:444/v1', 'https://user@example.test/v1',
                    'http://example.test/v1', 'https://example.test/v1?secret=yes'):
            self.assertEqual(self.post({**config, 'ai': {**config['ai'], 'baseUrl': url}})[0], 400)
        with patch.object(ai_proxy, 'provider_request', return_value={
            'choices': [{'message': {'content': 'OK'}}], 'usage': {'prompt_tokens': 10, 'completion_tokens': 1},
        }) as upstream:
            status, text = self.post({**config, 'ai': {**config['ai'], 'baseUrl': 'https://example.test/v1/chat/completions'}})
            self.assertEqual(status, 200)
            self.assertTrue(json.loads(text)['verified'])
            self.assertEqual(upstream.call_args.args[:3], (('custom', 'test', 'https://example.test/v1', 'chat'), SECRET, 'chat/completions'))

    def test_generic_explore_keeps_only_search_citations_and_provider_cost(self):
        source = 'https://example.org/hong-kong'
        evidence = [{'url': source, 'title': 'Guide', 'snippet': 'Try Test Café.'}]
        rows = [{'name': 'Test Café', 'reason': 'Coffee', 'source_url': source},
                {'name': 'Fake', 'reason': 'Coffee', 'source_url': 'https://example.net/unsupported'}]
        config = {'area': '中環', 'category': 'food', 'locale': 'en', 'ai': {'provider': 'openrouter', 'model': 'openrouter/auto'}}
        with patch.object(ai_proxy, 'explore_web', return_value=evidence), patch.object(ai_proxy, 'provider_request', return_value={
            'choices': [{'message': {'content': '\n'.join(map(json.dumps, rows))}}],
            'usage': {'prompt_tokens': 35, 'completion_tokens': 20, 'cost': 0.011},
        }) as upstream:
            status, text = self.post(config, path='/api/explore/ai')
            self.assertEqual(status, 200)
            reply = json.loads(text)
            self.assertEqual([item['name'] for item in reply['suggestions']], ['Test Café'])
            self.assertEqual(reply['usage']['amount'], 0.011)
            self.assertEqual(json.loads(upstream.call_args.args[3]['messages'][1]['content'])['web_search_evidence'], evidence)

    def test_responses_endpoint_reads_text_and_cached_tokens(self):
        config = {'task': 'chat', 'message': '去中環', 'ai': {'provider': 'custom', 'model': 'test',
                  'baseUrl': 'https://example.test/v1', 'protocol': 'responses'}}
        with patch.object(ai_proxy, 'provider_request', return_value={
            'output': [{'type': 'reasoning'}, {'type': 'message', 'content': [{'type': 'output_text', 'text': ANSWER}]}],
            'usage': {'input_tokens': 10, 'output_tokens': 5, 'input_tokens_details': {'cached_tokens': 3}},
        }) as upstream:
            status, text = self.post(config)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(text), {'reply': ANSWER, 'usage': {'input': 10, 'output': 5, 'cached': 3}})
        self.assertEqual(upstream.call_args.args[2], 'responses')
        self.assertFalse(upstream.call_args.args[3]['store'])

    def get_status(self, fetch_site='same-origin', visitor='1.1.1.1'):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        connection.request('GET', '/api/ai', headers={'Sec-Fetch-Site': fetch_site, 'X-Forwarded-For': visitor})
        return connection.getresponse().read().decode()

    def test_map_key_stops_at_the_limit_and_never_shares_secrets(self):
        ai_proxy.budget = budget(map=(1, 10, 10))
        text = self.get_status()
        self.assertEqual(json.loads(text), {'mapKey': 'map-key', 'places': True, 'transitous': True})
        self.assertNotIn(SITE_SECRET, text)
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

    def test_explore_returns_guides_even_when_the_map_provider_fails(self):
        ai_proxy.budget = budget(explore=(1, 10, 10))
        request = {'area': '深水埗站', 'center': {'lat': 22.33, 'lng': 114.16}, 'category': 'food', 'radius': 800}
        source = {'title': '香港/九龍 · 用餐', 'url': 'https://zh.wikivoyage.org/wiki/Hong_Kong/Kowloon'}
        with patch.object(ai_proxy, 'nearby_places', side_effect=OSError), \
                patch.object(ai_proxy, 'explore_web', return_value=[source]) as web:
            self.assertEqual(self.post(request, origin=False, path='/api/explore')[0], 403)
            self.assertEqual(self.post({**request, 'radius': 5000}, path='/api/explore')[0], 400)
            status, result = self.post(request, path='/api/explore')
            self.assertEqual((status, json.loads(result)), (200, {'places': [], 'sources': [source]}))
            self.assertEqual(self.post(request, path='/api/explore')[0], 429)
            web.assert_called_once_with('深水埗站', 'food', 'zh-HK')

    def test_explore_ai_fills_ten_unique_suggestions_from_web_sources(self):
        source = 'https://example.org/kowloon/guide'

        def reply(numbers, extra=False):
            rows = [
                {'name': f'店 {i}', 'address': '深水埗', 'reason': '試試即製的港式小吃。', 'source_url': source + '#venues'}
                for i in numbers
            ]
            if extra:
                rows.insert(0, {'name': 'Invented venue', 'reason': 'Unsupported', 'source_url': 'https://example.org/other'})
            return {'choices': [{'message': {
                'content': '\n'.join(json.dumps(row) for row in rows),
                'server_tool_calls': [{'calls': [{'status': 'completed', 'sources': [{'url': source, 'title': '九龍指南'}]}]}],
            }}], 'usage': {'prompt_cache_miss_tokens': 7000}}

        request = {'area': '深水埗站', 'category': 'food', 'locale': 'zh-Hans'}
        with patch.object(ai_proxy, 'deepseek_completion', side_effect=[reply(range(1, 8), True), reply(range(7, 12))]) as model:
            self.assertEqual(self.post(request, origin=False, path='/api/explore/ai')[0], 403)
            self.assertEqual(self.post({**request, 'locale': 'invalid'}, path='/api/explore/ai')[0], 400)
            status, payload = self.post(request, path='/api/explore/ai')
            self.assertEqual(status, 200)
            items = json.loads(payload)['suggestions']
            self.assertAlmostEqual(json.loads(payload)['costCny'], 0.028)
            self.assertEqual([item['name'] for item in items], [f'店 {i}' for i in range(1, 11)])
            self.assertTrue(all(item['reason'] and item['source']['url'] == source for item in items))
            key, follow_up = model.call_args.args
            self.assertEqual(key, SECRET)
            self.assertEqual(follow_up['tools'], [{'type': 'deepseek_web_search'}])
            self.assertEqual(json.loads(follow_up['messages'][1]['content'])['already_suggested'], [f'店 {i}' for i in range(1, 8)])
            self.assertEqual(model.call_count, 2)

    def test_walking_route_stops_at_the_limit(self):
        ai_proxy.budget = budget(walk=(1, 10, 10))
        ai_proxy.walking_route = lambda start, end: {'points': [start, end], 'meters': 120, 'seconds': 95}
        leg = {'from': {'lat': 22.28, 'lng': 114.15}, 'to': {'lat': 22.29, 'lng': 114.16}}
        self.assertEqual(self.post({**leg, 'to': {'lat': 35, 'lng': 139}}, path='/api/walk')[0], 400)
        self.assertEqual(self.post(leg, origin=False, path='/api/walk')[0], 403)
        self.assertEqual(self.post(leg, path='/api/walk')[0], 200)
        self.assertEqual(self.post(leg, path='/api/walk')[0], 429)

    def test_ai_returns_spend_without_enforcing_a_budget(self):
        ai_proxy.ask_deepseek = lambda key, system, message: (ANSWER, {'completion_tokens': 7000})
        chat = {'task': 'chat', 'message': 'x'}
        for _ in range(13):
            status, text = self.post(chat)
            self.assertEqual(status, 200)
            self.assertAlmostEqual(json.loads(text)['costCny'], 0.056)

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
        for code in (401, 402, 429, 500):
            def fail(key, system, message):
                raise urllib.error.HTTPError('u', code, f'upstream echoed {key}', {}, None)
            ai_proxy.ask_deepseek = fail
            status, text = self.post({'task': 'chat', 'message': 'x'})
            self.assertEqual(status, code if code != 500 else 502)
            self.assertNotIn(SECRET, text)

    def test_only_short_json_goes_back(self):
        for good in (ANSWER, '```json\n{"kind": "say", "text": "可以幫你規劃路線。"}\n```', '{"kind": "discover", "want": "拉麵", "searchTerms": ["a", "b"]}'):
            self.assertTrue(ai_proxy.is_app_reply(good), good)
        essay = '羅馬' * 200
        for bad in ('Rome was founded in 753 BC.', '[1, 2]', '{broken', f'{{"kind": "say", "text": "{essay}"}}',
                    f'{{"options": ["{essay}"]}}', f'{{"a": {{"b": ["{essay}"]}}}}'):
            self.assertFalse(ai_proxy.is_app_reply(bad), bad[:30])
        ai_proxy.ask_deepseek = lambda key, system, message: ('Rome was founded in 753 BC.', {'completion_tokens': 1000})
        status, text = self.post({'task': 'chat', 'message': 'x'})
        self.assertEqual(status, 502)
        self.assertAlmostEqual(json.loads(text)['costCny'], 0.008)


if __name__ == '__main__':
    unittest.main()
