"""Turns a PDF of sheet music into LilyPond with sheet-to-ly's recognizer.

POST /convert with the PDF as the body answers 200 {"source": ...}, or 422
{"error": ...} with a reason fit to show when the PDF can't be converted. The
models load before the port opens, so an open port means ready. One conversion
runs at a time, which is what the instance's memory is sized for.
"""

import json
import os
import signal
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pymupdf

from sheet2ly.pipeline import default_checkpoints, device, load_image, load_models, transcribe

MAX_PDF_BYTES = int(os.environ.get("MAX_PDF_BYTES", 50 * 1024 * 1024))
# About 45 s per page on 4 vCPUs, against the 13 minutes a queue consumer allows.
MAX_PAGES = int(os.environ.get("MAX_PAGES", 15))
# load_image renders at 250 dpi: an A0 page is about 8300 x 11700 pixels.
MAX_PAGE_POINTS = 3400
PORT = 8080


class Rejected(Exception):
    """A PDF that can't be converted, with a reason fit to show."""


def check_pdf(path: str) -> None:
    try:
        document = pymupdf.open(path)
    except Exception as error:
        raise Rejected("This file could not be read as a PDF.") from error
    with document:
        if document.needs_pass:
            raise Rejected("This PDF is password protected.")
        if document.page_count == 0:
            raise Rejected("This PDF has no pages.")
        if document.page_count > MAX_PAGES:
            raise Rejected(f"This PDF has {document.page_count} pages. Convert at most {MAX_PAGES} at a time.")
        if any(max(page.rect.width, page.rect.height) > MAX_PAGE_POINTS for page in document):
            raise Rejected("This PDF has pages larger than A0.")


class Converter:
    def __init__(self):
        self.device = device()
        strip, staff = default_checkpoints()
        self.strip_model, self.staff_model = load_models(strip, staff, self.device)

    def convert(self, data: bytes) -> str:
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / "input.pdf")
            Path(path).write_bytes(data)
            check_pdf(path)
            pages = load_image(path)
        source, report, _ = transcribe(pages, self.strip_model, self.staff_model, self.device)
        if not report:
            raise Rejected("No music staves were found in this PDF.")
        return source


def make_handler(converter: Converter):
    class Handler(BaseHTTPRequestHandler):
        def answer(self, status: int, body: dict) -> None:
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_POST(self):
            if self.path != "/convert":
                return self.answer(404, {"error": "Not found."})
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_PDF_BYTES:
                self.close_connection = True
                return self.answer(422, {"error": "This PDF is too large."})
            try:
                return self.answer(200, {"source": converter.convert(self.rfile.read(length))})
            except Rejected as error:
                return self.answer(422, {"error": str(error)})
            except BrokenPipeError:
                # The caller gave up; the queue delivers the job again.
                self.close_connection = True

    return Handler


if __name__ == "__main__":
    # As PID 1 this process would ignore SIGTERM, which is how an idle container
    # is put to sleep. Stopping mid-conversion is fine: the queue delivers it again.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    server = HTTPServer(("0.0.0.0", PORT), make_handler(Converter()))
    print(f"Converter listening on {PORT}", flush=True)
    server.serve_forever()
