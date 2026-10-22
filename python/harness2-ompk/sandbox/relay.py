"""Expose the reviewed model-only Unix gateway on sandbox loopback."""
import os, select, socket, socketserver
SOCKET="/gateway/model.sock"
class Relay(socketserver.BaseRequestHandler):
    def handle(self):
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as upstream:
            upstream.settimeout(65)
            upstream.connect(SOCKET)
            for source in (self.request,upstream): source.settimeout(65)
            while True:
                ready,_,_=select.select([self.request,upstream],[],[],65)
                if not ready: return
                for source in ready:
                    data=source.recv(65536)
                    if not data: return
                    (upstream if source is self.request else self.request).sendall(data)
class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address=True
    daemon_threads=True
with Server(("127.0.0.1",8000),Relay) as server:
    server.serve_forever()
