# Wire Format

The 20-byte header both channels share, and how to turn a raw TCP byte
stream into discrete messages. Implemented in
[`EpsonProjectorKit.swift`](./EpsonProjectorKit.swift)'s `EpsonWire` enum —
every code block below is that same code, or a direct caller of it.

## The 20-byte header

Every message on both the control channel (port 3620, control word
`EEMP0100`) and the video channel (port 3621, control word `EPRD0600`)
starts with this header, immediately followed by `payloadLength` bytes of
payload:

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 8 | control word | ASCII, `"EEMP0100"` or `"EPRD0600"` |
| 8 | 4 | IP address | Your device's own IPv4, one byte per octet, on every message you send |
| 12 | 1 | status | Message type — see [02-control-channel.md](./02-control-channel.md#message-catalog) |
| 13 | 1 | family | `0` = discovery/network-level, `1` = session-level. The same status byte means different things depending on this. |
| 14 | 2 | padding | Always zero |
| 16 | 4 | payload length | `UInt32` — **endianness varies, see below** |

## The endianness rule — read this twice

The payload-length field is:

- **Little-endian** on every `EEMP0100` message (both directions), and on
  the `EPRD0600` hello.
- **Big-endian** on every `EPRD0600` FramebufferUpdate message (i.e.
  everything on the video channel *after* the hello).

This isn't a typo or a guess — it was confirmed byte-for-byte against a raw
packet capture (see [`../docs/eemp-control-protocol.md`](../docs/eemp-control-protocol.md#wire-frame-header)
for the worked example) and re-confirmed by round-tripping real messages
through this exact Swift code against the reference simulator. Get this
wrong and every message after the first misparses, because the length
field is how you know where one message ends and the next begins.

`EpsonProjectorKit.swift` models this as an explicit parameter rather than
hiding it, so you can't forget it at a call site:

```swift
enum LengthEndianness { case little, big }

static func encodeMessage(
    controlWord: String,
    ipAddress: [UInt8],
    status: UInt8,
    family: UInt8 = 0,
    payload: [UInt8],
    lengthEndianness: LengthEndianness = .little   // .big only for EPRD updates
) -> [UInt8]
```

## Building a message

```swift
let clientIP: [UInt8] = [192, 168, 1, 10]

let probeMessage = EpsonWire.encodeMessage(
    controlWord: EpsonWire.eempControlWord,   // "EEMP0100"
    ipAddress: clientIP,
    status: EempFamily0Status.probe,          // 2
    family: 0,
    payload: EempPayloads.searchPayload()     // 48 zero bytes
)
// probeMessage is 20 + 48 = 68 bytes, ready to write to the socket
```

`EpsonWire.eempMessage(ipAddress:status:family:payload:)` is the same thing
with the control word filled in. In practice you won't call either directly
for the control channel. Use the helpers in `EpsonClientMessages` (see
[02-control-channel.md](./02-control-channel.md)), which pick the right
status and family and build the payload for each step.

## Payload layout

Control-channel payloads aren't opaque blobs. `EempPayloads` builds every
one field by field (a port of `lib/shared/messages.ts`), so the bytes come
from your own identity and the projector's, not from a capture. The shape,
in full in
[`../docs/eemp-control-protocol.md § Payload layout`](../docs/eemp-control-protocol.md#payload-layout):

- Every non-empty payload starts with a **prefix**: 48 bytes (byte 0 =
  `0x00`, "short") or 74 bytes (byte 0 = `0x01`, "long": identity reply,
  connect request, connect accept).
- **Byte 1 = `0x01` means a body follows**: a `UInt32` LE body length, then
  TLV records.
- In the short prefix, `UInt32` LE fields at offsets 4 and 8 carry small
  values (for example `0x16` has `@8 = 1`, and in layout messages `@4` is
  the state version).
- A **TLV record** is `tag u32 LE | length u32 LE | value`. Containers
  nest, and a list is a `u32 LE` count followed by the entries.
  `EempTLV.record`, `EempTLV.list` and `EempTLV.parse` handle these.
- Strings: the client name (TLV `0x01`) is **UTF-16LE**. The projector
  name is ASCII, zero-padded to 32 bytes.

The capabilities reply (`0x15`) is the one exception with its own
`[type u8][len u8]` record format. `EempPayloads.parseCapabilities` reads
it.

## Decoding a header

```swift
guard let header = EpsonWire.decodeHeader(bytes) else { return } // < 20 bytes, incomplete
print(header.status, header.family, header.payloadLength)
let payload = Array(bytes[20 ..< 20 + header.payloadLength])
```

`decodeHeader` takes the same `lengthEndianness` parameter — pass `.big`
when you're parsing FramebufferUpdate messages on the video channel.

## Reassembling messages from a TCP stream

TCP is a byte stream, not a message stream. A single `receive` callback on
`NWConnection` can hand you:

- Less than one full message (even less than the 20-byte header itself)
- Exactly one message
- Several messages concatenated together
- One and a half messages (the back half arrives on the *next* callback)

You cannot assume any correspondence between "one receive call" and "one
protocol message." The only reliable way to find message boundaries is the
length field in the header itself, so every receiver needs to accumulate
bytes into a buffer and repeatedly try to slice complete messages out of
it:

```swift
static func extractMessages(_ buffer: [UInt8]) -> (messages: [[UInt8]], rest: [UInt8]) {
    var messages: [[UInt8]] = []
    var rest = buffer[...]
    while rest.count >= headerLength {
        // peek at the length field without fully decoding yet
        let lengthBytes = rest[rest.startIndex + 16 ..< rest.startIndex + 20]
        let length = lengthBytes.enumerated().reduce(UInt32(0)) { acc, item in
            acc | (UInt32(item.element) << (8 * item.offset))
        }
        let messageLength = headerLength + Int(length)
        guard rest.count >= messageLength else { break }   // wait for more bytes
        messages.append(Array(rest.prefix(messageLength)))
        rest = rest.dropFirst(messageLength)
    }
    return (messages, Array(rest))
}
```

Usage pattern, inside your `NWConnection` receive loop:

```swift
var pending: [UInt8] = []

func handleReceived(_ chunk: [UInt8]) {
    pending.append(contentsOf: chunk)
    let (messages, rest) = EpsonWire.extractMessages(pending)
    pending = rest
    for message in messages {
        let header = EpsonWire.decodeHeader(message)!
        // dispatch on header.status / header.family — see 02-control-channel.md
    }
}
```

`extractMessages` as written is for the control channel, where the length
field is always little-endian. The video channel needs the same idea but
with the endianness switching after the first message — `EprdFrameParser`
in the kit implements that as a small stateful class rather than trying to
force it through the generic function; see
[03-video-channel.md](./03-video-channel.md).

## A note on `Data` vs `[UInt8]`

This kit deliberately works in `[UInt8]` rather than `Data` for all offset
arithmetic. `Data` is a "slicing" collection — `someData.dropFirst(20)`
does **not** reset indices to zero, so `slice[0]` can crash with an
out-of-range error when `slice` is actually a subrange starting at index
20 of some larger buffer. This is a very common source of crashes in
hand-rolled Swift networking code. `Array(data)` always produces a fresh,
zero-based array, which is why every function here takes and returns
`[UInt8]` and converts at the `Data`/socket boundary rather than slicing
`Data` directly. If you adapt this to work with `Data` end-to-end for
performance reasons, keep this gotcha in mind at every subscript.
