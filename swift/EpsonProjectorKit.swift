// EpsonProjectorKit.swift
//
// Reference implementation of the client side of Epson's wireless
// "iProjection" protocol — see swift/README.md and swift/01-wire-format.md,
// swift/02-control-channel.md, swift/03-video-channel.md in this repo for
// the full narrative spec this file implements.
//
// This file is transport-agnostic on purpose: every function here builds or
// parses plain `[UInt8]` byte arrays. Wire them up to `NWConnection` (or
// whatever socket API your app uses) — see 02-control-channel.md for the
// send/receive loop this is meant to sit inside.
//
// Verified: compiled standalone and run against this repo's own projector
// simulator (`lib/simulator`) over real TCP sockets — the full probe/connect/
// state-exchange/video-stream sequence below round-tripped correctly. Not
// yet exercised against physical projector hardware.

import Foundation
#if canImport(Glibc)
import Glibc
#else
import Darwin
#endif

// MARK: - hex helper

extension Data {
    init?(hexString: String) {
        let chars = Array(hexString)
        guard chars.count % 2 == 0 else { return nil }
        var bytes = [UInt8]()
        bytes.reserveCapacity(chars.count / 2)
        var i = 0
        while i < chars.count {
            guard let hi = chars[i].hexDigitValue, let lo = chars[i + 1].hexDigitValue else { return nil }
            bytes.append(UInt8(hi * 16 + lo))
            i += 2
        }
        self = Data(bytes)
    }
}

// MARK: - wire framing (20-byte header shared by EEMP0100 and EPRD0600)

enum EpsonWire {
    static let headerLength = 20

    enum LengthEndianness { case little, big }

    struct DecodedHeader {
        let controlWord: String
        let ipAddress: [UInt8]
        let status: UInt8
        let family: UInt8
        let payloadLength: Int
    }

    /// Builds one wire message: 20-byte header + payload.
    ///
    /// `lengthEndianness` is `.little` for every EEMP0100 message and the
    /// EPRD0600 hello, `.big` for EPRD0600 FramebufferUpdate messages — see
    /// 03-video-channel.md for why this isn't a mistake.
    static func encodeMessage(
        controlWord: String,
        ipAddress: [UInt8],
        status: UInt8,
        family: UInt8 = 0,
        payload: [UInt8],
        lengthEndianness: LengthEndianness = .little
    ) -> [UInt8] {
        precondition(controlWord.utf8.count == 8, "control word must be 8 bytes")
        precondition(ipAddress.count == 4, "IP address must be 4 bytes")

        var header = [UInt8](repeating: 0, count: headerLength)
        header.replaceSubrange(0..<8, with: Array(controlWord.utf8))
        header.replaceSubrange(8..<12, with: ipAddress)
        header[12] = status
        header[13] = family
        // bytes 14..<16 stay zero (padding)

        let length = UInt32(payload.count)
        switch lengthEndianness {
        case .little:
            header[16] = UInt8(length & 0xff)
            header[17] = UInt8((length >> 8) & 0xff)
            header[18] = UInt8((length >> 16) & 0xff)
            header[19] = UInt8((length >> 24) & 0xff)
        case .big:
            header[16] = UInt8((length >> 24) & 0xff)
            header[17] = UInt8((length >> 16) & 0xff)
            header[18] = UInt8((length >> 8) & 0xff)
            header[19] = UInt8(length & 0xff)
        }

        return header + payload
    }

