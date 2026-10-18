"""A small, dependency-free WebSocket implementation (RFC 6455) on asyncio streams.

It supports what the game needs: text frames, ping/pong, close, and messages
split across continuation frames. Both the server side (used by the game) and a
client side (used by example controllers and tests) live here.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import struct
from urllib.parse import urlsplit

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA
MAX_MESSAGE = 4 * 1024 * 1024  # the most a client reads in one frame or message (God's welcome is the biggest)
# The most the server takes from one client in one message. The biggest message a client needs is a few KB (the
# server cuts prompts to 1000 characters, texts to 500, reasons to 300), and a flood of big frames would only tie up
# the event loop. A bigger message, up to MAX_MESSAGE, is read past unkept (MessageTooBig); beyond that the
# connection ends.
SERVER_MAX_MESSAGE = 64 * 1024
SKIP_CHUNK = 64 * 1024  # how much of a message too big to keep is read, and dropped, at a time
CLOSE_SECONDS = 2.0  # how long close() waits for a peer to take the close frame


class ConnectionClosed(Exception):
    pass


class MessageTooBig(Exception):
    """recv() read past a message bigger than the socket's max_message without keeping it; the connection is still
    open. `size` is the message's length in bytes and `limit` the max_message it went over."""

    def __init__(self, size: int, limit: int):
        super().__init__(f"a message of {size} bytes, over the {limit} a message may have")
        self.size, self.limit = size, limit


def accept_key(key: str) -> str:
    return base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()


