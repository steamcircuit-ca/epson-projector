# EPRD0600 — Video Streaming Protocol

The video/framebuffer stream. Control word `EPRD0600`, TCP port 3621
(`IMAGE_SERVER_PORT`). The real app connects as soon as the control
channel sends `0x10`, and starts writing when `0x16` arrives. See
[`eemp-control-protocol.md § Session establishment`](./eemp-control-protocol.md#session-establishment).
(`lib/client` connects on `0x16` instead.)

Implemented by: `lib/shared/eprd.ts` (framing, build + incremental parse),
`lib/shared/constants.ts` (`EPRD_INIT` template), `lib/client/session.ts`
(`streamVideo()`), `lib/simulator/handlers.ts` (`handleImageServerConnection()`).

It's a **modified VNC/RFB** protocol: the hello message is RFB's
`ServerInit` shape, and frame updates are RFB `FramebufferUpdate` messages
using the Tight encoding with JPEG-compressed rects — but reused
*backwards* (the client sends both messages; see [Direction](#direction)
below) and wrapped in the same 20-byte header style as the control
protocol, with one critical difference in byte order.

## Contents

- [Direction](#direction)
- [Frame header — and its one gotcha](#frame-header--and-its-one-gotcha)
- [Hello message](#hello-message)
- [FramebufferUpdate messages](#framebufferupdate-messages)
- [What the app actually sends](#what-the-app-actually-sends)
- [Closing](#closing)
- [Test content](#test-content)
- [Known unknowns](#known-unknowns)

## Direction

Unlike a normal VNC session, this channel is **one-directional: client →
projector only**. The client connects out to the projector's port 3621 and
pushes the hello and every frame. The real projector never writes a byte
back. `lib/simulator` does the same: it parses the stream, forwards it to
its debug preview page (`lib/simulator/preview.ts`), and never replies.

**The app opens two connections to 3621**, back to back, in every
captured session. Only the first carries EPRD data. The second carries
**nothing in either direction** for the whole session, but it's kept
open and closed alongside the first. *Inferred:* it's reserved for audio.
The projector's control-channel heartbeat announces 44100 (a sample
rate), and the captured app had no audio to send. `lib/client` opens only
one connection. Whether the projector requires the second one is unknown.

## Frame header — and its one gotcha

Same 20-byte layout as the control protocol
([full field table here](./eemp-control-protocol.md#wire-frame-header)),
with the control word `EPRD0600` instead of `EEMP0100`:

| Offset | Size | Field |
|---|---|---|
| 0 | 8 | `controlWord` = `"EPRD0600"` |
| 8 | 4 | `ipAddress` (the client's IP, on every message on this channel) |
| 12 | 1 | `status` (always `0` in every capture) |
| 13 | 1 | `family` (always `0`) |
| 14 | 2 | padding |
| 16 | 4 | `payloadLength`, `uint32` — **endianness depends on message type, see below** |

> **Gotcha:** the `payloadLength` field is **little-endian on the hello
> message**, and **big-endian on every `FramebufferUpdate` after it**. This
> is a real quirk of the captured protocol (not a bug in this repo) — the
> hello reuses the control channel's LE convention, while the update
> messages follow plain RFB's big-endian convention. `lib/shared/eprd.ts`'s
> `EprdStreamParser` handles this by tracking whether it has seen the hello
> yet (`sawHello`) and switching which `readUInt32` it calls accordingly.
> Get this wrong and every subsequent message misparses, since the header
> is how you know where the payload ends and the next header starts.

## Hello message

Sent once, immediately after the client connects. 46-byte payload,
essentially RFB's `ServerInit`:

| Offset | Size | Field | Value in the captures |
|---|---|---|---|
| 0 | 4 | magic | `cc 00 00 00` |
| 4 | 2 | `framebufferWidth`, `uint16` **BE** | `1280` |
| 6 | 2 | `framebufferHeight`, `uint16` **BE** | `800` |
| 8 | 16 | RFB `PIXEL_FORMAT` block (standard RFB layout — see below) | 16bpp RGB565 |
| 24 | 22 | trailer (see note) | — |

The `PIXEL_FORMAT` block (offsets 8–23) is byte-for-byte the standard RFB
layout, **except** the three "max" fields are little-endian here where the
RFB spec says big-endian — `lib/shared/constants.ts`'s comment already
flags this ("maxes little-endian"), confirmed by decoding it:

| Offset | Size | Field | Captured value |
|---|---|---|---|
| 8 | 1 | bits-per-pixel | `16` |
| 9 | 1 | depth | `16` |
| 10 | 1 | big-endian-flag | `0` (pixel data itself is little-endian) |
| 11 | 1 | true-color-flag | `1` |
| 12 | 2 | red-max, `uint16` **LE** | `31` (5 bits) |
| 14 | 2 | green-max, `uint16` **LE** | `63` (6 bits) |
| 16 | 2 | blue-max, `uint16` **LE** | `31` (5 bits) |
| 18 | 1 | red-shift | `11` |
| 19 | 1 | green-shift | `5` |
| 20 | 1 | blue-shift | `0` |
| 21 | 3 | padding | zero |

That's exactly RGB565: 5 bits red at shift 11, 6 bits green at shift 5, 5
bits blue at shift 0.

The 22-byte trailer (offsets 24–45) doesn't match standard RFB's
`name-length` + `name-string` tail. What's there is the width/height pair
repeated twice, each as `uint16 BE` × 2 followed by 4 zero bytes, then 6
more zero bytes:

```
24: 05 00 03 20 00 00 00 00   1280, 800, 0, 0
32: 05 00 03 20 00 00 00 00   1280, 800, 0, 0
40: 00 00 00 00 00 00
```

*Inferred:* these are two `w, h, x, y`-style rectangles, for example
"source screen" and "visible area". The hello is byte-identical in all 8
captured sessions, so nothing here varies with the content.

The size matches capabilities record `0x04` (1280×800) from the
projector's `0x15` reply. The pixel format declared here (16 bpp RGB565)
differs from the 32 bpp one in the app's connect request. Since every
frame is JPEG, neither format is ever used for actual pixel data.

Build/read: `lib/shared/eprd.ts` `buildEprdHello()` / `EprdStreamParser.handleInit()`
(the parser only reads width/height, at offsets 4 and 6 — it doesn't
validate the rest of the block).

## FramebufferUpdate messages

Payload is a standard-shape RFB `FramebufferUpdate`:

```
u8      messageType        = 0
u8      padding
u16 BE  rectCount
  × rectCount:
    u16 BE   x
    u16 BE   y
    u16 BE   w
    u16 BE   h
    i32 BE   encoding       = 7  (Tight)
    u8       tightControl   = 0x90  (high nibble 0x9 = JPEG compression)
    varint   compactLength  (see below)
    bytes    jpegData[compactLength]
```

**Compact length encoding** (RFB Tight's "compact length" format): base-128
varint, 7 payload bits per byte, LSB group first, continuation flagged by
the top bit:

```
byte0 = (length      & 0x7f) | (more ? 0x80 : 0)
byte1 = (length >> 7  & 0x7f) | (more ? 0x80 : 0)   -- only if byte0 had the continuation bit
byte2 = (length >> 14 & 0x7f)                        -- only if byte1 had the continuation bit
```

`EprdStreamParser` (`lib/shared/eprd.ts`) reads the general 1–3-byte form.
The real app always writes **3 bytes**, even when 2 would do. For
example, 4890 is sent as `9a a6 00`: the second byte keeps its
continuation bit and the third is zero. `buildEprdUpdate` does the same.

Build/read: `lib/shared/eprd.ts` `buildEprdUpdate()` / `EprdStreamParser.handleUpdate()`.

## What the app actually sends

All 8 captured sessions, 13 updates in total:

- **Always the same 4-tile grid, always all 4 tiles.** The 1280×800
  screen is cut at x = 656 and y = 416:

  | Tile | x, y | w × h |
  |---|---|---|
  | 1 | 0, 0 | 656 × 416 |
  | 2 | 656, 0 | 624 × 416 |
  | 3 | 0, 416 | 656 × 384 |
  | 4 | 656, 416 | 624 × 384 |

  656 × 416 is exactly the maximum rect size in the projector's
  capabilities reply (`0x15`, record `0x05`). The app never sends a
  partial (dirty-rect) update. Even a frame that's black apart from a
  logo in tile 4 is sent as all four tiles.
- **No fixed frame rate.** Updates are sparse and irregular. Gaps seen:
  ~60 s (twice), 2.8 s, 2.8 s, 0.16 s. Most updates are a screen change, but one
  is a byte-identical repeat of the previous frame 2.8 s later. A static
  screen otherwise produces a single update, so the projector clearly
  doesn't need a steady stream to keep showing an image.
- **JPEG details:** baseline (SOF0), JFIF, YCbCr 4:2:0 (luma 2×2, chroma
  1×1), standard Huffman tables. The quantisation tables match libjpeg
  quality ≈ 80. Tiles are 4.4–7.7 KB, so a full frame is ~18–24 KB.
- **Tight control byte** is always `0x90` (JPEG, no zlib stream reset
  bits).
- **What was on screen** (4 distinct frames in total):
  - The first update of every fresh session is the "Connected to
    iProjection." splash: black with an Epson logo. This is the repo's
    built-in test card.
  - In the first sessions of `Capture1` and `Capture2` the app sends a
    pure-black frame 3–6 s before it closes the session without a `0x04`
    (~60 s in). *Inferred:* the app blanks the screen as it's being
    backgrounded or closed.
  - `Capture2`'s second session goes splash → white (sent twice) → black
    with only the Epson logo in the bottom-right.
  - `Capture1` session 3 (the "resume" case, see the control doc)
    starts with the pure-black frame instead of the splash. The other
    stale-session reconnects start with the splash as usual.
- **Ordering:** the hello and first update are written together,
  immediately after `0x16` arrives on the control channel. In two
  sessions they hit the wire before the app's `0x27`.

## Closing

Neither side ever sends an EPRD message to close the stream. The sockets
just get closed:

- App disconnects cleanly: the app FINs both 3621 sockets first, then
  sends `0x04` on the control channel.
- Projector disconnects: the projector FINs both 3621 sockets in the same
  millisecond as it sends `0x07`.
- App vanishes: the app FINs everything. The projector leaves its side
  of the 3621 sockets open until the next session starts.

## Test content

`lib/client/frames.ts` provides two sources of frames, and
`connectToProjector()` (`lib/client/session.ts`) defaults to the first if
none is passed in:

- **Built-in test card** (default): `loadTestCard()`, backed by
  `lib/client/testcard/` — four JPEG tiles plus `index.json` describing
  each tile's `x/y/w/h`, captured from a real "Connected to iProjection."
  screen.
- **An arbitrary JPEG**: `loadJpegFrame(path)`, sent as one full-frame
  rect. Dimensions are read from the JPEG's own SOF marker
  (`lib/shared/eprd.ts` `jpegDimensions()`) rather than trusted from
  outside. The example `main.ts` wires this up behind
  `npm run dev:client -- [host] path/to/image.jpg`.

The default frame interval (500 ms, overridable via
`StreamOptions.frameIntervalMs` in `lib/client/session.ts`) is this repo's
own choice. The real app sends updates only when the screen changes (see
above). Repeating an unchanged frame every 500 ms is harmless but
unnecessary.

## Known unknowns

Tracked in [`reverse-engineering-todo.md`](./reverse-engineering-todo.md#video-stream-eprd0600).
In short: the second socket's purpose, the hello trailer, whether partial
updates or other encodings are accepted, and how the app streams moving
content (every capture shows a static screen).