    /// Decodes just the 20-byte header. Caller slices
    /// `bytes[20..<20+payloadLength]` for the payload.
    static func decodeHeader(_ bytes: [UInt8], lengthEndianness: LengthEndianness = .little) -> DecodedHeader? {
        guard bytes.count >= headerLength else { return nil }
        let controlWord = String(decoding: bytes[0..<8], as: UTF8.self)
        let ip = Array(bytes[8..<12])
        let status = bytes[12]
        let family = bytes[13]
        let length: UInt32
        switch lengthEndianness {
        case .little:
            length = UInt32(bytes[16]) | (UInt32(bytes[17]) << 8) | (UInt32(bytes[18]) << 16) | (UInt32(bytes[19]) << 24)
        case .big:
            length = (UInt32(bytes[16]) << 24) | (UInt32(bytes[17]) << 16) | (UInt32(bytes[18]) << 8) | UInt32(bytes[19])
        }
        return DecodedHeader(controlWord: controlWord, ipAddress: ip, status: status, family: family, payloadLength: Int(length))
    }

    /// Slices complete `20 + payloadLength`-byte messages out of a growing
    /// TCP receive buffer. EEMP0100-channel only (always little-endian
    /// length) — the EPRD0600 video channel needs `EprdFrameParser` instead,
    /// since its length endianness changes after the first message.
    ///
    /// TCP has no message boundaries: a `receive` callback can deliver half
    /// a message, several messages back to back, or anything in between.
    /// Feed everything you've received so far into `buffer`, keep `rest` for
    /// next time, and process `messages` in order.
    static func extractMessages(_ buffer: [UInt8]) -> (messages: [[UInt8]], rest: [UInt8]) {
        var messages: [[UInt8]] = []
        var rest = buffer[...]
        while rest.count >= headerLength {
            let lengthBytes = rest[rest.startIndex + 16 ..< rest.startIndex + 20]
            let length = lengthBytes.enumerated().reduce(UInt32(0)) { acc, item in
                acc | (UInt32(item.element) << (8 * item.offset))
            }
            let messageLength = headerLength + Int(length)
            guard rest.count >= messageLength else { break }
            messages.append(Array(rest.prefix(messageLength)))
            rest = rest.dropFirst(messageLength)
        }
        return (messages, Array(rest))
    }

    /// Replaces every occurrence of a fixed-length byte sequence. Used to
    /// patch the captured client IP into the session templates below.
    static func replacingAllOccurrences(of find: [UInt8], with replacement: [UInt8], in bytes: [UInt8]) -> [UInt8] {
        precondition(find.count == replacement.count)
        guard !find.isEmpty else { return bytes }
        var result = bytes
        var i = 0
        while i + find.count <= result.count {
            if Array(result[i..<i + find.count]) == find {
                result.replaceSubrange(i..<i + find.count, with: replacement)
                i += find.count
            } else {
                i += 1
            }
        }
        return result
    }
}

// MARK: - EPRD0600 stateful stream parser (video channel, receive side)

/// The client only ever *sends* on the video channel — the real projector
/// never replies — but if you want to sanity-check your own output (e.g. in
/// a test against the simulator) or ever need to parse this channel, this
/// mirrors the length-endianness switch: little-endian for the first
/// message (the hello), big-endian for every FramebufferUpdate after it.
final class EprdFrameParser {
    private var pending: [UInt8] = []
    private var sawHello = false

    var onInit: ((_ width: Int, _ height: Int) -> Void)?
    var onRect: ((VideoRect) -> Void)?
    var onError: ((String) -> Void)?

    func feed(_ chunk: [UInt8]) {
        pending.append(contentsOf: chunk)
        while pending.count >= EpsonWire.headerLength {
            let controlWord = String(decoding: pending[0..<8], as: UTF8.self)
            guard controlWord == EpsonTemplates.eprdControlWord else {
                onError?("bad control word: \(controlWord)")
                pending = []
                return
            }
            guard let header = EpsonWire.decodeHeader(pending, lengthEndianness: sawHello ? .big : .little) else { return }
            let total = EpsonWire.headerLength + header.payloadLength
            guard pending.count >= total else { return }
            let payload = Array(pending[EpsonWire.headerLength..<total])
            pending.removeFirst(total)
            if !sawHello {
                sawHello = true
                handleInit(payload)
            } else {
                handleUpdate(payload)
            }
        }
    }