def apply_mask(data: bytes, key: bytes) -> bytes:
    """XOR data with the 4-byte masking key repeated (RFC 6455 5.3), which masks and unmasks alike. One big-integer
    XOR, not a loop over the bytes: a 4 MiB frame takes milliseconds instead of half a second of the event loop."""
    n = len(data)
    return (int.from_bytes(data, "little") ^ int.from_bytes((key * (n // 4 + 1))[:n], "little")).to_bytes(n, "little")


class WebSocket:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, mask: bool,
                 max_message: int = MAX_MESSAGE, max_skipped: int = 0):
        self.reader = reader
        self.writer = writer
        self.mask = mask  # clients must mask their frames, servers must not
        self.max_message = max_message  # the largest message recv() takes
        # A bigger message of up to max_skipped bytes is read past and dropped (recv() raises MessageTooBig and the
        # connection stays open). A frame or message over both limits ends the connection.
        self.max_skipped = max_skipped
        self.closed = False
        self._send_lock = asyncio.Lock()

    async def _write_frame(self, opcode: int, payload: bytes) -> None:
        header = bytearray([0x80 | opcode])
        mask_bit = 0x80 if self.mask else 0
        n = len(payload)
        if n < 126:
            header.append(mask_bit | n)
        elif n < 1 << 16:
            header.append(mask_bit | 126)
            header += struct.pack("!H", n)
        else:
            header.append(mask_bit | 127)
            header += struct.pack("!Q", n)
        if self.mask:
            key = os.urandom(4)
            header += key
            payload = apply_mask(payload, key)
        async with self._send_lock:
            self.writer.write(bytes(header) + payload)
            await self.writer.drain()

    async def send(self, text: str) -> None:
        if self.closed:
            raise ConnectionClosed()
        try:
            await self._write_frame(OP_TEXT, text.encode())
        except (OSError, RuntimeError) as exc:  # OSError: also TimeoutError, EHOSTUNREACH
            self.closed = True
            raise ConnectionClosed() from exc

    async def _read_frame(self) -> tuple[bool, int, bytes | int]:
        """(fin, opcode, payload). A frame over max_message is read past and dropped, never unmasked or kept, and
        its length (an int) stands in for the payload."""
        b1, b2 = await self.reader.readexactly(2)
        fin, opcode = bool(b1 & 0x80), b1 & 0x0F
        masked, n = bool(b2 & 0x80), b2 & 0x7F
        if n == 126:
            (n,) = struct.unpack("!H", await self.reader.readexactly(2))
        elif n == 127:
            (n,) = struct.unpack("!Q", await self.reader.readexactly(8))
        if opcode & 0x8 and (n > 125 or not fin):
            # RFC 6455 5.5: control frames carry at most 125 bytes and are never fragmented.
            await self.close(1002)
            raise ConnectionClosed("bad control frame")
        if n > self.max_message and not opcode & 0x8:  # a control frame, at most 125 bytes, is always read
            if n > self.max_skipped:
                raise ConnectionClosed("frame too large")
            await self._skip(n + 4 if masked else n)
            return fin, opcode, n
        key = await self.reader.readexactly(4) if masked else b""
        data = await self.reader.readexactly(n)
        if masked:
            data = apply_mask(data, key)
        return fin, opcode, data

    async def _skip(self, n: int) -> None:
        """Read n bytes and drop them, SKIP_CHUNK at a time, so a message too big to keep is never held whole."""
        while n > 0:
            chunk = await self.reader.read(min(n, SKIP_CHUNK))
            if not chunk:
                raise asyncio.IncompleteReadError(b"", n)
            n -= len(chunk)

    async def recv(self) -> str:
        """Return the next text message; raise ConnectionClosed when the peer goes away, and MessageTooBig (with
        the connection still open) for a message over max_message that is not over max_skipped."""
        parts: list[bytes] | None = []  # None once the message is too big to keep: the rest of it is dropped
        size = 0
        try:
            while True:
                fin, opcode, data = await self._read_frame()
                if opcode == OP_PING:
                    async with self._send_lock:
                        await self._raw_control(OP_PONG, data)
                    continue
                if opcode == OP_PONG:
                    continue
                if opcode == OP_CLOSE:
                    await self.close()
                    raise ConnectionClosed()
                if opcode in (OP_TEXT, OP_BINARY, OP_CONT):
                    dropped = isinstance(data, int)
                    size += data if dropped else len(data)
                    if size > max(self.max_message, self.max_skipped):
                        raise ConnectionClosed("message too large")
                    if parts is not None and not dropped and size <= self.max_message:
                        parts.append(data)
                    else:
                        parts = None
                    if fin:
                        if parts is None:
                            raise MessageTooBig(size, self.max_message)
                        return b"".join(parts).decode()
        except (asyncio.IncompleteReadError, OSError) as exc:
            self.closed = True
            raise ConnectionClosed() from exc

    async def _raw_control(self, opcode: int, payload: bytes) -> None:
        payload = payload[:125]  # the most a control frame may carry, so it fits the 7-bit length
        header = bytearray([0x80 | opcode, (0x80 if self.mask else 0) | len(payload)])
        if self.mask:
            key = os.urandom(4)
            header += key
            payload = apply_mask(payload, key)
        self.writer.write(bytes(header) + payload)
        await self.writer.drain()

    async def _send_close(self, code: int) -> None:
        async with self._send_lock:
            await self._raw_control(OP_CLOSE, struct.pack("!H", code))

    async def close(self, code: int = 1000) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            # Bounded, so a peer that has stopped reading cannot hold up whoever closes it.
            await asyncio.wait_for(self._send_close(code), CLOSE_SECONDS)
            self.writer.close()
        except (OSError, RuntimeError):  # TimeoutError is an OSError
            self.writer.transport.abort()

    def abort(self) -> None:
        """Drop the connection at once: no close frame, and nothing still buffered is sent."""
        self.closed = True
        self.writer.transport.abort()


async def server_handshake(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter, headers: dict[str, str],
    max_message: int = SERVER_MAX_MESSAGE, max_skipped: int = MAX_MESSAGE,
) -> WebSocket:
    key = headers.get("sec-websocket-key")
    if not key:
        raise ValueError("missing Sec-WebSocket-Key")
    writer.write(
        (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept_key(key)}\r\n\r\n"
        ).encode()
    )
    await writer.drain()
    return WebSocket(reader, writer, mask=False, max_message=max_message, max_skipped=max_skipped)


async def connect(url: str) -> WebSocket:
    """Open a client connection to a ws:// URL."""
    parts = urlsplit(url)
    if parts.scheme != "ws":
        raise ValueError("only ws:// URLs are supported")
    host, port = parts.hostname or "localhost", parts.port or 80
    reader, writer = await asyncio.open_connection(host, port)
    name = f"[{host}]" if ":" in host else host  # an IPv6 address is bracketed in Host, as in the URL
    key = base64.b64encode(os.urandom(16)).decode()
    path = parts.path or "/"
    writer.write(
        (
            f"GET {path} HTTP/1.1\r\nHost: {name}:{port}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        ).encode()
    )
    await writer.drain()
    status = await reader.readline()
    if b" 101 " not in status:
        writer.close()
        raise ConnectionError(f"handshake failed: {status!r}")
    expected = accept_key(key)
    while True:
        line = (await reader.readline()).decode().strip()
        if not line:
            break
        name, _, value = line.partition(":")
        if name.lower() == "sec-websocket-accept" and value.strip() != expected:
            raise ConnectionError("bad Sec-WebSocket-Accept")
    return WebSocket(reader, writer, mask=True)
