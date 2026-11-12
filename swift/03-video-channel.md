# Video Channel (`EPRD0600`, TCP port 3621)

Opened the moment you send the stream ack in response to the control
channel's `0x16` "start streaming" signal (see
[02-control-channel.md](./02-control-channel.md)).
(The real app opens it, plus a second idle connection, as soon as it
receives `0x10`. See [README § Before testing on real hardware](./README.md#before-testing-on-real-hardware).) Builders are in
`EpsonVideo` in [`EpsonProjectorKit.swift`](./EpsonProjectorKit.swift).

## Direction: you only send

This connection is **push-only**. The projector never writes anything back
on it — you don't need a receive loop on this connection at all for normal
operation (though `EprdFrameParser` in the kit exists if you ever want to
sanity-check your own output against itself, e.g. in a test).

## The sequence

1. Open a new TCP connection to the projector's IP, port 3621.
2. Send **one** hello message.
3. Send a FramebufferUpdate message repeatedly — once per frame you want
   to display. There's no confirmed real-world timing requirement; this
   repo's reference implementation uses 500ms as a reasonable default.

```swift
let videoConnection = NWConnection(host: NWEndpoint.Host(host), port: 3621, using: .tcp)
videoConnection.stateUpdateHandler = { state in
    guard case .ready = state else { return }
    videoConnection.send(content: Data(EpsonVideo.hello(clientIP: myIP)), completion: .contentProcessed { _ in })
    // then start a repeating timer sending EpsonVideo.update(...)
}
videoConnection.start(queue: .main)
```

## The hello message

Sent once. **Little-endian length** (see [01-wire-format.md](./01-wire-format.md#the-endianness-rule--read-this-twice)
— this is the one EPRD0600 message that isn't big-endian). The 46-byte
payload is a fixed, captured blob (`EpsonTemplates.eprdInit`) — send it
verbatim, there's nothing to fill in:

```swift
connection.send(content: Data(EpsonVideo.hello(clientIP: myIP)), completion: .contentProcessed { _ in })
```

It declares a 1280×800 framebuffer and 16bpp RGB565 pixel format, but in
practice the actual frames you send can be any size — see
[`../docs/eprd-video-protocol.md`](../docs/eprd-video-protocol.md#hello-message)
for the full byte-level breakdown if you're curious, none of it is
something you need to compute yourself.

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

The simplest case — one full-frame rect per update, e.g. from a
`UIImage`'s JPEG representation:

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
- Multiple rects in one update are just multiple tiles of one frame (e.g.
  splitting a screen into quadrants) — see `EpsonVideo.update`'s
  implementation for the exact repeated-rect layout if you want to tile.

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

Not a confirmed protocol requirement — pick something reasonable and
adjust based on how it looks:

```swift
Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
    self?.sendCurrentFrame()
}
```

Faster updates mean smoother video but more bandwidth and JPEG-encoding
CPU cost; slower updates are cheaper but laggier. 500ms (2 fps) is what
this repo's reference client defaults to, purely as a starting point, not
because it's been confirmed as correct or optimal against real hardware.