    private func handleInit(_ payload: [UInt8]) {
        guard payload.count >= 8 else { onError?("short init payload"); return }
        let width = (Int(payload[4]) << 8) | Int(payload[5])
        let height = (Int(payload[6]) << 8) | Int(payload[7])
        onInit?(width, height)
    }

    private func handleUpdate(_ payload: [UInt8]) {
        guard payload.count >= 4, payload[0] == 0 else { onError?("unexpected update message type"); return }
        let rectCount = (Int(payload[2]) << 8) | Int(payload[3])
        var pos = 4
        for _ in 0..<rectCount {
            guard pos + 13 <= payload.count else { onError?("truncated rect header"); return }
            let x = (UInt16(payload[pos]) << 8) | UInt16(payload[pos + 1])
            let y = (UInt16(payload[pos + 2]) << 8) | UInt16(payload[pos + 3])
            let w = (UInt16(payload[pos + 4]) << 8) | UInt16(payload[pos + 5])
            let h = (UInt16(payload[pos + 6]) << 8) | UInt16(payload[pos + 7])
            let encoding = (Int32(payload[pos + 8]) << 24) | (Int32(payload[pos + 9]) << 16) | (Int32(payload[pos + 10]) << 8) | Int32(payload[pos + 11])
            let control = payload[pos + 12]
            pos += 13
            guard encoding == EpsonVideo.tightEncoding, control & 0xf0 == 0x90 else {
                onError?("unsupported rect: encoding=\(encoding) control=0x\(String(control, radix: 16))")
                return
            }
            var jpegLength = 0, shift = 0, more = true
            while more {
                guard pos < payload.count else { onError?("truncated compact length"); return }
                let b = payload[pos]; pos += 1
                jpegLength |= Int(b & 0x7f) << shift
                shift += 7
                more = (b & 0x80) != 0
            }
            guard pos + jpegLength <= payload.count else { onError?("truncated jpeg data"); return }
            onRect?(VideoRect(x: x, y: y, w: w, h: h, jpeg: Array(payload[pos..<pos + jpegLength])))
            pos += jpegLength
        }
    }
}

// MARK: - captured payload templates (see lib/shared/constants.ts for provenance)

enum EpsonTemplates {
    static let eempControlWord = "EEMP0100"
    static let eprdControlWord = "EPRD0600"

    /// 48 zero bytes: payload of the search (status 1) and probe (status 2) messages.
    static let zeroPayload48 = [UInt8](repeating: 0, count: 48)

    /// The client IP baked into the captured templates below (192.168.84.53).
    /// `EpsonClientMessages.patch` replaces every occurrence with your
    /// device's real IP before sending.
    static let captureClientIP: [UInt8] = [0xc0, 0xa8, 0x54, 0x35]

    /// Status 0x01/family 0x01 connect request. Contains the client's
    /// netmask, resolution, name ("VirtualBox", UTF-16LE) and the identity
    /// of the target projector (MAC + IP + name). 289 bytes.
    static let connectRequestHex =
        "01010000000000000000000000ffffff0000000000020f030005200320200001ff00ff00ff00000810000000010c000000005e00530100000000000000000000000000000000c0a854e2d300000005000000480000000200000004000000c0a854350c000000040000000000000001000000140000005600690072007400750061006c0042006f0078000b00000004000000000000001c00000000000000040000003600000001000000030000002a00000000005e005301c0a854e245423030353330310000000000000000000000000000000000000000000000000f00000004000000320000000d0000000400000001000000260000000800000000000000000000002e0000000100000000300000000c000000060000003430350000000000"

