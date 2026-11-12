#!/usr/bin/env python3
"""Dump every EEMP0100 control message from a .pcapng capture.

    python3 tools/eemp_dump.py captures/Capture4ClientDisconnects.pcapng
    python3 tools/eemp_dump.py captures/*.pcapng --summary
    python3 tools/eemp_dump.py captures/Capture1.pcapng --hide 0x0a --full

UDP datagrams are decoded one message per packet. TCP port-3620 streams are
reassembled per connection (deduplicated by sequence number) and split into
messages using the 20-byte header's little-endian payload length. Video
traffic on 3621 (EPRD0600) is ignored. TCP FIN/RST packets on 3620 are
listed too, since they're how sessions actually end on the wire.

Standard library only; assumes Ethernet link-layer and IPv4.
"""
import argparse
import collections
import signal
import struct

CONTROL_PORT = 3620
HEADER_LENGTH = 20


def pcapng_packets(path):
    """Yield (packet_index, raw_frame) for every Enhanced Packet Block."""
    data = open(path, "rb").read()
    offset, endian, index = 0, "<", 0
    while offset + 8 <= len(data):
        block_type, block_len = struct.unpack_from(endian + "II", data, offset)
        if block_type == 0x0A0D0D0A:  # Section Header: re-read byte order
            endian = "<" if data[offset + 8:offset + 12] == b"\x4d\x3c\x2b\x1a" else ">"
            block_type, block_len = struct.unpack_from(endian + "II", data, offset)
        if block_type == 6:  # Enhanced Packet Block
            captured = struct.unpack_from(endian + "I", data, offset + 20)[0]
            yield index, data[offset + 28:offset + 28 + captured]
            index += 1
        if block_len == 0:
            break
        offset += block_len


def ipv4_segments(path):
    """Yield (index, proto, src, sport, dst, dport, tcp_flags, tcp_seq, payload)."""
    for index, frame in pcapng_packets(path):
        if frame[12:14] != b"\x08\x00":
            continue
        ip = frame[14:]
        ihl = (ip[0] & 0x0F) * 4
        total_len = struct.unpack(">H", ip[2:4])[0]
        ip = ip[:total_len]  # drop Ethernet padding on short frames
        proto = ip[9]
        src = ".".join(map(str, ip[12:16]))
        dst = ".".join(map(str, ip[16:20]))
        l4 = ip[ihl:]
        if proto == 6:
            sport, dport, seq = struct.unpack(">HHI", l4[:8])
            yield index, "TCP", src, sport, dst, dport, l4[13], seq, l4[(l4[12] >> 4) * 4:]
        elif proto == 17:
            sport, dport = struct.unpack(">HH", l4[:4])
            yield index, "UDP", src, sport, dst, dport, 0, 0, l4[8:]


def split_messages(buf):
    """Split a byte buffer into EEMP messages; returns (messages, leftover)."""
    messages, offset = [], 0
    while offset + HEADER_LENGTH <= len(buf) and buf[offset:offset + 8] == b"EEMP0100":
        length = struct.unpack_from("<I", buf, offset + 16)[0]
        if offset + HEADER_LENGTH + length > len(buf):
            break
        messages.append(buf[offset:offset + HEADER_LENGTH + length])
        offset += HEADER_LENGTH + length
    return messages, buf[offset:]


def collect(path):
    """Return a list of events in capture order."""
    events = []
    tcp_streams = collections.OrderedDict()
    seen = set()
    for index, proto, src, sport, dst, dport, flags, seq, payload in ipv4_segments(path):
        if CONTROL_PORT not in (sport, dport):
            continue
        where = f"{proto} {src}:{sport} -> {dst}:{dport}"
        if proto == "UDP":
            for msg in split_messages(payload)[0]:
                events.append((index, where, msg))
            continue
        if flags & 0x05:
            events.append((index, where, "FIN" if flags & 0x01 else "RST"))
        key = (src, sport, dst, dport)
        if payload and (key, seq) not in seen:
            seen.add((key, seq))
            tcp_streams.setdefault(key, []).append((index, seq, payload))
    for (src, sport, dst, dport), segments in tcp_streams.items():
        segments.sort(key=lambda s: s[1])
        # Remember which packet each byte range arrived in, so every message
        # is stamped with the packet its first byte came from.
        starts, buf = [], b""
        for index, _, payload in segments:
            starts.append((len(buf), index))
            buf += payload
        def packet_at(offset):
            return max((s for s in starts if s[0] <= offset), key=lambda s: s[0])[1]
        messages, leftover = split_messages(buf)
        where = f"TCP {src}:{sport} -> {dst}:{dport}"
        offset = 0
        for msg in messages:
            events.append((packet_at(offset), where, msg))
            offset += len(msg)
        if leftover:
            events.append((packet_at(offset), where, f"<{len(leftover)} unparsed bytes>"))
    events.sort(key=lambda e: e[0])
    return events


def describe(msg, full):
    status, family = msg[12], msg[13]
    length = struct.unpack_from("<I", msg, 16)[0]
    hdr_ip = ".".join(map(str, msg[8:12]))
    body = msg[HEADER_LENGTH:]
    shown = body.hex() if full else body[:24].hex() + ("…" if len(body) > 24 else "")
    return f"fam={family} st=0x{status:02x} len={length:<4} hdr_ip={hdr_ip:<15} {shown}"


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("captures", nargs="+")
    parser.add_argument("--summary", action="store_true",
                        help="only count (family, status, length) per capture")
    parser.add_argument("--hide", action="append", default=[],
                        help="status to hide, e.g. 0x0a (repeatable)")
    parser.add_argument("--full", action="store_true", help="print whole payloads")
    args = parser.parse_args()
    hidden = {int(h, 0) for h in args.hide}

    for path in args.captures:
        print(f"== {path}")
        events = collect(path)
        if args.summary:
            counts = collections.Counter(
                (m[13], m[12], struct.unpack_from("<I", m, 16)[0])
                for _, _, m in events if isinstance(m, bytes))
            for (family, status, length), n in sorted(counts.items()):
                print(f"  {n:6}  fam={family} st=0x{status:02x} len={length}")
            continue
        for index, where, msg in events:
            if isinstance(msg, bytes):
                if msg[12] in hidden:
                    continue
                print(f"{index:7}  {where:<45} {describe(msg, args.full)}")
            else:
                print(f"{index:7}  {where:<45} {msg}")


if __name__ == "__main__":
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)  # quiet exit when piped to head
    main()
