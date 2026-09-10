from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import shutil


PORT = 4173
ROOT = Path(__file__).resolve().parent / "dist"
TITLE_PATH = "/wikipedia-latest-titles.txt"
TITLE_SOURCES = [
    (
        "S3",
        "https://charta-public.s3.us-east-2.amazonaws.com/interview/wikipedia-latest-titles.txt",
    ),
    (
        "Notion",
        "https://file.notion.so/f/f/c7bb86eb-fa3b-4667-85b8-304db4bd37fc/64c076a6-b90c-4fad-887b-c60cacb5c2db/wikipedia-latest-titles.txt?table=block&id=3d5a0739-fda7-80aa-a720-c9de99b0209e&spaceId=c7bb86eb-fa3b-4667-85b8-304db4bd37fc&expirationTimestamp=1789084800000&signature=x2lh1MYiKYX8JPCte8canfDI4FlJHScD9Rpwtx1Sr0k&downloadName=wikipedia-latest-titles.txt",
    ),
]


class AutocompleteHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        # Serve normal browser assets from dist/.
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        # Route dataset requests through the proxy; everything else is static.
        if self.path.split("?", 1)[0] == TITLE_PATH:
            self.proxy_titles(head_only=False)
            return

        super().do_GET()

    def do_HEAD(self):
        # Support cheap readiness/header checks without downloading the dataset.
        if self.path.split("?", 1)[0] == TITLE_PATH:
            self.proxy_titles(head_only=True)
            return

        super().do_HEAD()

    def proxy_titles(self, head_only):
        # Stream the first available remote title file back as a same-origin response.
        errors = []

        for label, url in TITLE_SOURCES:
            try:
                headers = {
                    "User-Agent": "WikipediaAutocompleteMVP/1.0 local-dev",
                }
                range_header = self.headers.get("Range")

                if range_header:
                    headers["Range"] = range_header

                request = Request(
                    url,
                    headers=headers,
                    method="HEAD" if head_only else "GET",
                )

                with urlopen(request, timeout=30) as response:
                    self.send_response(response.status)
                    self.send_header("Content-Type", "text/plain; charset=utf-8")

                    content_length = response.headers.get("Content-Length")
                    if content_length:
                        self.send_header("Content-Length", content_length)

                    accept_ranges = response.headers.get("Accept-Ranges")
                    if accept_ranges:
                        self.send_header("Accept-Ranges", accept_ranges)

                    content_range = response.headers.get("Content-Range")
                    if content_range:
                        self.send_header("Content-Range", content_range)

                    self.end_headers()
                    if not head_only:
                        shutil.copyfileobj(response, self.wfile)
                    return
            except (HTTPError, URLError, TimeoutError) as error:
                errors.append(f"{label}: {error}")

        self.send_response(502)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(
            ("Could not fetch title file.\n" + "\n".join(errors)).encode("utf-8")
        )


def main():
    # Threading keeps the app responsive while the large title file streams.
    server = ThreadingHTTPServer(("", PORT), AutocompleteHandler)
    print(f"Serving autocomplete MVP at http://localhost:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
