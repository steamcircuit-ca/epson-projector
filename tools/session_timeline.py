#!/usr/bin/env python3
"""Timestamped timeline of a capture: control messages, video, and TCP open/close.

    python3 tools/session_timeline.py captures/Capture4ClientDisconnects.pcapng
    python3 tools/session_timeline.py captures/Capture1.pcapng --no-probes --no-udp
    python3 tools/session_timeline.py captures/Capture2.pcapng --frames

Times are seconds from the first packet in the file. Every TCP connection
on 3620/3621 is reassembled, so each message gets the timestamp of the
packet its first byte arrived in. On port 3621 it decodes the EPRD hello
and every FramebufferUpdate (rect geometry, JPEG sizes; --frames also
prints a short hash per tile, so repeated images are easy to spot).

Repeated UDP discovery traffic is collapsed: a line is printed only when
the (status, length) pair changes. --no-probes hides the app's short-lived
TCP probe connections (status 2 and their replies) and their open/close.

Standard library only; assumes Ethernet link-layer and IPv4.
"""
import argparse
import hashlib
import signal
import struct

CONTROL_PORT = 3620
VIDEO_PORT = 3621


def pcapng_packets(path):
    """Yield (timestamp_seconds, raw_frame) for every Enhanced Packet Block."""
    data = open(path, "rb").read()
    offset, endian, resolution = 0, "<", 1e-6
    while offset + 8 <= len(data):
        block_type, block_len = struct.unpack_from(endian + "II", data, offset)
        if block_type == 0x0A0D0D0A:
            endian = "<" if data[offset + 8:offset + 12] == b"\x4d\x3c\x2b\x1a" else ">"
            block_type, block_len = struct.unpack_from(endian + "II", data, offset)
        elif block_type == 1:  # Interface Description: look for if_tsresol
            opt = offset + 16
            while opt + 4 <= offset + block_len - 4:
                code, length = struct.unpack_from(endian + "HH", data, opt)
                if code == 0:
                    break
                if code == 9:
                    value = data[opt + 4]
                    resolution = 2.0 ** -(value & 0x7F) if value & 0x80 else 10.0 ** -value
                opt += 4 + ((length + 3) // 4) * 4
        elif block_type == 6:
            hi, lo, captured = struct.unpack_from(endian + "III", data, offset + 12)
            yield ((hi << 32) | lo) * resolution, data[offset + 28:offset + 28 + captured]
        if block_len == 0:
            break
        offset += block_len


def read_capture(path):
    """Return (udp_packets, tcp_streams, tcp_events), all timestamps relative."""
    udp, streams, events = [], {}, []
    t0 = None
    for ts, frame in pcapng_packets(path):
        t0 = ts if t0 is None else t0
        ts -= t0
        if frame[12:14] != b"\x08\x00":
            continue
        ip = frame[14:]
        ip = ip[:struct.unpack(">H", ip[2:4])[0]]
        ihl = (ip[0] & 0x0F) * 4
        src = ".".join(map(str, ip[12:16]))
        dst = ".".join(map(str, ip[16:20]))
        l4 = ip[ihl:]
        if ip[9] == 17:
            sport, dport = struct.unpack(">HH", l4[:4])
            if CONTROL_PORT in (sport, dport):
                udp.append((ts, src, sport, dst, dport, l4[8:]))
        elif ip[9] == 6:
            sport, dport, seq = struct.unpack(">HHI", l4[:8])
            if not {sport, dport} & {CONTROL_PORT, VIDEO_PORT}:
                continue
            flags = l4[13]
            key = (src, sport, dst, dport)
            if flags & 0x02 and not flags & 0x10:
                events.append((ts, key, "SYN"))
            if flags & 0x01:
                events.append((ts, key, "FIN"))
            if flags & 0x04:
                events.append((ts, key, "RST"))
            payload = l4[(l4[12] >> 4) * 4:]
            if payload:
                streams.setdefault(key, {}).setdefault(seq, (ts, payload))
    reassembled = {}
    for key, segments in streams.items():
        segments = sorted(segments.items())
        base = segments[0][0]
        buf, marks = bytearray(), []
        for seq, (ts, payload) in segments:
            pos = (seq - base) & 0xFFFFFFFF
            if pos + len(payload) > len(buf):
                if pos > len(buf):
                    buf += b"\0" * (pos - len(buf))
                marks.append((pos, ts))
                buf[pos:pos + len(payload)] = payload
        reassembled[key] = (bytes(buf), marks)
    return udp, reassembled, events


def time_at(marks, offset):
    best = marks[0][1]
    for pos, ts in marks:
        if pos <= offset:
            best = ts
    return best


def split(buf, control_word, video):
    """Split into (offset, message); EPRD updates use big-endian lengths."""
    out, pos = [], 0
    while pos + 20 <= len(buf) and buf[pos:pos + 8] == control_word:
        length = struct.unpack_from(">I" if video and out else "<I", buf, pos + 16)[0]
        if pos + 20 + length > len(buf):
            break
        out.append((pos, buf[pos:pos + 20 + length]))
        pos += 20 + length
    return out


def describe_update(payload, frames):
    count = struct.unpack(">H", payload[2:4])[0]
    pos, rects = 4, []
    for _ in range(count):
        x, y, w, h, enc = struct.unpack(">HHHHi", payload[pos:pos + 12])
        pos += 12
        if enc != 7:
            rects.append(f"{x},{y} {w}x{h} enc={enc}")
            break
        control = payload[pos]
        pos += 1
        length, shift = 0, 0
        while True:
            b = payload[pos]
            pos += 1
            length |= (b & 0x7F) << shift
            shift += 7
            if not b & 0x80:
                break
        jpeg = payload[pos:pos + length]
        pos += length
        tag = f" #{hashlib.md5(jpeg).hexdigest()[:6]}" if frames else ""
        rects.append(f"{x},{y} {w}x{h} ctl={control:#x} {length}B{tag}")
    return f"FramebufferUpdate {count} rects: " + "; ".join(rects)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("capture")
    parser.add_argument("--no-udp", action="store_true", help="hide UDP discovery")
    parser.add_argument("--no-probes", action="store_true", help="hide TCP probe connections")
    parser.add_argument("--hide", action="append", default=[], help="status to hide, e.g. 0x0a")
    parser.add_argument("--frames", action="store_true", help="hash each JPEG tile")
    args = parser.parse_args()
    hidden = {int(h, 0) for h in args.hide}

    udp, streams, events = read_capture(args.capture)
    # A probe connection is any app->3620 connection that never sends a
    # connect request (family 1, status 1).
    session_ports = {sport for (src, sport, dst, dport), (buf, _) in streams.items()
                     if dport == CONTROL_PORT and any(
                         m[12] == 1 and m[13] == 1 for _, m in split(buf, b"EEMP0100", False))}
    probe_ports = {key[1] for _, key, _ in events
                   if key[3] == CONTROL_PORT and key[1] not in session_ports}

    lines = []
    last_udp = None
    for ts, src, sport, dst, dport, payload in udp:
        if args.no_udp:
            break
        for _, msg in split(payload, b"EEMP0100", False):
            key = (msg[12], len(msg) - 20)
            if key == last_udp:
                continue
            last_udp = key
            lines.append((ts, f"UDP {src}:{sport} > {dst}:{dport}",
                          f"fam={msg[13]} st={msg[12]:#04x} len={len(msg) - 20} (repeats collapsed)"))

    for (src, sport, dst, dport), (buf, marks) in streams.items():
        app_port = sport if dport in (CONTROL_PORT, VIDEO_PORT) else dport
        if args.no_probes and app_port in probe_ports:
            continue
        where = f"TCP {src}:{sport} > {dport}"
        if VIDEO_PORT in (sport, dport):
            for i, (pos, msg) in enumerate(split(buf, b"EPRD0600", True)):
                text = ("EPRD hello " + msg[20:].hex()) if i == 0 else describe_update(msg[20:], args.frames)
                lines.append((time_at(marks, pos), where, text))
        else:
            for pos, msg in split(buf, b"EEMP0100", False):
                if msg[12] in hidden:
                    continue
                body = msg[20:]
                extra = ""
                if len(body) == 48 and not body[1]:
                    words = struct.unpack("<12I", body)
                    extra = " " + " ".join(f"@{i * 4}={w}" for i, w in enumerate(words) if w)
                lines.append((time_at(marks, pos), where,
                              f"fam={msg[13]} st={msg[12]:#04x} len={len(body)}{extra}"))

    for ts, (src, sport, dst, dport), kind in events:
        app_port = sport if dport in (CONTROL_PORT, VIDEO_PORT) else dport
        if args.no_probes and app_port in probe_ports:
            continue
        lines.append((ts, f"TCP {src}:{sport} > {dport}", kind))

    for ts, where, text in sorted(lines, key=lambda line: line[0]):
        print(f"{ts:9.3f}  {where:<36} {text}")


if __name__ == "__main__":
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    main()
