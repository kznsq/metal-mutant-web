"""Local web server for Metal Mutant in the browser: the page and the engine from this folder,
the game's own files under /game/ from a game folder (read only; GET and HEAD only).

    python3 serve.py [--port 8791] [--game /path/to/METALMUT]

Without --game the folder `game` next to this file is used. /game/index.json lists the game
files, so the page can load them all; when there are none, the page asks for the folder instead.
"""
import argparse
import errno
import functools
import http.server
import json
import os
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static files from this folder; /game/NAME from the game folder."""
    game_dir = os.path.join(HERE, "game")
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json"}

    def end_headers(self):
        # Never cached: the browser always loads the current page, engine and game files.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def translate_path(self, path):
        # /game/NAME is NAME in the game folder; any directory part of NAME is ignored.
        parts = urllib.parse.urlsplit(path).path
        if parts.startswith("/game/"):
            name = os.path.basename(urllib.parse.unquote(parts[len("/game/"):]))
            return os.path.join(self.game_dir, name)
        return super().translate_path(path)

    def do_GET(self):
        # /game/index.json: the name and size of every file in the game folder (hidden files and
        # subfolders left out), listed afresh on each request.
        if urllib.parse.urlsplit(self.path).path == "/game/index.json":
            if not os.path.isdir(self.game_dir):
                self.send_error(404, "no game folder")
                return
            files = [{"name": n, "size": os.path.getsize(os.path.join(self.game_dir, n))}
                     for n in sorted(os.listdir(self.game_dir))
                     if not n.startswith(".") and os.path.isfile(os.path.join(self.game_dir, n))]
            body = json.dumps(files).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--port", type=int, default=8791)
    ap.add_argument("--game", help="folder with the original game files (default: ./game)")
    args = ap.parse_args()
    if args.game:
        Handler.game_dir = os.path.abspath(args.game)
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port),
                                                 functools.partial(Handler, directory=HERE))
    except OSError as ex:
        if ex.errno != errno.EADDRINUSE:
            raise
        sys.exit(f"Port {args.port} is already in use (another server is running there). "
                 f"Stop that server, or choose another port: --port {args.port + 1}")
    where = Handler.game_dir if os.path.isdir(Handler.game_dir) else "none (the page will ask for the folder)"
    print(f"http://127.0.0.1:{args.port}/   game files: {where}   (Ctrl+C stops the server)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")


if __name__ == "__main__":
    main()
