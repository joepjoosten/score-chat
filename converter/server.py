"""Turns a PDF of sheet music into LilyPond with sheet-to-ly's recognizer.

POST /convert with the PDF as the body answers 200 {"source": ..., "systems": ...},
or 422 {"error": ...} with a reason fit to show when the PDF can't be converted.
`systems` holds what a review needs for each `% system N` marker in the source:
the scanned staves, the recognizer's confidence and what it doubts. The models
load before the port opens, so an open port means ready. One conversion runs at
a time, which is what the instance's memory is sized for.
"""

import base64
import json
import math
import os
import re
import signal
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from collections import defaultdict
from pathlib import Path

import cv2
import pymupdf

from sheet2ly.pipeline import default_checkpoints, device, load_image, load_models, transcribe

MAX_PDF_BYTES = int(os.environ.get("MAX_PDF_BYTES", 50 * 1024 * 1024))
# About 45 s per page on 4 vCPUs, against the 13 minutes a queue consumer allows.
MAX_PAGES = int(os.environ.get("MAX_PAGES", 15))
# load_image renders at 250 dpi: an A0 page is about 8300 x 11700 pixels.
MAX_PAGE_POINTS = 3400
# Plenty to read every note, and small enough to send to a model.
MAX_STRIP_WIDTH = 2000
STRIP_JPEG_QUALITY = 80
LOW_CONFIDENCE = 0.8
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


def with_system_markers(source: str, strips) -> str:
    """Marks where each system starts, and breaks the score where the scan does.

    Each staff's body has one line per bar, and a `bar:` token ends one. If the
    two ever disagree, the source stays as it is: a review then links no systems
    to the score, which beats linking the wrong ones.
    """
    by_staff = defaultdict(list)
    for strip in strips:
        by_staff[strip.index].append(strip)
    staves = iter(sorted(by_staff))
    usable = True

    def mark(match: re.Match) -> str:
        nonlocal usable
        staff = next(staves, None)
        lines = match.group(1).split("\n    ")
        if staff is None:
            usable = False
            return match.group(0)
        marked, line = [], 0
        for position, strip in enumerate(by_staff[staff]):
            bars = sum(token.startswith("bar:") for token in strip.tokens)
            marked.append(f"% system {strip.system + 1}")
            # One staff is enough: a break applies to the whole score.
            if position and staff == min(by_staff):
                marked.append("\\break")
            marked += lines[line : line + bars]
            line += bars
        # What follows the last bar line, if anything, belongs to the last system.
        usable = usable and line in (len(lines), len(lines) - 1)
        marked += lines[line:]
        return "\\new Staff {\n    " + "\n    ".join(marked) + "\n  }"

    result = re.sub(r"\\new Staff \{\n    (.*?)\n  \}", mark, source, flags=re.DOTALL)
    return result if usable and next(staves, None) is None else source


def describe_flags(strip, staves: int) -> list[str]:
    """What the recognizer doubts about a staff, in a reader's words."""
    described = []
    for flag in strip.flags:
        rhythm = re.fullmatch(r"measure (\d+) voice (\d+): (\S+) ≠ (\S+)", flag)
        if rhythm:
            bar, voice, found, expected = rhythm.groups()
            where = f"Bar {bar}" if voice == "1" else f"Bar {bar}, voice {voice}"
            described.append(f"{where} adds up to {found}, not {expected}")
        else:
            described.append(re.sub(r"^measure", "Bar", flag))
    if strip.uncertain:
        bars = ", ".join(str(bar) for bar, _ in strip.uncertain)
        described.append(f"Unsure about bar{'s' if len(strip.uncertain) > 1 else ''} {bars}")
    if not described and math.exp(strip.logp) < LOW_CONFIDENCE:
        described.append("Low confidence")
    return [f"Staff {strip.index + 1}: {text}" for text in described] if staves > 1 else described


def encode_strip(image) -> str:
    height, width = image.shape[:2]
    if width > MAX_STRIP_WIDTH:
        size = (MAX_STRIP_WIDTH, round(height * MAX_STRIP_WIDTH / width))
        image = cv2.resize(image, size, interpolation=cv2.INTER_AREA)
    _, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, STRIP_JPEG_QUALITY])
    return base64.b64encode(encoded.tobytes()).decode()


def review_systems(strips) -> list[dict]:
    by_system = defaultdict(list)
    for strip in strips:
        by_system[strip.system].append(strip)
    return [
        {
            "system": system + 1,
            "confidence": round(min(math.exp(strip.logp) for strip in staves), 3),
            "flags": [flag for strip in staves for flag in describe_flags(strip, len(staves))],
            "images": [encode_strip(strip.image) for strip in staves if strip.image is not None],
        }
        for system, staves in sorted(by_system.items())
    ]


class Converter:
    def __init__(self):
        self.device = device()
        strip, staff = default_checkpoints()
        self.strip_model, self.staff_model = load_models(strip, staff, self.device)

    def convert(self, data: bytes) -> dict:
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / "input.pdf")
            Path(path).write_bytes(data)
            check_pdf(path)
            pages = load_image(path)
        source, report, strips = transcribe(pages, self.strip_model, self.staff_model, self.device)
        if not report:
            raise Rejected("No music staves were found in this PDF.")
        return {"source": with_system_markers(source, strips), "systems": review_systems(strips)}


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
                return self.answer(200, converter.convert(self.rfile.read(length)))
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
