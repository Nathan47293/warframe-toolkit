#!/usr/bin/env python3
"""
Warframe Mod Flip Tracker - Local Server
Serves the HTML app and proxies warframe.market API requests to avoid CORS issues.
Double-click run_flipper.bat or run: python server.py
"""

import http.server
import urllib.request
import urllib.error
import json
import os
import webbrowser
import threading
import time

PORT = 8777
MARKET_API = "https://api.warframe.market"


class FlipperHandler(http.server.SimpleHTTPRequestHandler):
    """Serves static files and proxies /api/* to warframe.market."""

    def do_GET(self):
        if self.path.startswith('/api/'):
            self.proxy_api()
            return
        if self.path == '/':
            self.path = '/warframe_mod_flipper.html'
        super().do_GET()

    def proxy_api(self):
        """Forward request to warframe.market API."""
        api_path = self.path[4:]
        url = MARKET_API + api_path

        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'WarframeModFlipper/1.0',
                'Accept': 'application/json',
                'Language': 'en',
                'Platform': 'pc',
            })
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Length', len(data))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            try:
                self.send_response(e.code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode())
            except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                pass
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass
        except Exception as e:
            try:
                self.send_response(502)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode())
            except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                pass

    def handle(self):
        """Override to suppress connection errors from crashing the server."""
        try:
            super().handle()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass

    def log_message(self, format, *args):
        pass


def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    server = http.server.HTTPServer(('127.0.0.1', PORT), FlipperHandler)
    print(f"Warframe Mod Flip Tracker running at http://localhost:{PORT}")
    print("Press Ctrl+C to stop.\n")

    def open_browser():
        time.sleep(0.5)
        webbrowser.open(f'http://localhost:{PORT}')
    threading.Thread(target=open_browser, daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == '__main__':
    main()
