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
os.environ['DEEPSEEK_API_KEY'] = SECRET
import ai_proxy  # noqa: E402


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
        self.calls = []
        ai_proxy.ask_deepseek = lambda system, message: self.calls.append((system, message)) or 'answer'

    def post(self, body, origin=True, visitor='1.1.1.1'):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        headers = {'Host': 'hk.test', 'X-Forwarded-For': visitor}
        if origin:
            headers['Origin'] = 'https://hk.test'
        connection.request('POST', '/api/ai', json.dumps(body), headers)
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

    def test_status_shares_the_map_key_but_not_the_ai_key(self):
        os.environ['MAPTILER_KEY'] = 'map-key'
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        connection.request('GET', '/api/ai')
        text = connection.getresponse().read().decode()
        self.assertEqual(json.loads(text), {'available': True, 'mapKey': 'map-key'})
        self.assertNotIn(SECRET, text)

    def test_upstream_errors_reveal_nothing(self):
        def fail(system, message):
            raise urllib.error.HTTPError('u', 401, f'bad key {SECRET}', {}, None)
        ai_proxy.ask_deepseek = fail
        status, text = self.post({'task': 'chat', 'message': 'x'})
        self.assertEqual(status, 502)
        self.assertNotIn(SECRET, text)


if __name__ == '__main__':
    unittest.main()
