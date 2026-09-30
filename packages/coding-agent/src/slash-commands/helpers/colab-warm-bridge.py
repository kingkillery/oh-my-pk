"""Harness-owned loopback transport for an existing Colab kernel; never provisions.

One authenticated, uniquely sessioned WebSocket carries all requests. No request
replay, kernel interruption, prompt mutation, or idle keepalive is performed.
"""
from __future__ import annotations

import argparse
import base64
import copy
import json
import os
import re
import select
import socket
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PREFIX = "__COLAB_WARM_HTTP__"
ALLOWED = {"/health", "/v1/models", "/v1/chat/completions", "/v1/completions"}
MAX_BODY = 4 * 1024 * 1024


def abort_marker_path(port: int) -> str:
    return f"/content/.ompk-native-abort-{port}"


# Bounded remote read deadline. The launcher scales this for large cold-prefill contexts.
DEFAULT_REMOTE_READ_TIMEOUT_S = 300

def remote_code(method: str, path: str, body: bytes, port: int, rid: str, marker: str, timeout: int = DEFAULT_REMOTE_READ_TIMEOUT_S) -> str:
    if path not in ALLOWED or method not in {"GET", "POST"}:
        raise ValueError("Unsupported route")
    config = json.dumps({"method": method, "path": path, "body": base64.b64encode(body).decode(),
                         "port": port, "rid": rid, "marker": marker, "timeout": timeout})
    return f'''def _ompk_native_forward():
 import base64,http.client,json,os,socket,threading
 c=json.loads({config!r})
 marker=c['marker']+'-'+c['rid']
 data=base64.b64decode(c['body']) if c['body'] else None
 stopped=threading.Event()
 aborted=threading.Event()
 connection=http.client.HTTPConnection('127.0.0.1',c['port'],timeout=c['timeout'])
 owned_socket=None
 headers_sent=False
 is_sse=False
 def is_aborted():
  try:
   with open(marker) as abort_file: return abort_file.read().strip()==c['rid']
  except OSError: return False
 def watch_abort():
  while not stopped.wait(0.025):
   if is_aborted():
    aborted.set()
    if owned_socket is not None:
     try: owned_socket.shutdown(socket.SHUT_RDWR)
     except OSError: pass
    return
 watcher=threading.Thread(target=watch_abort,daemon=True)
 try:
  connection.connect()
  owned_socket=connection.sock
  watcher.start()
  connection.request(c['method'],c['path'],body=data,headers={{'Content-Type':'application/json'}})
  with connection.getresponse() as response:
   print({PREFIX!r}+json.dumps({{'status':response.status,'content_type':response.getheader('content-type','application/json')}}),flush=True)
   headers_sent=True
   is_sse='text/event-stream' in response.getheader('content-type','')
   if is_sse:
    for line in response:
     if aborted.is_set() or is_aborted(): break
     print(line.decode('utf-8'),end='',flush=True)
   else:
    payload=response.read()
    if not aborted.is_set(): print(payload.decode('utf-8'),end='',flush=True)
 except (socket.timeout,TimeoutError):
  if headers_sent and is_sse:
   # Mid-SSE: emit the established error frame so the client sees a terminal
   # error rather than a silently truncated 200.
   print('data: {{"error":{{"message":"remote read timeout","type":"timeout","code":504}}}}\\n\\n',end='',flush=True)
   print('data: [DONE]\\n\\n',end='',flush=True)
  elif headers_sent:
   # Mid-JSON: cannot emit SSE frames into a JSON body; re-raise so the bridge
   # marks a transport failure rather than corrupting the response.
   raise
  else:
   print({PREFIX!r}+json.dumps({{'status':504,'content_type':'application/json'}}),flush=True)
   print(json.dumps({{'error':'remote read timeout'}}),end='',flush=True)
 except Exception:
  if not aborted.is_set(): raise
  if not headers_sent: print({PREFIX!r}+json.dumps({{'status':499,'content_type':'application/json'}}),flush=True)
 finally:
  stopped.set()
  if watcher.is_alive(): watcher.join(timeout=1)
  connection.close()
  try: os.unlink(marker)
  except OSError: pass
_ompk_native_forward()
'''