    /// Status 0x08/family 0x01 client state, sent after the connect accept.
    /// Three copies of the client descriptor block with per-copy flags. 376 bytes.
    static let clientState08Hex =
        "0001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004401000005000000480000000200000004000000c0a854350c000000040000000100000001000000140000005600690072007400750061006c0042006f0078000b00000004000000000000001c0000000000000007000000540000000100000005000000480000000200000004000000c0a854350c000000040000000100000001000000140000005600690072007400750061006c0042006f0078000b00000004000000000100001c0000000000000008000000900000000400000005000000480000000200000004000000c0a854350c000000040000000100000001000000140000005600690072007400750061006c0042006f0078000b00000004000000010100001c00000000000000000000000c000000020000000400000002000000000000000c000000020000000400000003000000000000000c000000020000000400000004000000"

    /// Status 0x27/family 0x01 stream ack, sent after the projector's 0x16
    /// "start streaming" signal. 48 bytes. Contains no client IP.
    static let streamAckHex =
        "000000000300000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

    /// The 46-byte EPRD0600 hello payload: RFB ServerInit-like, "cc000000" +
    /// width/height u16 BE (1280x800) + pixel format (16bpp RGB565) + trailer.
    /// Contains no client IP — send verbatim.
    static let eprdInitHex =
        "cc00000005000320101000011f003f001f000b050000000005000320000000000500032000000000000000000000"

    static let connectRequest = Array(Data(hexString: connectRequestHex)!)
    static let clientState08 = Array(Data(hexString: clientState08Hex)!)
    static let streamAck = Array(Data(hexString: streamAckHex)!)
    static let eprdInit = Array(Data(hexString: eprdInitHex)!)
}

/// EEMP0100 status codes used with `family = 0` (discovery/network-level).
/// The same numeric status means something different under family 1 — see
/// 02-control-channel.md's message catalog.
enum EempFamily0Status {
    static let search: UInt8 = 1
    static let probe: UInt8 = 2
    static let identity: UInt8 = 3
    static let capabilities: UInt8 = 21
    static let keepalive: UInt8 = 0x0a
    static let startStream: UInt8 = 0x16
}

/// EEMP0100 status codes used with `family = 1` (session-level).
enum EempFamily1Status {
    static let connectRequest: UInt8 = 1
    static let connectAccept: UInt8 = 2
    static let statePush: UInt8 = 0x0e
    static let clientState: UInt8 = 8
    static let stateAck: UInt8 = 9
    static let unlabeled: UInt8 = 0x10
    static let streamAck: UInt8 = 0x27
}

// MARK: - message builders (control channel, TCP port 3620)

enum EpsonClientMessages {
    /// Patches every occurrence of the captured client IP in a template
    /// payload with your device's real IP. Safe to call on templates that
    /// don't contain it (e.g. the stream ack) — it's just a no-op then.
    static func patch(_ payload: [UInt8], clientIP: [UInt8]) -> [UInt8] {
        EpsonWire.replacingAllOccurrences(of: EpsonTemplates.captureClientIP, with: clientIP, in: payload)
    }

    /// UDP broadcast search (status 1, family 0). Optional — see
    /// 02-control-channel.md for why you may want to skip discovery
    /// entirely on iOS and let the user enter a host instead.
    static func search(clientIP: [UInt8]) -> [UInt8] {
        EpsonWire.encodeMessage(
            controlWord: EpsonTemplates.eempControlWord, ipAddress: clientIP,
            status: EempFamily0Status.search, family: 0, payload: EpsonTemplates.zeroPayload48
        )
    }

    /// Pre-connect probe (status 2, family 0). Send over a fresh TCP
    /// connection to port 3620; expect status 3 then status 21 back, then
    /// close the connection.
    static func probe(clientIP: [UInt8]) -> [UInt8] {
        EpsonWire.encodeMessage(
            controlWord: EpsonTemplates.eempControlWord, ipAddress: clientIP,
            status: EempFamily0Status.probe, family: 0, payload: EpsonTemplates.zeroPayload48
        )
    }

