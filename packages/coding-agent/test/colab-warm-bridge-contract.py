"""Offline contracts: real loopback sockets, no Colab credentials or inference."""
import importlib.util
import http.client
import json
import socket
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

source = Path(__file__).resolve().parents[1] / "src/slash-commands/helpers/colab-warm-bridge.py"
spec = importlib.util.spec_from_file_location("native_colab_bridge", source)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class RuntimeFixture:
    def __init__(self):
        self.kernel_client = self
        self.started = threading.Event()
        self.release = threading.Event()
        self.aborted = threading.Event()
        self.mode = "stream"
        self.requests = 0

    def execute_interactive(self, code, output_hook, timeout, allow_stdin):
        self.requests += 1
        def emit(text):
            output_hook({"msg_type": "stream", "content": {"name": "stdout", "text": text}})
        if self.mode == "failure":
            raise RuntimeError("deterministic remote transport failure")
        if self.mode == "headers":
            self.started.set()
            self.release.wait(2)
        emit(bridge.PREFIX + json.dumps({"status": 200, "content_type": "text/event-stream"}) + "\n")
        emit('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n')
        self.started.set()
        if self.mode in {"stream", "cancel"}:
            self.release.wait(2)
        emit('data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"completion_tokens":1}}\n\n')
        emit("data: [DONE]\n\n")
        if self.mode == "terminal":
            self.release.wait(2)
        return {"content": {"status": "ok"}}

    def abort(self, rid):
        self.aborted.set()
        self.release.set()


