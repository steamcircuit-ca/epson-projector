# Epson Projector Client — Swift Implementation Guide

> Independent work, not affiliated with or endorsed by Seiko Epson
> Corporation. Epson and iProjection are trademarks of Seiko Epson
> Corporation, used here only to describe compatibility. See the
> [root README's disclaimer](../README.md#disclaimer).

Everything you need to build the *client* side of Epson's wireless
"iProjection" protocol into an iOS app: connect to a projector on the local
network, negotiate a session, and push a video stream to it.

This folder is a Swift-flavored companion to [`../docs/`](../docs/README.md)
(the full protocol spec) and [`../lib/client/`](../lib/client/) (the
reference TypeScript implementation this was ported from). Where the two
disagree, trust this folder less than `docs/` — `docs/` is the byte-level
spec derived directly from packet captures; this folder is an
implementation guide for one specific client.

**Verification.** [`EpsonProjectorKit.swift`](./EpsonProjectorKit.swift)
builds every payload field by field. It's a port of
`lib/shared/messages.ts` (and the EPRD hello from `lib/shared/eprd.ts`),
whose builders reproduce every message in the original captures
byte-for-byte given the same field values. The Swift builders were
compiled with `swiftc` and checked byte-for-byte against the TypeScript
builders' output for a set of placeholder identities, and its parsers were
round-tripped. The flow in this guide follows the real iProjection app as
documented in
[`../docs/eemp-control-protocol.md`](../docs/eemp-control-protocol.md#session-establishment).
It has **not** been run against physical projector hardware — see
[`../docs/README.md § Known gaps`](../docs/README.md#known-gaps) for
what's still unconfirmed about the protocol itself.

## Before testing on real hardware

The guide follows the real app's behaviour as seen in the captures
(video on `0x10` with two sockets, 15 s heartbeats, optional `0x27`,
`0x04` → `0x05` teardown, handling `0x07`, tiled frames). What's still
untested or unknown:

- **Nothing here has run against a real projector.** The behaviour comes
  from captures of one projector model; a second model's capabilities
  differ (see `parseCapabilities`).
- **Unknown bytes are copied, not understood.** A few connect-request
  fields (an apparent app version and netmask at offsets 12–23 and 44)
  and several capabilities records are sent as captured constants.
- **Resume / multi-user** paths (`0x0f`, more than one device on screen)
  aren't covered. See
  [`../docs/reverse-engineering-todo.md`](../docs/reverse-engineering-todo.md).

## Documents

| File | Covers |
|---|---|
| [`EpsonProjectorKit.swift`](./EpsonProjectorKit.swift) | Drop-in codec: header pack/unpack, field-by-field payload builders and parsers, video/JPEG framing, IP helpers. No networking code — transport-agnostic on purpose. |
| [`01-wire-format.md`](./01-wire-format.md) | The 20-byte header, endianness rules, payload/TLV layout, and how to reassemble messages out of a TCP byte stream. |
| [`02-control-channel.md`](./02-control-channel.md) | Full client-side flow on port 3620: probe, connect, layout, heartbeats, teardown. Exact order. |
| [`03-video-channel.md`](./03-video-channel.md) | The video stream on port 3621: hello message, JPEG framebuffer updates, tiling. |

## The shape of the client

Three TCP connections to the same host:

1. **Control connection**, port 3620 — send a connect request, ask to be
   put on screen, and send a heartbeat every 15 seconds for as long as
   the session lasts. The projector tells you when to open video (`0x10`)
   and when to start streaming (`0x16`). Disconnect with `0x04` and wait
   for `0x05`; the projector may also end the session with `0x07`.
2. **Video connections**, port 3621 — two of them, opened on `0x10`. On
   `0x16` the first gets one hello message and then a JPEG frame
   (as four tiles) whenever the screen changes. The second stays open but
   idle, like the real app's. Both are push-only: the projector never
   sends anything back on them.

(There's also a UDP discovery step and a pre-connect TCP probe that happen
*before* all this — both optional in practice, see
[02-control-channel.md](./02-control-channel.md#1-discovery-optional).)

## iOS-specific setup (read this before writing networking code)

### 1. Local Network permission — the #1 thing that will bite you

As of iOS 14, **any** connection to another device on the local network —
not just Bonjour/mDNS, a plain TCP connect to a LAN IP counts too —
triggers Apple's "local network" privacy system. Miss this and every
connection attempt will silently hang or fail with no useful error.

Add to `Info.plist`:

```xml
<key>NSLocalNetworkUsageDescription</key>
<string>Connects to the projector on your local network to display your screen.</string>
```

The system permission prompt ("*App* would like to find and connect to
devices on your local network") fires the first time you actually open a
socket to a LAN address — there's no API to trigger it proactively, and no
way to check the permission's state ahead of time. Just attempt the
connection and handle timeout/failure gracefully (e.g. "couldn't reach the
projector — check that Local Network access is allowed for this app in
Settings").

You do **not** need `NSBonjourServices` — that key is only for
mDNS/Bonjour-based discovery, and this protocol has its own discovery
mechanism (a raw UDP broadcast) that doesn't touch Bonjour at all. And
since this is raw TCP/UDP sockets, not HTTP(S), App Transport Security
(`NSAppTransportSecurity`) doesn't apply here — that only governs
`URLSession`/`WebKit` requests.

### 2. Recommended networking API: `Network.framework`

Use `NWConnection` (from `Network`, not `Foundation.URLSession` or raw BSD
sockets) for both TCP connections. It handles the Local Network permission
flow correctly, gives you clean async receive/send, and is the modern,
supported way to do this on iOS. Sketch:

```swift
import Network

let params = NWParameters.tcp
let connection = NWConnection(host: "192.168.1.50", port: 3620, using: params)
connection.stateUpdateHandler = { state in
    switch state {
    case .ready: /* send the first message */ break
    case .failed(let error): /* surface to the user */ break
    default: break
    }
}
connection.start(queue: .main)
```

Receive in a loop, accumulating bytes and pulling complete messages out
with `EpsonWire.extractMessages` (see [01-wire-format.md](./01-wire-format.md#reassembling-messages-from-a-tcp-stream)
for exactly why a single `receive` call is never guaranteed to be one
message):

```swift
func receiveLoop() {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
        if let data { self.pending.append(contentsOf: data) }
        let (messages, rest) = EpsonWire.extractMessages(self.pending)
        self.pending = rest
        for message in messages { self.handle(message) }
        if error == nil && !isComplete { self.receiveLoop() }
    }
}
```

This project's own validation harness used raw BSD sockets (simpler to
script for a one-off test), but `NWConnection` is what a real app should
use — it's the one thing in this guide that wasn't exercised through
`NWConnection` specifically, so budget some time to confirm its broadcast
UDP behavior for discovery (next section) works the way you expect on the
iOS versions you target.

### 3. Discovery is optional — consider skipping it

The protocol has a UDP broadcast discovery step (see
[02-control-channel.md](./02-control-channel.md#1-discovery-optional)), but
it's genuinely optional: everything downstream just needs a host IP. For a
v1, consider skipping discovery entirely and letting the user type in or
select the projector's IP address (many AV-control apps do exactly this).
That sidesteps two iOS-specific headaches:

- UDP broadcast (`255.255.255.255` or the subnet broadcast address) via
  `NWConnection` has had inconsistent behavior across iOS versions in
  various developers' reports — test it specifically on your target OS
  versions before relying on it, or fall back to raw BSD sockets
  (`SO_BROADCAST`) for just this one step if `NWConnection` gives you
  trouble.
- Discovery replies must arrive on a *fixed* local UDP port (3620, not an
  ephemeral one) — see [02-control-channel.md](./02-control-channel.md#1-discovery-optional)
  for why, and note that binding to a specific local port is more friction
  with `NWListener`/`NWConnection` than just connecting out.

Everything after discovery (probe, connect, session, video) is plain
point-to-point TCP, which `NWConnection` handles cleanly with no surprises.

### 4. Your device's own IP address

The wire header embeds the client's own IP in *every* message you send,
and the connect and layout requests carry it again inside the payload, as
part of your `ClientIdentity`:

```swift
let ipString = EpsonNetworking.currentWiFiIPv4Address()!          // e.g. "192.168.1.10"
let client = ClientIdentity(ip: EpsonNetworking.ipv4StringToBytes(ipString)!, name: "Test iPad")
```

`EpsonNetworking.currentWiFiIPv4Address()` in
[`EpsonProjectorKit.swift`](./EpsonProjectorKit.swift) wraps the standard
(if verbose) `getifaddrs`/`en0` C-interop dance. The `name` is what the
projector displays for your device (use the device name, or let the user
choose).

## Suggested build order

1. Get `EpsonProjectorKit.swift` into your project as-is.
2. Wire up `NWConnection` to port 3620, hardcode a target IP (skip
   discovery for now), and get through probe → connect → layout request
   per [02-control-channel.md](./02-control-channel.md) — log every
   message status/family you receive so you can see the state machine
   advance.
3. Open the two video connections on `0x10`, and on `0x16` send the hello
   and one static frame (as four tiles) per
   [03-video-channel.md](./03-video-channel.md) — confirm the projector
   actually shows it before building a live capture pipeline.
4. Add clean teardown (`0x04` → `0x05`) and handle `0x07`.
5. Add discovery and/or a manual host-entry UI on top.

You can validate steps 2–3 against this repo's own simulator before ever
touching real hardware: `npm run dev:simulator` in the repo root, then
point your app at your Mac's LAN IP on port 3620/3621 (the simulator
prints a live preview at `http://localhost:3630` so you can see exactly
what it received).
