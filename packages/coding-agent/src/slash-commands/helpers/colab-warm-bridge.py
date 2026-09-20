"""Harness-owned loopback transport for an existing Colab kernel; never provisions.

One authenticated, uniquely sessioned WebSocket carries all requests. No request
replay, kernel interruption, prompt mutation, or idle keepalive is performed.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import select
import socket
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PREFIX = "__COLAB_WARM_HTTP__"
ALLOWED = {"/health", "/v1/models", "/v1/chat/completions", "/v1/completions"}
MAX_BODY = 4 * 1024 * 1024


def abort_marker_path(port: int) -> str:
    return f"/content/.ompk-native-abort-{port}"


# Bounded remote read deadline: covers a near-limit prefill on L4 (~155 s at
# ~777 tok/s for 120K tokens) with margin, while keeping a hard cap so a hung
# remote read cannot hold the single slot forever. The kernel-exec timeout is
# set slightly higher so this inner deadline fires first and reports 504.
REMOTE_READ_TIMEOUT_S = 300

def remote_code(method: str, path: str, body: bytes, port: int, rid: str, marker: str, timeout: int = REMOTE_READ_TIMEOUT_S) -> str:
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

    def feed(self, text):
        if self.started:
            self.write(text.encode())
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
        self.buffer = ""
        if remainder:
            self.write(remainder.encode())


class WarmBridge:
    def __init__(self, runtime, remote_port, abort_uploader=None):
        self.runtime = runtime
        self.remote_port = remote_port
        self.lock = threading.Lock()
        self.failed = False
        self._abort_uploader = abort_uploader

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
            remote_code(method, path, body, self.remote_port, rid, abort_marker_path(self.remote_port)),
            # Backstop only: the inner read deadline (REMOTE_READ_TIMEOUT_S)
            # fires first and reports 504; this outer bound catches a hung exec.
            output_hook=output, timeout=REMOTE_READ_TIMEOUT_S + 60, allow_stdin=False,
        )
        if reply.get("content", {}).get("status", reply.get("status")) != "ok" or not relay.started:
            raise RuntimeError("Remote response did not complete")


def make_handler(bridge):
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
            if host not in {"127.0.0.1", "localhost"} or self.headers.get("Origin"):
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
            if bridge.failed:
                self.send_error(503, "Restart this bridge after transport failure; requests are never replayed")
                return
            if not bridge.lock.acquire(blocking=False):
                self.send_error(429, "Single inference slot busy; no queue")
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
            try:
                self.connection.settimeout(30)
                try:
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
                    if not disconnected.is_set():
                        try:
                            self.wfile.write(b"0\r\n\r\n")
                            self.wfile.flush()
                        except OSError:
                            self.close_connection = True
            finally:
                finished.set()
                # A late upload carries a unique request path and cannot cancel
                # a successor even if the file API completes after this request.
                bridge.lock.release()
    return Handler


def make_abort_uploader(session, marker):
    from colab_cli.contents import ContentsClient
    client = ContentsClient(session)

    def upload_abort(rid):
        handle, temporary = tempfile.mkstemp(text=True)
        try:
            with os.fdopen(handle, "w") as file_handle:
                file_handle.write(rid)
            client.upload(temporary, marker + "-" + rid)
        finally:
            os.unlink(temporary)
    return upload_abort


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", required=True)
    parser.add_argument("--port", type=int, default=18082)
    parser.add_argument("--remote-port", type=int, default=8081)
    args = parser.parse_args()
    from colab_cli.common import state
    from colab_cli.runtime import ColabRuntime
    session = state.store.get(args.session)
    if session is None:
        parser.error("Existing Colab session missing; bridge never provisions or replaces a runtime")
    # Bind first: an occupied port must not open a kernel connection.
    server = ThreadingHTTPServer(("127.0.0.1", args.port), BaseHTTPRequestHandler)
    server.daemon_threads = True
    try:
        # Mirror the working prototype attach exactly: the CLI-maintained kernel
        # ID. ColabRuntime silently creates a kernel when no ID is supplied, so a
        # missing stored ID is a hard error, never an implicit replacement.
        kernel_id = session.kernel_id
        if not isinstance(kernel_id, str) or not kernel_id:
            raise RuntimeError("No stored kernel ID for this session; reconnect the existing session explicitly. The bridge never creates a kernel.")
        runtime = ColabRuntime(session.url, session.token, kernel_id=kernel_id, session_id=str(uuid.uuid4()))
        runtime.kernel_client
        bridge = WarmBridge(runtime, args.remote_port, make_abort_uploader(session, abort_marker_path(args.remote_port)))
        server.RequestHandlerClass = make_handler(bridge)
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
