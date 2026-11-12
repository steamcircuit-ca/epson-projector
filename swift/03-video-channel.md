# Video Channel (`EPRD0600`, TCP port 3621)

Opened when the control channel sends `0x10`/family 1 ("open video
channel"), and written to once it sends `0x16`/family 0 ("start
streaming"). See [02-control-channel.md](./02-control-channel.md#3-session-new-tcp-connection).
Builders are in `EpsonVideo` in [`EpsonProjectorKit.swift`](./EpsonProjectorKit.swift).

## Direction: you only send

This connection is **push-only**. The projector never writes anything back
on it — you don't need a receive loop on this connection at all for normal
operation (though `EprdFrameParser` in the kit exists if you ever want to
sanity-check your own output against itself, e.g. in a test).

## The sequence

1. On `0x10`, open **two** new TCP connections to the projector's IP,
   port 3621. Only the first carries data. The second carries nothing in
   any capture but the real app keeps it open for the whole session
   (probably reserved for audio), so open it too and close it with the
   first.
2. On `0x16`, send **one** hello message on the first connection,
   immediately followed by your first frame. (Then send the optional
   `0x27` on the control channel.)
3. Send a FramebufferUpdate whenever the screen changes. The real app
   doesn't stream at a fixed rate.

```swift
// on 0x10
let video = NWConnection(host: NWEndpoint.Host("192.168.1.20"), port: 3621, using: .tcp)
let idle = NWConnection(host: NWEndpoint.Host("192.168.1.20"), port: 3621, using: .tcp)
video.start(queue: .main)
idle.start(queue: .main)

// on 0x16
video.send(content: Data(EpsonVideo.hello(clientIP: myIP, size: framebuffer)), completion: .contentProcessed { _ in })
video.send(content: Data(EpsonVideo.update(clientIP: myIP, rects: firstFrameTiles)), completion: .contentProcessed { _ in })
```

## The hello message

Sent once. **Little-endian length** (see [01-wire-format.md](./01-wire-format.md#the-endianness-rule--read-this-twice)
— this is the one EPRD0600 message that isn't big-endian).
`EpsonVideo.helloPayload(size:)` builds the 46-byte payload: magic `0xcc`,
the framebuffer width/height (u16 BE), a 16bpp RGB565 pixel format, and a
trailer that repeats the size. The only input is the size:

```swift
// From the projector's capabilities reply (record 0x04), default 1280×800.
let framebuffer = EempPayloads.parseCapabilities(capabilitiesPayload).framebuffer ?? EpsonVideo.defaultFramebuffer
connection.send(content: Data(EpsonVideo.hello(clientIP: myIP, size: framebuffer)), completion: .contentProcessed { _ in })
```

For 1280×800 it's byte-identical to the real app's hello. The pixel format
isn't used for anything, since every frame is JPEG. See
[`../docs/eprd-video-protocol.md`](../docs/eprd-video-protocol.md#hello-message)
for the full byte-level breakdown.

## FramebufferUpdate messages — the actual video content

**Big-endian length** this time. Each update carries one or more
rectangles, each one a complete, independent JPEG image plus its position
on screen:

```swift
struct VideoRect {
    let x: UInt16
    let y: UInt16
    let w: UInt16
    let h: UInt16
    let jpeg: [UInt8]   // raw baseline-JPEG file bytes, sent as-is
}
```

**Keep each rect within the projector's maximum rect size**: 656×416 on
the captured projector (`EempPayloads.defaultMaxRect`), reported per unit
as `parseCapabilities(_:).maxRect`. The real app always sends its
1280×800 screen as the same four tiles: 656×416, 624×416, 656×384 and
624×384, at (0,0), (656,0), (0,416) and (656,416). A single full-screen
rect may be rejected by real hardware.

Building one rect from a `UIImage`'s JPEG representation (crop your frame
into tiles first, one JPEG per tile):

```swift
guard let uiImage = /* your captured frame */,
      let jpegData = uiImage.jpegData(compressionQuality: 0.8) else { return }
let jpegBytes = [UInt8](jpegData)
guard let dims = jpegDimensions(jpegBytes) else { return }   // reads the JPEG's own SOF marker

let rect = VideoRect(x: 0, y: 0, w: UInt16(dims.width), h: UInt16(dims.height), jpeg: jpegBytes)
let updateMessage = EpsonVideo.update(clientIP: myIP, rects: [rect])
connection.send(content: Data(updateMessage), completion: .contentProcessed { _ in })
```

Important constraints on the JPEG itself:

- **Baseline JPEG only.** `jpegDimensions` (and, presumably, the real
  projector's decoder) expects a standard baseline SOF marker. Progressive
  JPEGs will fail to size correctly at minimum, and may not display at
  all — `UIImage.jpegData` produces baseline JPEG by default, so this is
  usually a non-issue unless you're sourcing JPEG bytes from somewhere else.
- **No re-encoding, no header stripping.** The bytes go on the wire exactly
  as they come out of the encoder — this is literally an embedded JPEG
  file, not a raw pixel buffer.
- Multiple rects in one update are just multiple tiles of one frame —
  pass all four tiles to one `EpsonVideo.update` call.

## What's actually happening on the wire, byte by byte

If you want to understand `EpsonVideo.update` rather than just call it —
each rect is:

```
u16 BE   x
u16 BE   y
u16 BE   w
u16 BE   h
i32 BE   encoding = 7          (Tight)
u8       control  = 0x90       (JPEG compression)
varint   compact length        (see below)
bytes    jpeg data
```

preceded by a small update header (`u8 type=0, u8 pad, u16 BE rectCount`),
and the "compact length" is a base-128 varint (7 payload bits per byte,
continuation flagged by the top bit) — the kit always emits it as 3 bytes,
matching what the real captures show, even for short JPEGs where 1 or 2
bytes would technically suffice; both are valid per the varint's own rules.
Full provenance for all of this (it's RFB/VNC's Tight encoding, reused) is
in [`../docs/eprd-video-protocol.md`](../docs/eprd-video-protocol.md).

## Frame cadence

The real app sends a frame only when its screen changes. Nothing on the
video channel needs keeping alive (the control channel's heartbeats do
that), so a static image can be sent once. For live content, send on
change and cap the rate at whatever your JPEG encoder and the network
manage. Faster updates mean smoother video but more bandwidth and
encoding cost. No maximum rate has been confirmed against real hardware.

## Closing

When you disconnect, close both 3621 connections **first**, then send
`0x04` on the control channel (see
[02-control-channel.md § Teardown](./02-control-channel.md#5-teardown)).
If the projector sends `0x07`, it has already closed them.
