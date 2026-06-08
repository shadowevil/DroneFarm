#!/usr/bin/env python3
"""DroneFarm dev server — serves wwwroot/ with hot reload.

Usage:
    python serve.py [port] [--no-browser]

Any file change under wwwroot/ automatically reloads the browser.
Stdlib only, no dependencies. Ctrl+C to stop.
"""

import json
import os
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wwwroot")
PORT = next((int(a) for a in sys.argv[1:] if a.isdigit()), 8123)
WATCH_INTERVAL = 0.4   # seconds between file scans
POLL_TIMEOUT = 30.0    # how long /__reload holds a request open

_version = 0
_cond = threading.Condition()

# Injected before </body> of every served .html page.
RELOAD_SNIPPET = b"""<script>
(() => {
  let v = null;
  async function poll() {
    try {
      const r = await fetch('/__reload?v=' + (v ?? ''), { cache: 'no-store' });
      const { v: nv } = await r.json();
      if (v !== null && nv !== v) { location.reload(); return; }
      v = nv;
    } catch { await new Promise(r => setTimeout(r, 1000)); }
    poll();
  }
  poll();
})();
</script>
"""


def watch():
    """Bump the version (waking held /__reload requests) when wwwroot changes."""
    global _version
    last = None
    while True:
        snapshot = {}
        for dirpath, _dirs, files in os.walk(ROOT):
            for name in files:
                path = os.path.join(dirpath, name)
                try:
                    snapshot[path] = os.stat(path).st_mtime_ns
                except OSError:
                    pass  # file vanished mid-scan
        if last is not None and snapshot != last:
            with _cond:
                _version += 1
                _cond.notify_all()
            print("change detected -> reload")
        last = snapshot
        time.sleep(WATCH_INTERVAL)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        url = urlparse(self.path)

        # long-poll endpoint: answers when the version changes (or on timeout)
        if url.path == "/__reload":
            try:
                client_v = int(parse_qs(url.query).get("v", [""])[0])
            except ValueError:
                client_v = None
            with _cond:
                if client_v == _version:
                    _cond.wait(POLL_TIMEOUT)
                body = json.dumps({"v": _version}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # serve .html with the reload script injected
        # (?noreload skips injection — used for headless screenshot tests,
        # where the long-poll would stall virtual time)
        path = self.translate_path(url.path)
        if os.path.isdir(path):
            path = os.path.join(path, "index.html")
        if path.endswith(".html") and os.path.isfile(path) and "noreload" not in url.query:
            with open(path, "rb") as f:
                body = f.read()
            if b"</body>" in body:
                body = body.replace(b"</body>", RELOAD_SNIPPET + b"</body>", 1)
            else:
                body += RELOAD_SNIPPET
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        super().do_GET()

    def log_message(self, fmt, *args):
        # keep the console quiet about reload polling
        if args and "/__reload" in str(args[0]):
            return
        super().log_message(fmt, *args)


def main():
    threading.Thread(target=watch, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://127.0.0.1:{PORT}/"
    print(f"DroneFarm dev server: {url}  (hot reload on, Ctrl+C to stop)")
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