class HttpContracts(unittest.TestCase):
    def setUp(self):
        self.runtime = RuntimeFixture()
        self.bridge = bridge.WarmBridge(self.runtime, 8081, self.runtime.abort)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), bridge.make_handler(self.bridge))
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.connections = []

    def tearDown(self):
        self.runtime.release.set()
        for connection in self.connections:
            connection.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def connect(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        self.connections.append(connection)
        return connection

    def post(self, connection):
        connection.request("POST", "/v1/chat/completions", b'{"stream":true}')
        return connection.getresponse()

    def wait_released(self):
        self.assertTrue(self.bridge.lock.acquire(timeout=2), "owned request did not release")
        self.bridge.lock.release()

    def test_incremental_tools_usage_finish_and_connection_reuse(self):
        connection = self.connect()
        response = self.post(connection)
        self.assertEqual(response.status, 200)
        self.assertIn(b"tool_calls", response.readline())
        self.assertFalse(self.runtime.release.is_set(), "first delta must precede remote completion")
        other = self.post(self.connect())
        self.assertEqual(other.status, 429)
        other.read()
        self.runtime.release.set()
        remainder = response.read()
        self.assertIn(b'"finish_reason":"tool_calls"', remainder)
        self.assertIn(b'"completion_tokens":1', remainder)
        self.assertIn(b"[DONE]", remainder)
        self.wait_released()
        self.runtime.mode = "complete"
        reused_socket = connection.sock
        following = self.post(connection)
        self.assertEqual(following.status, 200)
        following.read()
        self.assertIs(connection.sock, reused_socket)
        self.assertEqual(self.runtime.requests, 2, "busy request must not be queued")

    def test_wire_close_cancels_and_next_request_succeeds(self):
        self.runtime.mode = "cancel"
        connection = self.connect()
        response = self.post(connection)
        response.readline()
        connection.sock.shutdown(socket.SHUT_RDWR)
        response.close()
        connection.close()
        self.assertTrue(self.runtime.aborted.wait(1))
        self.wait_released()
        self.assertFalse(self.bridge.failed)
        self.runtime.mode = "complete"
        following = self.post(self.connect())
        self.assertEqual(following.status, 200)
        following.read()

    def test_close_before_headers_does_not_poison_bridge(self):
        self.runtime.mode = "headers"
        connection = self.connect()
        connection.request("POST", "/v1/chat/completions", b"{}")
        self.assertTrue(self.runtime.started.wait(1))
        connection.sock.shutdown(socket.SHUT_RDWR)
        connection.close()
        self.assertTrue(self.runtime.aborted.wait(1))
        self.wait_released()
        self.assertFalse(self.bridge.failed)
        self.runtime.mode = "complete"
        following = self.post(self.connect())
        self.assertEqual(following.status, 200)
        following.read()

    def test_close_after_done_before_terminal_chunk_recovers(self):
        self.runtime.mode = "terminal"
        connection = self.connect()
        response = self.post(connection)
        while True:
            line = response.readline()
            self.assertTrue(line)
            if b"[DONE]" in line:
                break
        connection.sock.shutdown(socket.SHUT_RDWR)
        response.close()
        connection.close()
        self.runtime.release.set()
        self.wait_released()
        self.assertFalse(self.bridge.failed)
        self.runtime.mode = "complete"
        following = self.post(self.connect())
        self.assertEqual(following.status, 200)
        following.read()

    def test_remote_failure_is_not_replayed_and_requires_reconnect(self):
        self.runtime.mode = "failure"
        response = self.post(self.connect())
        self.assertEqual(response.status, 502)
        response.read()
        self.wait_released()
        next_response = self.post(self.connect())
        self.assertEqual(next_response.status, 503)
        next_response.read()
        self.assertEqual(self.runtime.requests, 1)


class RemoteCodeContracts(unittest.TestCase):
    def test_marker_isolation_body_fidelity_and_following_request(self):
        bodies = []
        payload = b'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
        class Remote(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_POST(self):
                bodies.append(self.rfile.read(int(self.headers["Content-Length"])))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Remote)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                marker = str(Path(directory) / "abort")
                body = b'{ "messages" : [{"role":"user","content":"unchanged prefix"}], "stream": true }'
                for rid, contents, expected_visible in [("old", "old", False), ("new", "old", True), ("next", None, True)]:
                    if contents is not None:
                        Path(marker + "-" + rid).write_text(contents)
                    output = []
                    def capture(*args, end="\n", **_):
                        output.append(" ".join(str(value) for value in args) + end)
                    code = bridge.remote_code("POST", "/v1/chat/completions", body, server.server_port, rid, marker)
                    exec(compile(code, "remote-contract", "exec"), {"print": capture})
                    result = "".join(output)
                    self.assertEqual('"content":"ok"' in result, expected_visible)
                    self.assertFalse(Path(marker + "-" + rid).exists())
                self.assertEqual(bodies, [body, body, body])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)

    def test_real_marker_interrupts_stalled_headers_sse_and_json(self):
        for mode in ("headers", "sse", "json"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                arrived = threading.Event()
                release = threading.Event()
                finished = threading.Event()
                failures = []
                class StalledRemote(BaseHTTPRequestHandler):
                    def log_message(self, *_):
                        pass
                    def do_POST(self):
                        self.rfile.read(int(self.headers["Content-Length"]))
                        try:
                            if mode == "headers":
                                arrived.set()
                                release.wait(3)
                            self.send_response(200)
                            self.send_header("Content-Type", "text/event-stream" if mode == "sse" else "application/json")
                            self.send_header("Content-Length", "100000")
                            self.end_headers()
                            self.wfile.write(b"data: first\n\n" if mode == "sse" else b"{")
                            self.wfile.flush()
                            arrived.set()
                            release.wait(3)
                        except OSError:
                            pass
                server = ThreadingHTTPServer(("127.0.0.1", 0), StalledRemote)
                server_thread = threading.Thread(target=server.serve_forever, daemon=True)
                server_thread.start()
                marker = str(Path(directory) / "marker")
                code = bridge.remote_code("POST", "/v1/chat/completions", b"{}", server.server_port, "owned", marker)
                def execute():
                    try:
                        exec(compile(code, "stalled-contract", "exec"), {"print": lambda *_, **__: None})
                    except Exception as error:
                        failures.append(type(error).__name__)
                    finally:
                        finished.set()
                execution = threading.Thread(target=execute, daemon=True)
                execution.start()
                try:
                    self.assertTrue(arrived.wait(1))
                    Path(marker + "-owned").write_text("stale-request")
                    self.assertFalse(finished.wait(0.1), "stale cancellation interrupted owned request")
                    Path(marker + "-owned").write_text("owned")
                    self.assertTrue(finished.wait(1), "marker did not interrupt stalled HTTP read")
                    self.assertEqual(failures, [])
                    self.assertFalse(Path(marker + "-owned").exists())
                finally:
                    release.set()
                    server.shutdown()
                    server.server_close()
                    execution.join(2)
                    server_thread.join(2)

    def test_timeout_phases(self):
        # Three phases: pre-header -> 504 JSON; mid-SSE -> error frame + [DONE];
        # mid-JSON -> transport failure (re-raise), not corrupted SSE-in-JSON.
        for phase in ("pre_header", "mid_sse", "mid_json"):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as directory:
                class StalledRemote(BaseHTTPRequestHandler):
                    def log_message(self, *_):
                        pass
                    def do_POST(self):
                        self.rfile.read(int(self.headers["Content-Length"]))
                        if phase == "pre_header":
                            import time
                            time.sleep(5)  # exceed the 1s test timeout
                            return
                        self.send_response(200)
                        self.send_header("Content-Type", "text/event-stream" if phase == "mid_sse" else "application/json")
                        self.send_header("Content-Length", "100000")
                        self.end_headers()
                        self.wfile.write(b"data: first\n\n" if phase == "mid_sse" else b"{")
                        self.wfile.flush()
                        import time
                        time.sleep(5)  # stall mid-body past the 1s timeout
                server = ThreadingHTTPServer(("127.0.0.1", 0), StalledRemote)
                server_thread = threading.Thread(target=server.serve_forever, daemon=True)
                server_thread.start()
                marker = str(Path(directory) / "marker")
                code = bridge.remote_code("POST", "/v1/chat/completions", b"{}", server.server_port, "t", marker, timeout=1)
                output = []
                failures = []
                def capture(*args, end="\n", **_):
                    output.append(" ".join(str(value) for value in args) + end)
                try:
                    exec(compile(code, "timeout-contract", "exec"), {"print": capture})
                except Exception as error:
                    failures.append(type(error).__name__)
                result = "".join(output)
                try:
                    # Parse the PREFIX metadata line as JSON; assert semantics, not whitespace.
                    meta_line = next((line for line in result.splitlines() if line.startswith(bridge.PREFIX)), "")
                    meta = json.loads(meta_line[len(bridge.PREFIX):]) if meta_line else {}
                    if phase == "pre_header":
                        self.assertEqual(meta.get("status"), 504)
                        body = result.split(meta_line, 1)[1] if meta_line else ""
                        self.assertIn("remote read timeout", body)
                        self.assertEqual(failures, [])
                    elif phase == "mid_sse":
                        self.assertEqual(meta.get("status"), 200)
                        self.assertIn('"type":"timeout"', result)
                        self.assertIn("[DONE]", result)
                        self.assertEqual(failures, [])
                    else:
                        self.assertEqual(meta.get("status"), 200)
                        self.assertNotIn('"type":"timeout"', result)
                        self.assertTrue(failures, "mid-JSON timeout must surface as transport failure")
                finally:
                    server.shutdown()
                    server.server_close()
                    server_thread.join(2)

    def test_fragmented_metadata_and_invalid_envelopes(self):
        frames = []
        statuses = []
        relay = bridge.StreamRelay(lambda status, content: statuses.append((status, content)), frames.append)
        header = bridge.PREFIX + '{"status":200,"content_type":"text/event-stream"}\n'
        relay.feed(header[:10])
        self.assertEqual(statuses, [])
        relay.feed(header[10:] + "data: first\n\n")
        relay.feed("data: [DONE]\n\n")
        self.assertEqual(statuses, [(200, "text/event-stream")])
        self.assertEqual(b"".join(frames), b"data: first\n\ndata: [DONE]\n\n")
        with self.assertRaises(ValueError):
            bridge.StreamRelay(lambda *_: None, lambda *_: None).feed("x" * 32769 + "\n")
        with self.assertRaises(ValueError):
            bridge.StreamRelay(lambda *_: None, lambda *_: None).feed(bridge.PREFIX + '{"status":true}\n')


if __name__ == "__main__":
    unittest.main()
