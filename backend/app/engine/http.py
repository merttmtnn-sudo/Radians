"""HTTP access to IRSA: polite retries, a shared concurrency limit, and multi-range reads.

IRSA facts this module is built around (see docs/BUILD_NOTES.md §2):
- One request may carry at most 100 byte ranges. With more, IRSA ignores the Range header and
  answers 200 with the whole 65 MB file. So ranges are sent in chunks of <= 100, and a 200 answer
  to a ranged request is closed unread and treated as an error.
- Several ranges come back as multipart/byteranges, one range as a plain 206.
- When IRSA is busy it answers 429 (with Retry-After) or 502-504.
"""
from __future__ import annotations

import random
import re
import threading
import time
from dataclasses import dataclass, field

import requests

from . import settings
from .. import irsa

MAX_RANGES = 100
RETRY_STATUS = {429, 502, 503, 504}
USER_AGENT = "Radians/0.1 (NASA Space Apps 2026; python-requests)"


class RangeNotHonoured(IOError):
    """The server sent the whole file instead of the requested byte ranges."""


@dataclass
class Stats:
    """Counters for the timing script and /api/health."""
    requests: int = 0
    bytes: int = 0
    retries: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add(self, nbytes: int, retried: bool = False):
        with self.lock:
            self.requests += 1
            self.bytes += nbytes
            self.retries += int(retried)


class Http:
    """A small client around a requests-like session.

    `session` needs .get(url, headers=, params=, timeout=, stream=) returning an object with
    .status_code, .headers, .content and .close(); tests pass a fake one.
    """

    def __init__(self, session=None, concurrency: int = settings.IRSA_CONCURRENCY, tries: int = 4,
                 sleep=time.sleep):
        shared = session is None
        if session is None:
            session = requests.Session()
            adapter = requests.adapters.HTTPAdapter(pool_connections=4, pool_maxsize=max(16, concurrency * 2))
            session.mount("https://", adapter)
            session.headers["User-Agent"] = USER_AGENT
        self.shared = shared                 # the real network: IRSA requests take a process-wide slot
        self.session = session
        self.slots = threading.BoundedSemaphore(concurrency)
        self.tries = tries
        self.sleep = sleep
        self.pause_until = 0.0          # set by a 429: every thread waits until then
        self.stats = Stats()

    def _backoff(self, r, attempt: int) -> float:
        """Seconds to wait before trying again: what the server asks for, else a growing pause."""
        asked = (r.headers.get("Retry-After") or "").strip()
        if asked.replace(".", "", 1).isdigit():
            return min(60.0, max(0.5, float(asked)))
        return min(60.0, 1.5 * 2 ** attempt + random.uniform(0.0, 1.0))

    def get(self, url: str, headers: dict | None = None, params: dict | None = None,
            timeout=(10, 90), tries: int | None = None):
        """GET with retries on network errors and 'busy' statuses. Other errors fail at once.
        tries: how many attempts (default: the client's own); optional services pass 1."""
        wants_range = "Range" in (headers or {})
        problem = "no attempt made"
        tries = tries or self.tries
        for attempt in range(tries):
            last_try = attempt == tries - 1
            hold = self.pause_until - time.time()
            if hold > 0:
                self.sleep(min(hold, 60.0))
            try:
                with (irsa.slot(url) if self.shared else self.slots):
                    resp = self.session.get(url, headers=headers, params=params, timeout=timeout, stream=wants_range)
                    status = resp.status_code
                    if status == 200 and wants_range:
                        resp.close()                    # a whole 65 MB file: close it unread
                        raise RangeNotHonoured(f"server ignored the Range header for {url}")
                    if status == 200 or status == 206:
                        self.stats.add(len(resp.content), attempt > 0)   # body read inside the slot
                        return resp
                    resp.close()
            except requests.RequestException as err:
                problem = str(err)
                if last_try:
                    raise
                self.sleep(attempt + 1.0)
                continue
            problem = f"HTTP {status}"
            if status not in RETRY_STATUS or last_try:
                raise requests.HTTPError(f"HTTP {status} for {url}")
            wait = self._backoff(resp, attempt)
            if status == 429:                           # everyone backs off, not just this thread
                self.pause_until = max(self.pause_until, time.time() + wait)
            self.sleep(wait)
        raise requests.RequestException(f"giving up on {url}: {problem}")

    def get_ranges(self, url: str, ranges: list[tuple[int, int | None]]) -> list[bytes]:
        return self.fetch_ranges(url, ranges)[0]

    def fetch_ranges(self, url: str, ranges: list[tuple[int, int | None]]) -> tuple[list[bytes], int | None]:
        """Fetch byte ranges, each (first, last) with last inclusive; a negative first with
        last=None means a suffix range (the last -first bytes). Returns the bytes in the same order
        and the file size. Uses as few requests as the 100-range limit allows."""
        out: dict[tuple, bytes] = {}
        total_size = None
        for chunk in (ranges[k:k + MAX_RANGES] for k in range(0, len(ranges), MAX_RANGES)):
            spec = ",".join(f"{a}" if b is None else f"{a}-{b}" for a, b in chunk)
            r = self.get(url, headers={"Range": "bytes=" + spec})
            got, size = parse_ranged_response(r)
            total_size = size if size is not None else total_size
            out.update(got)
        result = []
        for a, b in ranges:
            if b is None:                               # suffix range: resolve with the file size
                a, b = total_size + a, total_size - 1
            part = out.get((a, b))
            if part is None or len(part) != b - a + 1:
                raise IOError(f"byte range {a}-{b} missing or short in the answer from {url}")
            result.append(part)
        return result, total_size


_CRANGE = re.compile(rb"bytes\s+(\d+)-(\d+)/(\d+|\*)", re.I)


def _multipart_parts(body: bytes, delim: bytes):
    """Yield (first, last, total, data) for every part of a multipart/byteranges body. Each part's
    data is cut by its declared length, so boundary-like bytes inside the data cannot confuse it."""
    at = body.index(delim)
    while not body.startswith(b"--", at + len(delim)):
        head_from = at + len(delim)
        head_to = body.index(b"\r\n\r\n", head_from)
        rng = _CRANGE.search(body, head_from, head_to)
        if rng is None:
            raise IOError("multipart part without Content-Range")
        first, last = int(rng.group(1)), int(rng.group(2))
        total = None if rng.group(3) == b"*" else int(rng.group(3))
        data_from = head_to + 4
        data_to = data_from + (last - first + 1)
        yield first, last, total, body[data_from:data_to]
        at = body.index(delim, data_to)


def parse_ranged_response(r) -> tuple[dict[tuple[int, int], bytes], int | None]:
    """{(first, last): bytes} from a 206 answer, plus the total file size if the server said."""
    ctype = r.headers.get("Content-Type", "")
    if "multipart/byteranges" in ctype.lower():
        found = re.search(r'boundary="?([^";\s]+)"?', ctype)
        if found is None:
            raise IOError("multipart answer without a boundary")
        pieces, size = {}, None
        for first, last, total, data in _multipart_parts(r.content, b"--" + found.group(1).encode()):
            pieces[(first, last)] = data
            size = total if total is not None else size
        return pieces, size
    rng = _CRANGE.search(r.headers.get("Content-Range", "").encode())
    if rng is None:
        raise IOError("206 answer without Content-Range")
    first, last = int(rng.group(1)), int(rng.group(2))
    return {(first, last): r.content}, (None if rng.group(3) == b"*" else int(rng.group(3)))