class StreamRelay:
    def __init__(self, start, write):
        self.start = start
        self.write = write
        self.buffer = ""
        self.started = False
        self.sse = False
        self.pending = ''
        self.terminal = ''
        self.deferring_terminal = False

    def payload(self, text):
        if not self.sse:
            self.write(text.encode())
            return
        self.pending += text
        while True:
            boundary = re.search(r'\r?\n\r?\n', self.pending)
            if boundary is None:
                if len(self.pending) > 1024 * 1024:raise ValueError('Oversized SSE frame')
                return
            frame, self.pending = self.pending[:boundary.end()], self.pending[boundary.end():]
            for line in frame.splitlines():
                if not line.startswith('data:'):continue
                data = line[5:].strip()
                if data == '[DONE]':self.deferring_terminal = True
                else:
                    try:chunk = json.loads(data)
                    except ValueError:continue
                    if any(choice.get('finish_reason') for choice in chunk.get('choices', [])):
                        self.deferring_terminal = True
            if self.deferring_terminal:
                self.terminal += frame
                if len(self.terminal) > 1024 * 1024:raise ValueError('Oversized terminal SSE payload')
            else:self.write(frame.encode())

    def validate_completion(self):
        if self.sse and self.pending.strip():raise ValueError('Incomplete SSE frame')

    def release_terminal(self):
        # Clients may finish at finish_reason + usage, even before [DONE].
        # Publish those bytes only after the kernel reply and request lock release.
        if self.terminal:self.write(self.terminal.encode())
        self.terminal = ''

    def feed(self, text):
        if self.started:
            self.payload(text)
            return
        self.buffer += text
        boundary = self.buffer.find("\n")
        if boundary > 32768 or (boundary < 0 and len(self.buffer) > 32768):
            raise ValueError("Oversized metadata")
        if boundary < 0:
            return
        line, remainder = self.buffer.split("\n", 1)
        if not line.startswith(PREFIX):
            raise ValueError("Invalid remote metadata")
        metadata = json.loads(line[len(PREFIX):])
        status = metadata.get("status")
        content_type = metadata.get("content_type", "application/json")
        if type(status) is not int or not 100 <= status <= 599:
            raise ValueError("Invalid remote status")
        if not isinstance(content_type, str) or "\r" in content_type or "\n" in content_type:
            raise ValueError("Invalid content type")
        self.start(status, content_type)
        self.started = True
        self.sse = 'text/event-stream' in content_type
        self.buffer = ""
        if remainder:
            self.payload(remainder)


class WarmBridge:
    def __init__(self, runtime, remote_port, abort_uploader=None, remote_timeout=DEFAULT_REMOTE_READ_TIMEOUT_S, runtime_factory=None):
        self.runtime = runtime
        self.remote_port = remote_port
        self.lock = threading.Lock()
        self.queue_lock = threading.Lock()
        self.pending = []
        self.queue_limit = 4
        self.queue_wait = 5.0
        self.failed = False
        self._abort_uploader = abort_uploader
        self.remote_timeout = remote_timeout
        self._runtime_factory = runtime_factory
        self._last_reconnect = float('-inf')

    def acquire_slot(self, chat, prepare, disconnected):
        """Bounded FIFO chat admission; probes never jump ahead of waiting chat."""
        ticket = object()
        with self.queue_lock:
            if not chat:
                return 'acquired' if not self.pending and self.lock.acquire(False) else 'busy'
            if len(self.pending) >= self.queue_limit:
                return 'busy'
            self.pending.append(ticket)
        try:
            if not prepare():
                return 'disconnected'
            deadline = time.monotonic() + self.queue_wait
            while True:
                if disconnected():
                    return 'disconnected'
                with self.queue_lock:
                    if self.pending[0] is ticket and self.lock.acquire(False):
                        return 'acquired'
                if time.monotonic() >= deadline:
                    return 'busy'
                time.sleep(0.025)
        finally:
            with self.queue_lock:
                self.pending.remove(ticket)

    def recover_connection(self):
        # Called under the request lock, only for a new request after failure.
        # Never replay the failed request or interrupt the existing kernel.
        if self._runtime_factory is None or time.monotonic() - self._last_reconnect < 2:
            return False
        self._last_reconnect = time.monotonic()
        replacement = self._runtime_factory()
        previous = self.runtime
        self.runtime = replacement
        self.failed = False
        try:
            previous.stop(shutdown_kernel=False)
        except Exception:
            pass
        print(json.dumps({'event': 'transport_reconnected'}), flush=True)
        return True

    def request_abort(self, rid):
        if self._abort_uploader is not None:
            try:
                self._abort_uploader(rid)
            except Exception as error:
                print(json.dumps({"event": "abort_failed", "type": type(error).__name__}), flush=True)

    def forward(self, method, path, body, relay, rid):
        def output(message):
            kind = message.get("msg_type", message.get("header", {}).get("msg_type"))
            content = message.get("content", {})
            if kind == "stream" and content.get("name") == "stdout":
                relay.feed(content.get("text", ""))
        reply = self.runtime.kernel_client.execute_interactive(
            remote_code(method, path, body, self.remote_port, rid, abort_marker_path(self.remote_port), self.remote_timeout),
            # Backstop only: the inner read deadline fires first and reports 504.
            # this outer bound catches a hung exec.
            output_hook=output, timeout=self.remote_timeout + 60, allow_stdin=False,
        )
        if reply.get("content", {}).get("status", reply.get("status")) != "ok" or not relay.started:
            raise RuntimeError("Remote response did not complete")
        relay.validate_completion()


