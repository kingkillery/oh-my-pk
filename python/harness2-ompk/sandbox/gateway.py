"""Host-only, zero-price OpenRouter gateway. Credentials never enter the worker."""
from __future__ import annotations

import hashlib
import http.server
import json
from pathlib import Path
import socketserver
import threading
import time
import urllib.error
import urllib.request

API = 'https://openrouter.ai/api/v1'
MAX_REQUEST = 512 * 1024
MAX_TOTAL = 8 * 1024 * 1024
MAX_CALLS = 120
MAX_OUTPUT = 4096


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Gateway:
    def __init__(self, directory: Path, model: str, key: str, seconds: int):
        if not model.endswith(':free') or not key:
            raise ValueError('An explicit :free model and host-only key are required')
        self.directory, self.model, self._key = directory, model, key
        self.deadline = time.monotonic() + seconds
        self.lock = threading.Lock()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with self.opener.open(API + '/models', timeout=20) as response:
            entry = next(m for m in json.load(response)['data'] if m['id'] == model)
        if not entry.get('pricing') or any(float(v) != 0 for v in entry['pricing'].values()):
            raise ValueError('Model is not verified zero-price')
        if 'tools' not in entry.get('supported_parameters', []):
            raise ValueError('Model lacks tool support required by the proposer')
        self.state = {'model': model, 'catalog_pricing': entry['pricing'], 'paid_fallback': False,
                      'max_calls': MAX_CALLS, 'max_total_input_bytes': MAX_TOTAL, 'calls': 0,
                      'input_bytes': 0, 'requests': [], 'stopped': False}
        self.save()

    def save(self):
        # Metadata only. In particular: no keys, request bodies or response bodies.
        (self.directory.parent / 'gateway.json').write_text(json.dumps(self.state, indent=2))

    def reserve(self, raw: bytes) -> tuple[dict, dict]:
        if not 0 < len(raw) <= MAX_REQUEST:
            raise ValueError('request size')
        data = json.loads(raw)
        if data.get('model') != 'smoke' or not isinstance(data.get('messages'), list) or not data['messages']:
            raise ValueError('disallowed model or messages')
        with self.lock:
            if time.monotonic() >= self.deadline or self.state['calls'] >= MAX_CALLS or self.state['input_bytes'] + len(raw) > MAX_TOTAL:
                raise TimeoutError('budget exhausted; no fallback')
            self.state['calls'] += 1
            self.state['input_bytes'] += len(raw)
            receipt = {'n': self.state['calls'], 'input_bytes': len(raw),
                       'request_sha256': hashlib.sha256(raw).hexdigest()}
            self.state['requests'].append(receipt)
            self.save()
        allowed = ('messages', 'tools', 'tool_choice', 'temperature', 'top_p', 'stop', 'seed', 'response_format', 'parallel_tool_calls')
        body = {k: data[k] for k in allowed if k in data}
        body.update(model=self.model, stream=bool(data.get('stream')), max_tokens=MAX_OUTPUT,
                    provider={'max_price': {'prompt': 0, 'completion': 0}, 'allow_fallbacks': False},
                    plugins=[], reasoning={'effort': 'low', 'exclude': True})
        if body['stream']:
            body['stream_options'] = {'include_usage': True}
        return body, receipt

    def start(self):
        gateway = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def setup(self):
                super().setup()
                self.connection.settimeout(75)

            def log_message(self, *args):
                pass

            def answer(self, status, body, content_type='application/json'):
                raw = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(raw)))
                self.send_header('Connection', 'close')
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                if self.path == '/v1/models':
                    self.answer(200, {'object': 'list', 'data': [{'id': 'smoke', 'object': 'model'}]})
                else:
                    self.answer(403, {'error': 'route forbidden'})

            def do_CONNECT(self):
                self.answer(403, {'error': 'route forbidden'})

            def do_POST(self):
                if self.path != '/v1/chat/completions' or 'Transfer-Encoding' in self.headers:
                    self.answer(403, {'error': 'route forbidden'})
                    return
                try:
                    length = int(self.headers.get('Content-Length', 0))
                    if not 0 < length <= MAX_REQUEST:
                        raise ValueError('size')
                    body, receipt = gateway.reserve(self.rfile.read(length))
                except TimeoutError:
                    self.answer(429, {'error': 'budget exhausted; no fallback'})
                    return
                except (ValueError, TypeError):
                    self.answer(400, {'error': 'invalid or disallowed request'})
                    return
                start = time.monotonic()
                try:
                    request = urllib.request.Request(API + '/chat/completions', json.dumps(body).encode(),
                        {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + gateway._key})
                    with gateway.opener.open(request, timeout=65) as response:
                        raw = response.read(6 * 1024 * 1024 + 1)
                        if len(raw) > 6 * 1024 * 1024:
                            raise ValueError('response size')
                        content_type = response.headers.get('Content-Type', 'application/json')
                    events = []
                    if 'event-stream' in content_type:
                        for line in raw.splitlines():
                            if line.startswith(b'data: ') and line[6:] != b'[DONE]':
                                events.append(json.loads(line[6:]))
                    else:
                        events.append(json.loads(raw))
                    status = 502 if any(e.get('error') for e in events) else 200
                    receipt.update(status=status, usage=[e['usage'] for e in events if e.get('usage')],
                                   response_bytes=len(raw), response_sha256=hashlib.sha256(raw).hexdigest())
                    self.answer(status, raw, content_type)
                except urllib.error.HTTPError as exc:
                    receipt['status'] = exc.code
                    self.answer(exc.code, {'error': 'free provider unavailable; no fallback'})
                except Exception as exc:
                    receipt.update(status=502, error_type=type(exc).__name__)
                    self.answer(502, {'error': 'free provider failed; no fallback'})
                finally:
                    receipt['wall_seconds'] = round(time.monotonic() - start, 3)
                    with gateway.lock:
                        gateway.save()

        class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
            daemon_threads = True

            def __init__(self, *args):
                self.slots = threading.BoundedSemaphore(4)
                super().__init__(*args)

            def process_request(self, request, address):
                if not self.slots.acquire(blocking=False):
                    request.close()
                    return
                try:
                    super().process_request(request, address)
                except BaseException:
                    self.slots.release()
                    raise

            def process_request_thread(self, request, address):
                try:
                    super().process_request_thread(request, address)
                finally:
                    self.slots.release()

        self.server = Server(str(self.directory / 'model.sock'), Handler)
        (self.directory / 'model.sock').chmod(0o600)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        if hasattr(self, 'server'):
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=5)
            (self.directory / 'model.sock').unlink(missing_ok=True)
        self.state['stopped'] = True
        self._key = ''
        self.save()
