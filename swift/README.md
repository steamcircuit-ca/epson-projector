# Epson Projector Client — Swift Implementation Guide

Everything you need to build the *client* side of Epson's wireless
"iProjection" protocol into an iOS app: connect to a projector on the local
network, negotiate a session, and push a video stream to it.

This folder is a Swift-flavored companion to [`../docs/`](../docs/README.md)
(the full protocol spec) and [`../lib/client/`](../lib/client/) (the
reference TypeScript implementation this was ported from). Where the two
disagree, trust this folder less than `docs/` — `docs/` is the byte-level
spec derived directly from packet captures; this folder is an
implementation guide for one specific client.

**Verification.** Every byte layout and code snippet here was compiled and
run for real during authoring: [`EpsonProjectorKit.swift`](./EpsonProjectorKit.swift)
was built standalone with `swiftc`, its pure functions were checked against
known-good values pulled directly from the TypeScript source and from real
JPEG files in this repo, and the *entire client flow* (probe → connect →
state exchange → start-stream signal → video stream) was run over real TCP
sockets against this repo's own projector simulator (`lib/simulator`) and
round-tripped correctly. It has **not** been run against physical projector
hardware — see [`../docs/README.md § Known gaps`](../docs/README.md#known-gaps)
for what's still unconfirmed about the protocol itself (session teardown,
one unknown UDP status code, the capabilities payload).

## Before testing on real hardware

This guide mirrors `lib/client`, which works against the simulator. A full
analysis of the captures
([`../docs/eemp-control-protocol.md`](../docs/eemp-control-protocol.md#what-lib-does-differently-from-the-real-app))
found that the real iProjection app behaves differently in ways a real
projector may care about:

- **It opens the video connection on `0x10`, not `0x16`.** It actually
  opens *two* TCP connections to 3621. The second never carries data and
  is probably reserved for audio. If a real projector waits for the video
  connection before sending `0x16`, a client following this guide would
  stall. Opening it on `0x10` is the safer choice.
- **Heartbeats every ~15 s**, not 3 s. The projector sends its own 15 s
  heartbeats too. They aren't replies to yours.
- **Clean disconnect:** close the 3621 sockets, send `0x04`/family 1
  (empty), and wait for `0x05`. Also handle `0x07`/family 1, which means
  the projector ended the session.
- **Frames:** the app always sends the 1280×800 screen as the same four
  JPEG tiles (656/624 × 416/384), and only when the screen changes.
  656×416 is the largest rect the projector advertises, so a single
  full-screen rect may be rejected.

## Documents

| File | Covers |
|---|---|
| [`EpsonProjectorKit.swift`](./EpsonProjectorKit.swift) | Drop-in codec: header pack/unpack, message templates, video/JPEG framing, IP helpers. No networking code — transport-agnostic on purpose. |
| [`01-wire-format.md`](./01-wire-format.md) | The 20-byte header, endianness rules, and how to reassemble messages out of a TCP byte stream. |
| [`02-control-channel.md`](./02-control-channel.md) | Full client-side flow on port 3620: probe, connect, session, keepalive. Exact bytes, exact order. |
| [`03-video-channel.md`](./03-video-channel.md) | The video stream on port 3621: hello message, JPEG framebuffer updates. |

## The shape of the client

Two TCP connections, in sequence, to the same host:

1. **Control connection**, port 3620 — send a connect request, exchange a
   few setup messages, then sit idle sending a keepalive every ~3 seconds
   until the projector signals "start streaming."
2. **Video connection**, port 3621 — opened only after that signal. One
   hello message, then a JPEG frame pushed repeatedly. This connection is
   push-only: the projector never sends anything back on it.

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
and two of the session templates have the original capture's client IP
baked in that needs patching to your device's real IP before sending — see
`EpsonNetworking.currentWiFiIPv4Address()` in
[`EpsonProjectorKit.swift`](./EpsonProjectorKit.swift), which wraps the
standard (if verbose) `getifaddrs`/`en0` C-interop dance. This part *was*
compiled and run for real during authoring — it correctly found this
machine's real Wi-Fi IP.

## Suggested build order

1. Get `EpsonProjectorKit.swift` into your project as-is.
2. Wire up `NWConnection` to port 3620, hardcode a target IP (skip
   discovery for now), and get through probe → connect → session per
   [02-control-channel.md](./02-control-channel.md) — log every message
   status/family you receive so you can see the state machine advance.
3. Once you see the `0x16`/family-0 "start streaming" signal, open the
   video connection and stream one static JPEG per
   [03-video-channel.md](./03-video-channel.md) — confirm the projector
   actually shows it before building a live capture pipeline.
4. Add discovery and/or a manual host-entry UI on top.

You can validate steps 2–3 against this repo's own simulator before ever
touching real hardware: `npm run dev:simulator` in the repo root, then
point your app at your Mac's LAN IP on port 3620/3621 (the simulator
prints a live preview at `http://localhost:3630` so you can see exactly
what it received).