def make_handler(bridge, allowed_hosts=frozenset({"127.0.0.1", "localhost"})):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        disable_nagle_algorithm = True

        def log_message(self, *_):
            pass

        def do_GET(self):
            self.handle_request()

        def do_POST(self):
            self.handle_request()

        def handle_request(self):
            host = self.headers.get("Host", "").split(":", 1)[0].lower()
            if host not in allowed_hosts or self.headers.get("Origin"):
                self.send_error(403, "Loopback clients only")
                return
            if self.path not in ALLOWED:
                self.send_error(404)
                return
            if self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) > 1:
                self.send_error(400, "One Content-Length required")
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self.send_error(400)
                return
            if not 0 <= length <= MAX_BODY:
                self.send_error(413)
                return
            body = None
            def prepare_body():
                nonlocal body
                self.connection.settimeout(30)
                try:
                    body = self.rfile.read(length)
                    return len(body) == length
                except OSError:
                    return False

            def client_gone():
                try:
                    readable, _, exceptional = select.select([self.connection], [], [self.connection], 0)
                    return bool(exceptional or (readable and self.connection.recv(1, socket.MSG_PEEK) == b''))
                except OSError:
                    return True

            chat = self.command == 'POST' and self.path in {'/v1/chat/completions', '/v1/completions'}
            admission = bridge.acquire_slot(chat, prepare_body, client_gone)
            if admission == 'disconnected':
                self.close_connection = True
                return
            if admission != 'acquired':
                payload = json.dumps({"error": {"message": "The Colab connection is busy with another request. Wait for it to finish, then try again. This request was not started.", "type": "server_busy", "code": "inference_slot_busy"}}).encode()
                self.send_response(429)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Retry-After", "1")
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(payload)
                # The rejected POST body remains unread; never reuse this socket.
                self.close_connection = True
                return
            if bridge.failed:
                try:
                    recovered = bridge.recover_connection()
                except Exception as error:
                    recovered = False
                    print(json.dumps({'event':'reconnect_failed','type':type(error).__name__}), flush=True)
                if not recovered:
                    bridge.lock.release()
                    self.send_error(503, "Existing Colab connection unavailable; requests are never replayed")
                    return
            rid = uuid.uuid4().hex
            disconnected = threading.Event()
            finished = threading.Event()
            disconnect_lock = threading.Lock()
            remote_started = False
            watcher = None

            def mark_disconnected():
                with disconnect_lock:
                    if disconnected.is_set():
                        return
                    disconnected.set()
                    self.close_connection = True
                if remote_started:
                    bridge.request_abort(rid)

            def monitor_close():
                # Readiness polling exists only for the lifetime of a request.
                # Upload cancellation off the WebSocket relay thread so file API
                # latency cannot prevent draining the remote execution reply.
                while not finished.wait(0.025):
                    try:
                        readable, _, exceptional = select.select([self.connection], [], [self.connection], 0)
                        if exceptional or (readable and self.connection.recv(1, socket.MSG_PEEK) == b""):
                            mark_disconnected()
                            return
                    except OSError:
                        mark_disconnected()
                        return

            def start(status, content_type):
                if disconnected.is_set():
                    return
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                except OSError:
                    mark_disconnected()

            def write(data):
                if disconnected.is_set():
                    return
                try:
                    if data:
                        self.wfile.write(f"{len(data):X}\r\n".encode() + data + b"\r\n")
                        self.wfile.flush()
                except OSError:
                    mark_disconnected()

            relay = StreamRelay(start, write)
            lock_released = False
            try:
                self.connection.settimeout(30)
                try:
                    if body is None:
                        body = self.rfile.read(length)
                except OSError:
                    self.close_connection = True
                    return
                if len(body) != length:
                    self.close_connection = True
                    return
                remote_started = True
                watcher = threading.Thread(target=monitor_close, daemon=True)
                watcher.start()
                try:
                    bridge.forward(self.command, self.path, body, relay, rid)
                except Exception as error:
                    bridge.failed = True
                    self.close_connection = True
                    if not relay.started and not disconnected.is_set():
                        try:
                            self.send_error(502, "Colab transport failed")
                        except OSError:
                            pass
                    print(json.dumps({"event": "transport_failure", "type": type(error).__name__}), flush=True)
                else:
                    finished.set()
                    bridge.lock.release()
                    lock_released = True
                    if not disconnected.is_set():
                        try:
                            relay.release_terminal()
                            self.wfile.write(b"0\r\n\r\n")
                            self.wfile.flush()
                        except OSError:
                            self.close_connection = True
            finally:
                finished.set()
                # A late upload carries a unique request path and cannot cancel
                # a successor even if the file API completes after this request.
                if not lock_released:bridge.lock.release()
    return Handler


