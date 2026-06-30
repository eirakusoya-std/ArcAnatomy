from __future__ import annotations

from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
from urllib.parse import urlparse

from .logic import dumps, generate_payload


ROOT = Path(__file__).resolve().parent.parent


class ArcAnatomyHandler(BaseHTTPRequestHandler):
    def do_HEAD(self) -> None:
        if urlparse(self.path).path != "/health":
            self.send_error(404)
            return
        self.send_response(200)
        self._cors()
        self.send_header("content-type", "text/plain")
        self.send_header("content-length", "2")
        self.end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/generate":
            self.send_error(404)
            return
        length = int(self.headers.get("content-length", "0"))
        try:
            request = json.loads(self.rfile.read(length))
            response = generate_payload(request)
            body = dumps(response).encode("utf-8")
            self.send_response(200)
            self._cors()
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:
            body = json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8")
            self.send_response(500)
            self._cors()
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/health":
            body = b"ok"
            self.send_response(200)
            self._cors()
            self.send_header("content-type", "text/plain")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def log_message(self, format: str, *args: object) -> None:
        print(f"[arc-anatomy-python] {self.address_string()} {format % args}")

    def _cors(self) -> None:
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-methods", "GET,POST,OPTIONS")
        self.send_header("access-control-allow-headers", "content-type")


def main() -> None:
    server = HTTPServer(("127.0.0.1", 8765), ArcAnatomyHandler)
    print("Arc Anatomy Python API running at http://127.0.0.1:8765")
    server.serve_forever()


if __name__ == "__main__":
    main()
