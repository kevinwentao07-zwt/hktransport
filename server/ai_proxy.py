#!/usr/bin/env python3
"""Calls DeepSeek for the web app, so the API key never reaches a browser.

Visitors can only pick one of the app's own tasks and send their text. The prompts live
here, so this can't be used as a free general-purpose chatbot, and limits cap the cost.
Nothing a visitor sends is logged or kept.
"""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

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


limiter = Limiter(
    per_minute=int(os.environ.get('AI_PER_MINUTE', '12')),
    per_day=int(os.environ.get('AI_PER_DAY', '100')),
    site_per_day=int(os.environ.get('AI_SITE_PER_DAY', '2000')),
)
in_flight = threading.BoundedSemaphore(int(os.environ.get('AI_CONCURRENT', '16')))


def api_key():
    return os.environ.get('DEEPSEEK_API_KEY', '').strip()


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

    def do_GET(self):
        if self.path != '/api/ai':
            return self.send(404, {'error': 'Not found'})
        self.send(200, {'available': bool(api_key())})

    def do_POST(self):
        if self.path != '/api/ai':
            return self.send(404, {'error': 'Not found'})
        # Keeps other websites from spending the quota through their visitors' browsers.
        if self.headers.get('Origin') != f"https://{self.headers.get('Host')}":
            return self.send(403, {'error': 'Forbidden'})
        try:
            length = int(self.headers.get('Content-Length', ''))
        except ValueError:
            return self.send(411, {'error': 'Length required'})
        if not 0 < length <= MAX_BODY:
            return self.send(413, {'error': 'Too large'})
        try:
            body = json.loads(self.rfile.read(length))
            system, message = PROMPTS[body['task']], body['message']
        except (ValueError, KeyError, TypeError):
            return self.send(400, {'error': 'Bad request'})
        if not isinstance(message, str) or not message.strip() or len(message) > MAX_MESSAGE:
            return self.send(400, {'error': 'Bad request'})
        if not api_key():
            return self.send(503, {'error': 'AI 未設定'})
        # Caddy replaces this header, so the last address is the one that connected.
        visitor = self.headers.get('X-Forwarded-For', '').split(',')[-1].strip() or self.client_address[0]
        if not limiter.allow(visitor):
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