    /// Connect request (status 1, family 1). Send first, over a *new* TCP
    /// connection to port 3620 (the probe connection must already be closed).
    static func connectRequest(clientIP: [UInt8]) -> [UInt8] {
        EpsonWire.encodeMessage(
            controlWord: EpsonTemplates.eempControlWord, ipAddress: clientIP,
            status: EempFamily1Status.connectRequest, family: 1,
            payload: patch(EpsonTemplates.connectRequest, clientIP: clientIP)
        )
    }

    /// Client state (status 8, family 1). Send once you've seen the status
    /// 2/family 1 connect accept.
    static func clientState(clientIP: [UInt8]) -> [UInt8] {
        EpsonWire.encodeMessage(
            controlWord: EpsonTemplates.eempControlWord, ipAddress: clientIP,
            status: EempFamily1Status.clientState, family: 1,
            payload: patch(EpsonTemplates.clientState08, clientIP: clientIP)
        )
    }

    /// Stream ack (status 0x27, family 1). Send once you've seen the status
    /// 0x16/family 0 "start streaming" signal, then open the video
    /// connection (port 3621).
    static func streamAck(clientIP: [UInt8]) -> [UInt8] {
        EpsonWire.encodeMessage(
            controlWord: EpsonTemplates.eempControlWord, ipAddress: clientIP,
            status: EempFamily1Status.streamAck, family: 1,
            payload: patch(EpsonTemplates.streamAck, clientIP: clientIP)
        )
    }

    /// Keepalive (status 0x0a, family 0, empty payload). Send every ~3s for
    /// the lifetime of the session, starting once you've sent the client
    /// state message.
    static func keepalive(clientIP: [UInt8]) -> [UInt8] {
        EpsonWire.encodeMessage(
            controlWord: EpsonTemplates.eempControlWord, ipAddress: clientIP,
            status: EempFamily0Status.keepalive, family: 0, payload: []
        )
    }
}

// MARK: - video channel (EPRD0600, TCP port 3621)

struct VideoRect {
    let x: UInt16
    let y: UInt16
    let w: UInt16
    let h: UInt16
    /// Raw baseline-JPEG file bytes — sent as-is, not re-encoded.
    let jpeg: [UInt8]
}

enum EpsonVideo {
    static let tightEncoding: Int32 = 7
    static let tightJpegControl: UInt8 = 0x90

    /// The EPRD0600 hello. Send once, immediately after opening the video
    /// connection, before any FramebufferUpdate.
    static func hello(clientIP: [UInt8]) -> [UInt8] {
        EpsonWire.encodeMessage(
            controlWord: EpsonTemplates.eprdControlWord, ipAddress: clientIP,
            status: 0, family: 0, payload: EpsonTemplates.eprdInit, lengthEndianness: .little
        )
    }

    /// RFB Tight "compact length": base-128 varint, 7 payload bits per byte,
    /// continuation flagged by the top bit. Always emitted as 3 bytes here,
    /// matching what's seen in the captures (a valid, if not maximally
    /// compact, encoding).
    private static func compactLength(_ length: Int) -> [UInt8] {
        [
            UInt8((length & 0x7f) | 0x80),
            UInt8(((length >> 7) & 0x7f) | 0x80),
            UInt8((length >> 14) & 0x7f),
        ]
    }