def make_abort_uploader(session, marker, refresh_session=None):
    from colab_cli.contents import ContentsClient
    client = ContentsClient(session)

    def upload_abort(rid):
        nonlocal client
        handle, temporary = tempfile.mkstemp(text=True)
        try:
            with os.fdopen(handle, "w") as file_handle:
                file_handle.write(rid)
            try:
                client.upload(temporary, marker + "-" + rid)
            except Exception as error:
                status = 404 if isinstance(error, FileNotFoundError) else getattr(getattr(error, "response", None), "status_code", None)
                if refresh_session is None or status not in {401, 403, 404}:
                    raise
                # An established kernel WebSocket can outlive its HTTP proxy
                # credential. Refresh only that existing assignment, then retry
                # this idempotent, request-specific marker once. Never replay
                # inference or change the live kernel connection.
                client = ContentsClient(refresh_session())
                client.upload(temporary, marker + "-" + rid)
        finally:
            os.unlink(temporary)
    return upload_abort


def refresh_existing_proxy(session):
    from colab_cli.common import state
    assignment = next((item for item in state.client.list_assignments() if item.endpoint == session.endpoint), None)
    if assignment is None:
        raise RuntimeError("Existing Colab assignment is no longer available; cancellation never provisions a replacement")
    updated = copy.copy(session)
    updated.url = assignment.runtime_proxy_info.url
    updated.token = assignment.runtime_proxy_info.token
    return updated


def make_runtime_factory(session, runtime_class):
    # Capture identity once. An expired assignment is a failure, not permission
    # to attach another assignment or silently create a new kernel.
    endpoint, kernel_id = session.endpoint, session.kernel_id
    if not isinstance(kernel_id, str) or not kernel_id:
        raise RuntimeError('Existing kernel ID required')
    def attach():
        updated = refresh_existing_proxy(session)
        if updated.endpoint != endpoint or updated.kernel_id != kernel_id:
            raise RuntimeError('Existing runtime identity changed')
        runtime = runtime_class(updated.url, updated.token, kernel_id=kernel_id, session_id=str(uuid.uuid4()))
        try:
            runtime.kernel_client
        except Exception:
            runtime.stop(shutdown_kernel=False)
            raise
        return runtime
    return attach


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", required=True)
    parser.add_argument("--port", type=int, default=18082)
    # WSL's localhost relay is unreliable: when it stops forwarding, a bridge
    # bound to 127.0.0.1 inside the VM is unreachable from the Windows host.
    # Binding the VM-routable address keeps the Windows launcher working. NAT
    # keeps this off the LAN, and the Host/Origin guard below still applies.
    parser.add_argument("--host", default="127.0.0.1")
    # A wildcard bind cannot authorize itself: "0.0.0.0" never matches the Host
    # header a client actually sends. The launcher passes each address it will
    # dial so the guard stays an explicit allowlist instead of "any host".
    parser.add_argument("--allow-host", action="append", default=[])
    parser.add_argument("--remote-port", type=int, default=8081)
    parser.add_argument("--remote-timeout", type=int, default=DEFAULT_REMOTE_READ_TIMEOUT_S)
    args = parser.parse_args()
    from colab_cli.common import state
    from colab_cli.runtime import ColabRuntime
    session = state.store.get(args.session)
    if session is None:
        parser.error("Existing Colab session missing; bridge never provisions or replaces a runtime")
    # Bind first: an occupied port must not open a kernel connection.
    server = ThreadingHTTPServer((args.host, args.port), BaseHTTPRequestHandler)
    server.daemon_threads = True
    try:
        # Mirror the working prototype attach exactly: the CLI-maintained kernel
        # ID. ColabRuntime silently creates a kernel when no ID is supplied, so a
        # missing stored ID is a hard error, never an implicit replacement.
        kernel_id = session.kernel_id
        if not isinstance(kernel_id, str) or not kernel_id:
            raise RuntimeError("No stored kernel ID for this session; reconnect the existing session explicitly. The bridge never creates a kernel.")
        runtime_factory = make_runtime_factory(session, ColabRuntime)
        runtime = runtime_factory()
        bridge = WarmBridge(runtime, args.remote_port, make_abort_uploader(session, abort_marker_path(args.remote_port), lambda: refresh_existing_proxy(session)), args.remote_timeout, runtime_factory)
        allowed_hosts = frozenset({"127.0.0.1", "localhost", *args.allow_host})
        server.RequestHandlerClass = make_handler(bridge, allowed_hosts=allowed_hosts)
        print(json.dumps({"event": "ready", "port": args.port}), flush=True)
        server.serve_forever()
    finally:
        server.server_close()
        # Process exit closes our sockets. Never invoke kernel shutdown/interrupt.


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"event": "startup_error", "type": type(error).__name__}), flush=True)
        raise SystemExit(1) from None
