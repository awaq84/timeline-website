#!/usr/bin/env python3
"""Static server for the projection wall, with HTTP caching disabled.

`python3 -m http.server` lets the browser cache aggressively, so an edited
main.js or effects.js can silently keep running the old version — which looks
exactly like "the change did nothing". This sends no-store on everything, so a
plain reload always picks up the latest code.

    python3 serve.py            # http://localhost:8091
    python3 serve.py 9000       # a different port
"""

import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8091


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Quiet by default; a request log per frame-asset is just noise here.
        pass


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), NoCacheHandler) as httpd:
        print(f"projection wall → http://localhost:{PORT}/   (caching disabled)")
        print("ctrl-c to stop")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()