    /// One FramebufferUpdate: a batch of rects, each a raw JPEG blob under
    /// Tight encoding. Send repeatedly (e.g. every 500ms) after the hello.
    /// **Note the big-endian length** — see `encodeMessage`'s
    /// `lengthEndianness` and 03-video-channel.md.
    static func update(clientIP: [UInt8], rects: [VideoRect]) -> [UInt8] {
        var payload: [UInt8] = [0, 0] // message type = 0, pad
        payload.append(UInt8((rects.count >> 8) & 0xff))
        payload.append(UInt8(rects.count & 0xff))

        for rect in rects {
            payload.append(UInt8((rect.x >> 8) & 0xff)); payload.append(UInt8(rect.x & 0xff))
            payload.append(UInt8((rect.y >> 8) & 0xff)); payload.append(UInt8(rect.y & 0xff))
            payload.append(UInt8((rect.w >> 8) & 0xff)); payload.append(UInt8(rect.w & 0xff))
            payload.append(UInt8((rect.h >> 8) & 0xff)); payload.append(UInt8(rect.h & 0xff))
            let enc = UInt32(bitPattern: tightEncoding)
            payload.append(UInt8((enc >> 24) & 0xff))
            payload.append(UInt8((enc >> 16) & 0xff))
            payload.append(UInt8((enc >> 8) & 0xff))
            payload.append(UInt8(enc & 0xff))
            payload.append(tightJpegControl)
            payload.append(contentsOf: compactLength(rect.jpeg.count))
            payload.append(contentsOf: rect.jpeg)
        }

        return EpsonWire.encodeMessage(
            controlWord: EpsonTemplates.eprdControlWord, ipAddress: clientIP,
            status: 0, family: 0, payload: payload, lengthEndianness: .big
        )
    }
}

/// Minimal JPEG SOF scan for image dimensions — useful for sizing a
/// single full-frame rect from an arbitrary JPEG (e.g. a screenshot or
/// `UIImage.jpegData`).
func jpegDimensions(_ jpeg: [UInt8]) -> (width: Int, height: Int)? {
    func u16be(_ i: Int) -> Int { (Int(jpeg[i]) << 8) | Int(jpeg[i + 1]) }
    var i = 2
    while i + 9 < jpeg.count {
        if jpeg[i] != 0xff { i += 1; continue }
        let marker = jpeg[i + 1]
        if marker >= 0xc0 && marker <= 0xcf && marker != 0xc4 && marker != 0xc8 && marker != 0xcc {
            return (width: u16be(i + 7), height: u16be(i + 5))
        }
        if marker == 0xd8 || marker == 0x01 || (marker >= 0xd0 && marker <= 0xd7) {
            i += 2
            continue
        }
        i += 2 + u16be(i + 2)
    }
    return nil
}

// MARK: - device IP helpers

enum EpsonNetworking {
    /// The device's own Wi-Fi IPv4 address. Needed both for the wire
    /// header's `ipAddress` field on every message you send, and to patch
    /// into the session templates via `EpsonClientMessages.patch`.
    ///
    /// `en0` is Wi-Fi on every iOS device to date; this returns nil if
    /// Wi-Fi is off or unavailable (e.g. cellular-only), which is a
    /// reasonable point to tell the user to join the projector's network.
    static func currentWiFiIPv4Address() -> String? {
        var address: String?
        var ifaddrPtr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddrPtr) == 0, let firstAddr = ifaddrPtr else { return nil }
        defer { freeifaddrs(ifaddrPtr) }

        var ptr: UnsafeMutablePointer<ifaddrs>? = firstAddr
        while let current = ptr {
            defer { ptr = current.pointee.ifa_next }
            let interface = current.pointee
            guard interface.ifa_addr.pointee.sa_family == UInt8(AF_INET) else { continue }
            guard String(cString: interface.ifa_name) == "en0" else { continue }

            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                interface.ifa_addr, socklen_t(interface.ifa_addr.pointee.sa_len),
                &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST
            )
            if result == 0 {
                address = String(cString: hostname)
            }
        }
        return address
    }

    static func ipv4StringToBytes(_ ip: String) -> [UInt8]? {
        let parts = ip.split(separator: ".").compactMap { UInt8($0) }
        guard parts.count == 4 else { return nil }
        return parts
    }

    /// `192.168.1.50` -> `192.168.1.255`. A reasonable default broadcast
    /// address for discovery on a typical /24 home or venue network. If
    /// your target network uses a different subnet size, compute the real
    /// broadcast address from the interface's netmask instead.
    static func broadcastAddress(forIPv4 ip: String) -> String? {
        var parts = ip.split(separator: ".")
        guard parts.count == 4 else { return nil }
        parts[3] = "255"
        return parts.joined(separator: ".")
    }
}
