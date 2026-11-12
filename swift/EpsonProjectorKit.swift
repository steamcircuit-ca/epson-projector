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
// Payloads are built field by field (a Swift port of
// `lib/shared/messages.ts` and `eprdHelloPayload` in `lib/shared/eprd.ts`),
// not copied from captures. Every builder was checked byte-for-byte against
// the TypeScript builders' output, which in turn match the real captures
// given the same field values. Bytes whose meaning is still unknown are
// reproduced as named constants rather than guessed at. Not yet exercised
// against physical projector hardware.

import Foundation
#if canImport(Glibc)
import Glibc
#else
import Darwin
#endif

// MARK: - wire framing (20-byte header shared by EEMP0100 and EPRD0600)

enum EpsonWire {
    static let headerLength = 20
    static let eempControlWord = "EEMP0100"
    static let eprdControlWord = "EPRD0600"

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

    /// One complete EEMP0100 (control channel) message: header + payload.
    /// `ipAddress` is the *sender's* IP — yours on everything you send.
    static func eempMessage(ipAddress: [UInt8], status: UInt8, family: UInt8, payload: [UInt8] = []) -> [UInt8] {
        encodeMessage(controlWord: eempControlWord, ipAddress: ipAddress, status: status, family: family, payload: payload)
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
            guard controlWord == EpsonWire.eprdControlWord else {
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

// MARK: - status codes

/// EEMP0100 status codes used with `family = 0` (discovery, probes,
/// heartbeats, start signal). The same numeric status means something
/// different under family 1 — see 02-control-channel.md's message catalog.
enum EempFamily0Status {
    static let search: UInt8 = 0x01
    static let probe: UInt8 = 0x02
    static let identity: UInt8 = 0x03
    static let heartbeat: UInt8 = 0x0a
    static let capabilities: UInt8 = 0x15
    static let startStream: UInt8 = 0x16
}

/// EEMP0100 status codes used with `family = 1` (session state).
enum EempFamily1Status {
    static let connectRequest: UInt8 = 0x01
    static let connectAccept: UInt8 = 0x02
    /// App → projector, empty. Clean disconnect; expect `disconnectAck`.
    static let disconnect: UInt8 = 0x04
    static let disconnectAck: UInt8 = 0x05
    /// Projector → app. The projector ended the session; it closes every
    /// socket right after. No reply expected.
    static let disconnectedByProjector: UInt8 = 0x07
    static let layoutRequest: UInt8 = 0x08
    static let layoutAccepted: UInt8 = 0x09
    static let stateBroadcast: UInt8 = 0x0e
    /// App → projector, empty. *Inferred* "resume" request (one sample).
    static let resume: UInt8 = 0x0f
    /// Projector → app, empty. Open the video connection(s) now.
    static let openVideo: UInt8 = 0x10
    static let staleSession: UInt8 = 0x17
    /// Projector → app, sent just before an in-use identity reply.
    static let inUse: UInt8 = 0x1a
    static let streamStarted: UInt8 = 0x27
}

// MARK: - identities

/// A client device (your app).
struct ClientIdentity: Equatable {
    /// IPv4 address, 4 bytes.
    var ip: [UInt8]
    /// Display name, shown on the projector. Sent as UTF-16LE.
    var name: String
}

/// A projector. Get one from a discovery/probe identity reply with
/// `EempPayloads.parseIdentity(_:)?.projector(ip:)`.
struct ProjectorIdentity: Equatable {
    /// MAC address, 6 bytes.
    var mac: [UInt8]
    /// IPv4 address, 4 bytes.
    var ip: [UInt8]
    /// Network name, ASCII, max 32 bytes (real units use "EB" + MAC tail).
    var name: String
}

struct EpsonSize: Equatable {
    var width: Int
    var height: Int
}

// MARK: - byte primitives

private func le32(_ value: UInt32) -> [UInt8] {
    [UInt8(value & 0xff), UInt8((value >> 8) & 0xff), UInt8((value >> 16) & 0xff), UInt8(value >> 24)]
}

private func le16(_ value: Int) -> [UInt8] {
    let v = UInt16(truncatingIfNeeded: value)
    return [UInt8(v & 0xff), UInt8(v >> 8)]
}

private func be16(_ value: Int) -> [UInt8] {
    let v = UInt16(truncatingIfNeeded: value)
    return [UInt8(v >> 8), UInt8(v & 0xff)]
}

private func readLE32(_ b: [UInt8], _ at: Int) -> UInt32 {
    UInt32(b[at]) | (UInt32(b[at + 1]) << 8) | (UInt32(b[at + 2]) << 16) | (UInt32(b[at + 3]) << 24)
}

private func readLE16(_ b: [UInt8], _ at: Int) -> Int {
    Int(b[at]) | (Int(b[at + 1]) << 8)
}

private func put(_ bytes: [UInt8], into buffer: inout [UInt8], at offset: Int) {
    buffer.replaceSubrange(offset..<offset + bytes.count, with: bytes)
}

/// Zero-padded fixed-width ASCII field. Like Node's `"ascii"` write: one
/// byte per UTF-16 code unit (its low byte), truncated to `size`.
private func fixedASCII(_ text: String, _ size: Int) -> [UInt8] {
    var b = text.utf16.prefix(size).map { UInt8(truncatingIfNeeded: $0) }
    b += [UInt8](repeating: 0, count: size - b.count)
    return b
}

private func utf16LE(_ text: String) -> [UInt8] {
    text.utf16.flatMap { [UInt8($0 & 0xff), UInt8($0 >> 8)] }
}

// MARK: - TLV records

/// The TLV encoding every session payload body uses:
/// `tag u32 LE | length u32 LE | value`. Containers nest; lists are a
/// `u32 LE` count followed by the entries.
enum EempTLV {
    struct Record: Equatable {
        let tag: UInt32
        let value: [UInt8]
    }

    /// One TLV record.
    static func record(_ tag: UInt32, _ value: [UInt8] = []) -> [UInt8] {
        le32(tag) + le32(UInt32(value.count)) + value
    }

    /// A TLV list: count u32 LE followed by the entries.
    static func list(_ tag: UInt32, _ entries: [[UInt8]]) -> [UInt8] {
        record(tag, le32(UInt32(entries.count)) + entries.flatMap { $0 })
    }

    /// Parses a flat run of TLV records (does not recurse). Returns nil if
    /// a record overruns the buffer. Trailing bytes shorter than a record
    /// header are ignored.
    static func parse(_ bytes: [UInt8]) -> [Record]? {
        var out: [Record] = []
        var pos = 0
        while pos + 8 <= bytes.count {
            let tag = readLE32(bytes, pos)
            let length = Int(readLE32(bytes, pos + 4))
            guard length <= bytes.count - pos - 8 else { return nil }
            out.append(Record(tag: tag, value: Array(bytes[pos + 8 ..< pos + 8 + length])))
            pos += 8 + length
        }
        return out
    }
}

// MARK: - payload builders and parsers (EEMP0100 control channel)

/// User-entry flag values (tag 0x0b) seen in the captures.
enum EempUserFlags {
    /// The client's own entry before the projector accepts it.
    static let pending: UInt32 = 0x000
    /// Accepted / in the connected-users list.
    static let connected: UInt32 = 0x001
    /// On screen. The real app sends 0x101 or 0x100; both get echoed.
    static let onScreen: UInt32 = 0x101
}

/// One entry in a screen-slot list: a user on screen, or an empty slot
/// identified by its number (1-4).
enum SlotEntry: Equatable {
    case user(ClientIdentity, flags: UInt32 = EempUserFlags.onScreen)
    case empty(slot: UInt32)
}

/// Who the client wants (or the projector says) is on screen.
struct ScreenLayout: Equatable {
    /// List 0x07: who is full-screen (or `[.empty(slot: 1)]` when nobody is).
    var presenter: [SlotEntry]
    /// List 0x08: the four split-screen panels.
    var panels: [SlotEntry]
}

/// The projector's screen state, as carried by a `0x0e` state broadcast.
struct ScreenState: Equatable {
    var presenter: [SlotEntry]
    /// Omitted in the initial (176-byte) broadcast right after the accept.
    var panels: [SlotEntry]?
    /// List 0x06: connected users.
    var users: [ClientIdentity]
}

/// A parsed tag-0x05 user entry.
struct ParsedUser: Equatable {
    var ip: [UInt8]
    var name: String
    var registered: Bool
    var flags: UInt32
    var identity: ClientIdentity { ClientIdentity(ip: ip, name: name) }
}

struct ParsedIdentity: Equatable {
    var name: String
    var mac: [UInt8]
    var inUse: Bool
    var connectedUsers: Int
    var modelCode: UInt32

    /// The identity to put in a connect request. `ip` is the address the
    /// reply came from (it isn't in the idle identity payload).
    func projector(ip: [UInt8]) -> ProjectorIdentity {
        ProjectorIdentity(mac: mac, ip: ip, name: name)
    }
}

struct ParsedCapabilities: Equatable {
    var modelCode: UInt32?
    var nativeResolution: EpsonSize?
    var framebuffer: EpsonSize?
    var maxRect: EpsonSize?
}

struct ParsedConnectRequest: Equatable {
    var client: ParsedUser
    var screen: EpsonSize
    var targetMAC: [UInt8]
    var targetIP: [UInt8]
}

/// Field-by-field builders for every EEMP0100 payload (what follows the
/// 20-byte header), both directions — the projector-side ones are here for
/// tests and simulators. Wrap with `EpsonWire.eempMessage`. Layouts are in
/// `../docs/eemp-control-protocol.md` § Payload layout / TLV record reference.
///
/// Every non-empty payload starts with a 48-byte *short* prefix (byte 0 =
/// 0) or a 74-byte *long* prefix (byte 0 = 1). Byte 1 = 1 means a body
/// follows: a `u32 LE` length, then TLV records.
enum EempPayloads {
    /// Maximum simultaneous connections advertised (tag 0x0f). Always 50.
    static let maxConnections: UInt32 = 50
    /// Model/series code seen in the captured projector (0x0c on another model).
    static let defaultModelCode: UInt32 = 0x09
    /// Largest rect the captured projector accepts per Tight rect.
    static let defaultMaxRect = EpsonSize(width: 656, height: 416)
    /// The app's own screen size, declared in the connect request.
    static let defaultScreen = EpsonSize(width: 1280, height: 800)
    /// Audio sample rate the projector announces in its periodic heartbeats.
    static let heartbeatSampleRate: UInt32 = 44100

    // MARK: prefixes

    /// Short (48-byte) prefix. Byte 1 says whether a body follows.
    private static func shortPrefix(body: Bool = false, at4: UInt32 = 0, at8: UInt32 = 0) -> [UInt8] {
        var p = [UInt8](repeating: 0, count: 48)
        p[1] = body ? 1 : 0
        put(le32(at4), into: &p, at: 4)
        put(le32(at8), into: &p, at: 8)
        return p
    }

    /// Appends a body: u32 LE body length, then the TLV records.
    private static func withBody(_ prefix: [UInt8], _ records: [[UInt8]]) -> [UInt8] {
        let body = records.flatMap { $0 }
        return prefix + le32(UInt32(body.count)) + body
    }

    // MARK: TLV building blocks

    /// Tag 0x05: one user. Field order matters; it's always this order.
    static func userEntry(_ client: ClientIdentity, registered: Bool, flags: UInt32) -> [UInt8] {
        EempTLV.record(0x05,
            EempTLV.record(0x02, client.ip)
            + EempTLV.record(0x0c, le32(registered ? 1 : 0))
            + EempTLV.record(0x01, utf16LE(client.name))
            + EempTLV.record(0x0b, le32(flags))
            + EempTLV.record(0x1c)
        )
    }

    /// Tag 0x00: an empty screen slot, identified by its number (1-4).
    static func emptySlot(_ slot: UInt32) -> [UInt8] {
        EempTLV.record(0x00, EempTLV.record(0x02, le32(slot)))
    }

    /// Tag 0x04: list of one projector identity (tag 0x03).
    private static func projectorList(_ projector: ProjectorIdentity) -> [UInt8] {
        EempTLV.list(0x04, [EempTLV.record(0x03, projector.mac + projector.ip + fixedASCII(projector.name, 32))])
    }

    private static func slot(_ entry: SlotEntry) -> [UInt8] {
        switch entry {
        case .empty(let n): return emptySlot(n)
        case .user(let user, let flags): return userEntry(user, registered: true, flags: flags)
        }
    }

    /// Parses a tag-0x05 user entry's *value*.
    static func parseUserEntry(_ value: [UInt8]) -> ParsedUser? {
        guard let records = EempTLV.parse(value) else { return nil }
        var fields: [UInt32: [UInt8]] = [:]
        for r in records { fields[r.tag] = r.value }
        guard let ip = fields[0x02], ip.count == 4, let name = fields[0x01] else { return nil }
        func u32(_ tag: UInt32) -> UInt32 {
            guard let v = fields[tag], v.count >= 4 else { return 0 }
            return readLE32(v, 0)
        }
        let units = stride(from: 0, to: name.count - 1, by: 2).map { UInt16(name[$0]) | (UInt16(name[$0 + 1]) << 8) }
        return ParsedUser(ip: ip, name: String(decoding: units, as: UTF16.self), registered: u32(0x0c) == 1, flags: u32(0x0b))
    }

    // MARK: discovery: search, probe, identity, in-use, capabilities

    /// Search (fam 0 / 0x01) and probe (fam 0 / 0x02): 48 zero bytes.
    static func searchPayload() -> [UInt8] {
        [UInt8](repeating: 0, count: 48)
    }

    /// Identity reply (fam 0 / 0x03). Idle: the 74-byte long prefix alone.
    /// In use (`connectedUsers > 0`): the same prefix with the body flag
    /// set, plus a TLV body.
    static func identityPayload(_ projector: ProjectorIdentity, connectedUsers: Int = 0, modelCode: UInt32 = defaultModelCode) -> [UInt8] {
        let inUse = connectedUsers > 0
        var p = [UInt8](repeating: 0, count: 74)
        p[0] = 0x01 // long prefix
        p[1] = inUse ? 0x01 : 0x00 // body follows
        put(fixedASCII(projector.name, 32), into: &p, at: 4)
        p[36] = inUse ? 0x03 : 0x01 // status bits; bit 1 = in use
        p[38] = UInt8(truncatingIfNeeded: modelCode)
        p[40] = UInt8(min(connectedUsers, 0xff))
        p[41] = 0x01 // unknown, constant
        p[42] = 0x01 // unknown, constant
        put(projector.mac, into: &p, at: 48)
        guard inUse else { return p }
        return withBody(p, [
            projectorList(projector),
            EempTLV.record(0x0d, le32(1)), // unknown, constant
            EempTLV.record(0x0f, le32(maxConnections)),
            EempTLV.record(0x10, le32(UInt32(connectedUsers))),
        ])
    }

    static func parseIdentity(_ payload: [UInt8]) -> ParsedIdentity? {
        guard payload.count >= 74, payload[0] == 0x01 else { return nil }
        var nameBytes = Array(payload[4..<36])
        while nameBytes.last == 0 { nameBytes.removeLast() }
        return ParsedIdentity(
            name: String(nameBytes.map { Character(Unicode.Scalar($0)) }),
            mac: Array(payload[48..<54]),
            inUse: payload[36] & 0x02 != 0,
            connectedUsers: Int(payload[40]),
            modelCode: UInt32(payload[38])
        )
    }

    /// "In use" notice (fam 1 / 0x1a), sent before an in-use identity reply.
    static func inUsePayload() -> [UInt8] {
        [UInt8](repeating: 0, count: 48)
    }

    // Capabilities records whose meaning is unknown, reproduced verbatim.
    private static let capsProtocolTag: [UInt8] = Array("PB00".utf8) + [0, 0]
    private static let capsRecord07: [UInt8] = [0x01, 0x00, 0x01, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
    private static let capsRecord08: [UInt8] = [0x9f, 0x03, 0x00, 0x15, 0x00, 0x00, 0x00, 0x00]
    private static let capsRecord0A: [UInt8] = [0x00, 0x03, 0x01, 0x01, 0x32, 0x04, 0x01, 0x00, 0x00, 0x00]
    // The last 30 bytes don't follow the [type][len] framing; still undecoded.
    private static let capsTail: [UInt8] = [
        0x00, 0x0c, 0x0d, 0x00, 0x6b, 0x00, 0x00, 0x00, 0xff, 0x7f, 0xff, 0x7f, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x0d, 0x0a, 0x00, 0x01, 0x04, 0x40, 0x1f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]

    // One 22-byte encoding-table entry: [07 = Tight (or 00)][sub-id], then
    // u16 LE values 8, 0, a, a, 2a, 2a, maxW, maxH, 0, 0. `a` is 16 for the
    // first entry and 8 for the rest; its meaning is unknown.
    private static func encodingEntry(_ subID: UInt8, _ a: Int, _ maxRect: EpsonSize) -> [UInt8] {
        var e = [UInt8](repeating: 0, count: 22)
        e[0] = subID == 0 ? 0x00 : 0x07
        e[1] = subID
        put(le16(8), into: &e, at: 2)
        put(le16(a), into: &e, at: 6)
        put(le16(a), into: &e, at: 8)
        put(le16(a * 2), into: &e, at: 10)
        put(le16(a * 2), into: &e, at: 12)
        put(le16(maxRect.width), into: &e, at: 14)
        put(le16(maxRect.height), into: &e, at: 16)
        return e
    }

    /// Capabilities reply (fam 0 / 0x15). Its own `[type u8][len u8]`
    /// record format, not the prefix/TLV scheme. `framebuffer` defaults to
    /// `nativeResolution`.
    static func capabilitiesPayload(
        mac: [UInt8],
        modelCode: UInt32 = defaultModelCode,
        nativeResolution: EpsonSize = EpsonSize(width: 1280, height: 800),
        framebuffer: EpsonSize? = nil,
        maxRect: EpsonSize = defaultMaxRect
    ) -> [UInt8] {
        let fb = framebuffer ?? nativeResolution
        func record(_ type: UInt8, _ data: [UInt8]) -> [UInt8] { [type, UInt8(data.count)] + data }
        var records = record(0x01, le32(modelCode))
        records += record(0x02, capsProtocolTag)
        records += record(0x03, le16(nativeResolution.width) + le16(nativeResolution.height) + [0, 0])
        records += record(0x04, le16(2) + le16(fb.width) + le16(fb.height))
        records += record(0x05,
            encodingEntry(0x09, 16, maxRect) + encodingEntry(0x0b, 8, maxRect)
            + encodingEntry(0x0d, 8, maxRect) + encodingEntry(0x00, 8, maxRect))
        records += record(0x07, capsRecord07)
        records += record(0x08, capsRecord08)
        records += record(0x0a, capsRecord0A)
        records += capsTail
        var head = [UInt8](repeating: 0, count: 30)
        put(mac, into: &head, at: 0)
        put(be16(records.count), into: &head, at: 26)
        return head + records
    }

    /// Parses the decoded records of a capabilities reply; unknown ones are skipped.
    static func parseCapabilities(_ payload: [UInt8]) -> ParsedCapabilities {
        var out = ParsedCapabilities()
        guard payload.count >= 30 else { return out }
        let end = min(payload.count, 30 + ((Int(payload[26]) << 8) | Int(payload[27])))
        var pos = 30
        while pos + 2 <= end {
            let type = payload[pos]
            let len = Int(payload[pos + 1])
            guard pos + 2 + len <= payload.count else { break }
            let d = Array(payload[pos + 2 ..< pos + 2 + len])
            if type == 0x01 && len >= 4 { out.modelCode = readLE32(d, 0) }
            if type == 0x03 && len >= 4 { out.nativeResolution = EpsonSize(width: readLE16(d, 0), height: readLE16(d, 2)) }
            if type == 0x04 && len >= 6 { out.framebuffer = EpsonSize(width: readLE16(d, 2), height: readLE16(d, 4)) }
            if type == 0x05 && len >= 22 { out.maxRect = EpsonSize(width: readLE16(d, 14), height: readLE16(d, 16)) }
            if type == 0x0a { break } // the bytes after this record aren't decoded yet
            pos += 2 + len
        }
        return out
    }

    // MARK: session setup

    // Connect-request prefix bytes that are constant in every capture and
    // not yet understood (see docs § Connect request).
    private static let connectPrefixNetmask: [UInt8] = [0x00, 0xff, 0xff, 0xff] // offsets 12-15
    private static let connectPrefixVersion: [UInt8] = [0x00, 0x02, 0x0f, 0x03] // offsets 20-23
    private static let connectPrefix44: [UInt8] = [0x01, 0x0c] // offsets 44-45
    // RFB PIXEL_FORMAT: 32 bpp, depth 32, little-endian, true colour,
    // max 255/255/255 (LE), shifts 0/8/16.
    private static let connectPixelFormat: [UInt8] = [
        0x20, 0x20, 0x00, 0x01, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0x00, 0x08, 0x10, 0x00, 0x00, 0x00,
    ]
    private static let connectTag30: [UInt8] = [0x06, 0x00, 0x00, 0x00] + Array("405".utf8) + [UInt8](repeating: 0, count: 5)

    /// Connect request (fam 1 / 0x01). `screen` is the app's own screen
    /// size; the app declares 32bpp RGB888 here even though it streams
    /// JPEG. `resume` sets the user entry's 0x0c flag (seen once, when
    /// reconnecting right after a dropped session).
    static func connectRequestPayload(
        client: ClientIdentity,
        target: ProjectorIdentity,
        screen: EpsonSize = defaultScreen,
        resume: Bool = false
    ) -> [UInt8] {
        var p = [UInt8](repeating: 0, count: 74)
        p[0] = 0x01 // long prefix
        p[1] = 0x01 // body follows
        put(connectPrefixNetmask, into: &p, at: 12)
        put(connectPrefixVersion, into: &p, at: 20)
        put(le16(screen.width), into: &p, at: 24)
        put(le16(screen.height), into: &p, at: 26)
        put(connectPixelFormat, into: &p, at: 28)
        put(connectPrefix44, into: &p, at: 44)
        put(target.mac, into: &p, at: 48)
        put(target.ip, into: &p, at: 70)
        return withBody(p, [
            userEntry(client, registered: resume, flags: EempUserFlags.pending),
            projectorList(target),
            EempTLV.record(0x0f, le32(maxConnections)),
            EempTLV.record(0x0d, le32(1)),
            EempTLV.record(0x26, [UInt8](repeating: 0, count: 8)),
            EempTLV.record(0x2e, [0]),
            EempTLV.record(0x30, connectTag30),
        ])
    }

    static func parseConnectRequest(_ payload: [UInt8]) -> ParsedConnectRequest? {
        guard payload.count >= 78, payload[0] == 0x01 else { return nil }
        let bodyEnd = min(payload.count, 78 + Int(readLE32(payload, 74)))
        guard let records = EempTLV.parse(Array(payload[78..<bodyEnd])),
              let user = records.first(where: { $0.tag == 0x05 }),
              let client = parseUserEntry(user.value) else { return nil }
        return ParsedConnectRequest(
            client: client,
            screen: EpsonSize(width: readLE16(payload, 24), height: readLE16(payload, 26)),
            targetMAC: Array(payload[48..<54]),
            targetIP: Array(payload[70..<74])
        )
    }

    /// Connect accept (fam 1 / 0x02).
    static func connectAcceptPayload(client: ClientIdentity, projector: ProjectorIdentity) -> [UInt8] {
        var p = [UInt8](repeating: 0, count: 74)
        p[0] = 0x01
        p[1] = 0x01
        put(le32(2), into: &p, at: 4)
        put(projector.mac, into: &p, at: 48)
        return withBody(p, [
            userEntry(client, registered: true, flags: EempUserFlags.connected),
            projectorList(projector),
            EempTLV.record(0x0f, le32(maxConnections)),
            EempTLV.record(0x1e),
        ])
    }

    // MARK: session state (layout)

    /// State broadcast (fam 1 / 0x0e). `version` is the projector-wide
    /// state counter.
    static func stateBroadcastPayload(version: UInt32, state: ScreenState) -> [UInt8] {
        var records = [EempTLV.list(0x07, state.presenter.map(slot))]
        if let panels = state.panels { records.append(EempTLV.list(0x08, panels.map(slot))) }
        records.append(EempTLV.list(0x06, state.users.map { userEntry($0, registered: true, flags: EempUserFlags.connected) }))
        return withBody(shortPrefix(body: true, at4: version), records)
    }

    /// The usual "client alone, full screen and in panel 1" layout.
    static func soloLayout(_ client: ClientIdentity, presenterFlags: UInt32 = EempUserFlags.onScreen, panelFlags: UInt32? = nil) -> ScreenLayout {
        ScreenLayout(
            presenter: [.user(client, flags: presenterFlags)],
            panels: [.user(client, flags: panelFlags ?? presenterFlags), .empty(slot: 2), .empty(slot: 3), .empty(slot: 4)]
        )
    }

    /// Layout request (fam 1 / 0x08): "put me on screen". Defaults to
    /// `soloLayout(client)`.
    static func layoutRequestPayload(client: ClientIdentity, layout: ScreenLayout? = nil) -> [UInt8] {
        let layout = layout ?? soloLayout(client)
        return withBody(shortPrefix(body: true, at4: 0), [
            userEntry(client, registered: true, flags: EempUserFlags.pending),
            EempTLV.list(0x07, layout.presenter.map(slot)),
            EempTLV.list(0x08, layout.panels.map(slot)),
        ])
    }

    /// Layout accepted (fam 1 / 0x09): the request *payload* echoed back
    /// with the new state version, and the requester's own entry marked
    /// connected. Nil if `request` isn't a well-formed layout request.
    static func layoutAcceptedPayload(request: [UInt8], version: UInt32) -> [UInt8]? {
        guard request.count >= 52 else { return nil }
        let bodyEnd = min(request.count, 52 + Int(readLE32(request, 48)))
        guard let records = EempTLV.parse(Array(request[52..<bodyEnd])) else { return nil }
        var rebuilt: [[UInt8]] = []
        for (i, r) in records.enumerated() {
            if i == 0 && r.tag == 0x05 {
                guard let u = parseUserEntry(r.value) else { return nil }
                rebuilt.append(userEntry(u.identity, registered: u.registered, flags: EempUserFlags.connected))
            } else {
                rebuilt.append(EempTLV.record(r.tag, r.value))
            }
        }
        return withBody(shortPrefix(body: true, at4: version), rebuilt)
    }

    // MARK: streaming, heartbeats, teardown

    /// Start streaming (fam 0 / 0x16): `@8 = 1`.
    static func startStreamPayload() -> [UInt8] {
        shortPrefix(at8: 1)
    }

    /// Streaming started (fam 1 / 0x27): `@4 = 3`. Optional in practice.
    static func streamStartedPayload() -> [UInt8] {
        shortPrefix(at4: 3)
    }

    /// Projector heartbeat (fam 0 / 0x0a). `sampleRate` is 0 in the
    /// immediate reply to the app's first heartbeat and 44100 in the
    /// periodic ones. The app's own heartbeat has an empty payload.
    static func projectorHeartbeatPayload(sampleRate: UInt32 = heartbeatSampleRate) -> [UInt8] {
        shortPrefix(at8: sampleRate)
    }

    /// Stale-session notice (fam 1 / 0x17): body `{0x25: 1}`.
    static func staleSessionPayload() -> [UInt8] {
        withBody(shortPrefix(body: true), [EempTLV.record(0x25, le32(1))])
    }

    /// Disconnect ack (fam 1 / 0x05), reply to the app's empty 0x04:
    /// `@4 = 1, @8 = 1`.
    static func disconnectAckPayload() -> [UInt8] {
        shortPrefix(at4: 1, at8: 1)
    }

    /// Disconnected by the projector (fam 1 / 0x07): `@4 = 1, @8 = 2`.
    static func disconnectedByProjectorPayload() -> [UInt8] {
        shortPrefix(at4: 1, at8: 2)
    }
}

// MARK: - message builders (control channel, TCP port 3620)

/// Complete, ready-to-send messages for every step of the client flow.
/// See 02-control-channel.md for when to send each one.
enum EpsonClientMessages {
    /// The app sends a heartbeat this often, on its own timer. The
    /// projector runs an independent 15 s timer of its own.
    static let heartbeatInterval: TimeInterval = 15

    /// UDP broadcast search (status 1, family 0). Optional — see
    /// 02-control-channel.md for why you may want to skip discovery
    /// entirely on iOS and let the user enter a host instead.
    static func search(clientIP: [UInt8]) -> [UInt8] {
        EpsonWire.eempMessage(ipAddress: clientIP, status: EempFamily0Status.search, family: 0,
                              payload: EempPayloads.searchPayload())
    }

    /// Probe (status 2, family 0). Send over a fresh TCP connection to port
    /// 3620; expect status 3 (identity — parse it with
    /// `EempPayloads.parseIdentity`) then status 0x15 back, then close the
    /// connection.
    static func probe(clientIP: [UInt8]) -> [UInt8] {
        EpsonWire.eempMessage(ipAddress: clientIP, status: EempFamily0Status.probe, family: 0,
                              payload: EempPayloads.searchPayload())
    }

    /// Connect request (status 1, family 1). Send first, over a *new* TCP
    /// connection to port 3620 (the probe connection must already be
    /// closed). `target` comes from the projector's identity reply.
    static func connectRequest(
        client: ClientIdentity,
        target: ProjectorIdentity,
        screen: EpsonSize = EempPayloads.defaultScreen,
        resume: Bool = false
    ) -> [UInt8] {
        EpsonWire.eempMessage(ipAddress: client.ip, status: EempFamily1Status.connectRequest, family: 1,
                              payload: EempPayloads.connectRequestPayload(client: client, target: target, screen: screen, resume: resume))
    }

    /// Layout request (status 8, family 1): "put me on screen", alone,
    /// full screen. Send once you've seen the status 2/family 1 connect
    /// accept.
    static func layoutRequest(client: ClientIdentity) -> [UInt8] {
        EpsonWire.eempMessage(ipAddress: client.ip, status: EempFamily1Status.layoutRequest, family: 1,
                              payload: EempPayloads.layoutRequestPayload(client: client))
    }

    /// Streaming started (status 0x27, family 1). Optional: the real app
    /// sends it on `0x16`, alongside its first video frame, and has been
    /// seen to skip it.
    static func streamStarted(clientIP: [UInt8]) -> [UInt8] {
        EpsonWire.eempMessage(ipAddress: clientIP, status: EempFamily1Status.streamStarted, family: 1,
                              payload: EempPayloads.streamStartedPayload())
    }

    /// Heartbeat (status 0x0a, family 0, **empty** payload). Send one right
    /// after the connect accept, then every `heartbeatInterval` seconds.
    static func heartbeat(clientIP: [UInt8]) -> [UInt8] {
        EpsonWire.eempMessage(ipAddress: clientIP, status: EempFamily0Status.heartbeat, family: 0)
    }

    /// Clean disconnect (status 0x04, family 1, empty). Close the 3621
    /// sockets first, send this, then wait for `0x05` (the projector closes
    /// 3620 right after it).
    static func disconnect(clientIP: [UInt8]) -> [UInt8] {
        EpsonWire.eempMessage(ipAddress: clientIP, status: EempFamily1Status.disconnect, family: 1)
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

    /// The framebuffer size the real app declares, and what the captured
    /// projector advertises in capabilities record 0x04.
    static let defaultFramebuffer = EpsonSize(width: 1280, height: 800)

    // RFB PIXEL_FORMAT the app declares: 16 bpp RGB565, little-endian
    // pixels, maxes 31/63/31 (stored little-endian, unlike plain RFB),
    // shifts 11/5/0. Unused in practice — frames are JPEG.
    private static let helloPixelFormat: [UInt8] = [
        0x10, 0x10, 0x00, 0x01, 0x1f, 0x00, 0x3f, 0x00, 0x1f, 0x00, 0x0b, 0x05, 0x00, 0x00, 0x00, 0x00,
    ]

    /// The 46-byte hello payload (RFB ServerInit-like): magic `0xcc` u32
    /// LE, width/height u16 BE, pixel format, then a trailer of two
    /// (w, h, 0, 0) groups and 6 zero bytes (meaning unconfirmed).
    /// Byte-identical to the app's for 1280x800.
    static func helloPayload(size: EpsonSize = defaultFramebuffer) -> [UInt8] {
        var p = [UInt8](repeating: 0, count: 46)
        put(le32(0xcc), into: &p, at: 0)
        put(be16(size.width) + be16(size.height), into: &p, at: 4)
        put(helloPixelFormat, into: &p, at: 8)
        put(be16(size.width) + be16(size.height), into: &p, at: 24)
        put(be16(size.width) + be16(size.height), into: &p, at: 32)
        return p
    }

    /// The EPRD0600 hello. Send once, immediately after opening the video
    /// connection, before any FramebufferUpdate. `size` should match the
    /// projector's capabilities framebuffer (record 0x04).
    static func hello(clientIP: [UInt8], size: EpsonSize = defaultFramebuffer) -> [UInt8] {
        EpsonWire.encodeMessage(
            controlWord: EpsonWire.eprdControlWord, ipAddress: clientIP,
            status: 0, family: 0, payload: helloPayload(size: size), lengthEndianness: .little
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
            controlWord: EpsonWire.eprdControlWord, ipAddress: clientIP,
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
    /// header's `ipAddress` field on every message you send, and for your
    /// `ClientIdentity` (the connect and layout requests carry it too).
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
                address = String(decoding: hostname.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
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
