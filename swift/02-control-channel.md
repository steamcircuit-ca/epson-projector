# Control Channel (`EEMP0100`, TCP/UDP port 3620)

The full client-side sequence: optional discovery, a probe, then the
session that stays open for as long as you're connected to the projector.
Every message builder referenced here is in `EpsonClientMessages` in
[`EpsonProjectorKit.swift`](./EpsonProjectorKit.swift). The payloads under
them are built field by field by `EempPayloads` from your
`ClientIdentity` and the projector's `ProjectorIdentity`.

## Identities

Two values feed every session message:

```swift
// You. `name` is what the projector shows for your device (sent as UTF-16LE).
let client = ClientIdentity(ip: [192, 168, 1, 10], name: "Test iPad")

// The projector, from its identity reply (status 3) to your probe or search.
// The reply carries name and MAC; the IP is the address it came from.
let target = EempPayloads.parseIdentity(identityPayload)!.projector(ip: [192, 168, 1, 20])
// → ProjectorIdentity(mac: 00:00:5e:00:53:01, ip: 192.168.1.20, name: "EB005301")
```

The connect request names the projector it's addressed to (MAC, IP and
name), so probe first and keep the parsed identity. The capabilities reply
(status `0x15`) is worth keeping too:
`EempPayloads.parseCapabilities(_:)` gives you the framebuffer size to
declare in the EPRD hello and the largest rect the projector accepts (see
[03-video-channel.md](./03-video-channel.md)).

## Message catalog

Every `(family, status)` pair the client needs to send or recognize.
"Builder" is the `EpsonClientMessages` function that produces it;
"constant" is the named status in `EempFamily0Status` / `EempFamily1Status`.

| Family | Status | Direction | Meaning | Builder / constant |
|---|---|---|---|---|
| 0 | `0x01` | you → broadcast (UDP) | Discovery search | `EpsonClientMessages.search(clientIP:)` |
| 0 | `0x02` | you → projector | Probe | `EpsonClientMessages.probe(clientIP:)` |
| 1 | `0x1a` | projector → you | "In use" notice, just before an in-use identity | `EempFamily1Status.inUse` — ignore |
| 0 | `0x03` | projector → you | Identity reply (name, MAC, in use?) | `EempFamily0Status.identity`, parse with `EempPayloads.parseIdentity` |
| 0 | `0x15` | projector → you | Capabilities reply | `EempFamily0Status.capabilities`, parse with `EempPayloads.parseCapabilities` |
| 1 | `0x01` | you → projector | Connect request | `EpsonClientMessages.connectRequest(client:target:)` |
| 1 | `0x02` | projector → you | Connect accept | `EempFamily1Status.connectAccept` |
| 1 | `0x0e` | projector → you | State broadcast (who's on screen) | `EempFamily1Status.stateBroadcast` — log and ignore |
| 1 | `0x17` | projector → you | Stale-session notice (it still had your last session) | `EempFamily1Status.staleSession` — log and ignore |
| 1 | `0x08` | you → projector | Layout request: "put me on screen" | `EpsonClientMessages.layoutRequest(client:)` |
| 1 | `0x09` | projector → you | Layout accepted | `EempFamily1Status.layoutAccepted` — log and ignore |
| 1 | `0x10` | projector → you | **Open video channel** — connect to 3621 now | `EempFamily1Status.openVideo` |
| 0 | `0x16` | projector → you | **Start streaming** — send hello + first frame | `EempFamily0Status.startStream` |
| 1 | `0x27` | you → projector | Streaming started (optional) | `EpsonClientMessages.streamStarted(clientIP:)` |
| 0 | `0x0a` | you → projector | Heartbeat (empty payload), every 15 s | `EpsonClientMessages.heartbeat(clientIP:)` |
| 0 | `0x0a` | projector → you | Projector's own heartbeat (48 bytes) | `EempFamily0Status.heartbeat` — no action |
| 1 | `0x04` | you → projector | Disconnect request (empty) | `EpsonClientMessages.disconnect(clientIP:)` |
| 1 | `0x05` | projector → you | Disconnect ack | `EempFamily1Status.disconnectAck` |
| 1 | `0x07` | projector → you | **Disconnected by projector** — session over | `EempFamily1Status.disconnectedByProjector` |

Full byte-level detail and provenance for each of these is in
[`../docs/eemp-control-protocol.md`](../docs/eemp-control-protocol.md) —
this table is the subset your client actually needs to act on.
`EempPayloads` also has builders for the projector-side payloads
(`connectAcceptPayload`, `stateBroadcastPayload`, `projectorHeartbeatPayload`
and so on) if you want to unit-test your handler without a projector.

## Sequence

This is the order the real iProjection app follows (see
[`../docs/eemp-control-protocol.md § Session establishment`](../docs/eemp-control-protocol.md#session-establishment)).

```mermaid
sequenceDiagram
    participant You as Your app
    participant P as Projector

    rect rgb(30, 41, 59)
    note over You,P: Probe — TCP 3620, connect then close
    You->>P: connect
    You->>P: 0x02/0 probe
    P-->>You: [0x1a/1 if in use] 0x03/0 identity
    P-->>You: 0x15/0 capabilities
    You->>P: close
    end

    rect rgb(30, 41, 59)
    note over You,P: Session — new TCP 3620 connection, stays open
    You->>P: connect
    You->>P: 0x01/1 connect request
    P-->>You: 0x02/1 connect accept
    P-->>You: 0x0e/1 state broadcast ×2 (ignore)
    You->>P: 0x0a/0 heartbeat (first; then every 15 s)
    P-->>You: 0x0a/0 heartbeat reply (ignore)
    You->>P: 0x08/1 layout request
    P-->>You: 0x09/1 layout accepted (ignore)
    P-->>You: 0x0e/1 state broadcast (ignore)
    P-->>You: 0x10/1 OPEN VIDEO
    Note over You: open TWO TCP connections to 3621 now
    P-->>You: 0x16/0 START STREAMING
    Note over You: on 3621: hello + first frame — see 03-video-channel.md
    You->>P: 0x27/1 streaming started (optional)
    end

    rect rgb(30, 41, 59)
    note over You,P: Teardown (yours)
    Note over You: close both 3621 connections
    You->>P: 0x04/1 disconnect
    P-->>You: 0x05/1 disconnect ack
    P-->>You: closes 3620
    end
```

## Step by step

### 1. Discovery (optional)

See [`README.md § Discovery is optional`](./README.md#3-discovery-is-optional--consider-skipping-it)
for why you might skip this entirely for a v1. If you do implement it:

- Broadcast `EpsonClientMessages.search(clientIP:)` over UDP to the LAN
  broadcast address (e.g. `192.168.1.255` for a `/24` — `EpsonNetworking.broadcastAddress(forIPv4:)`
  computes this from your device's own IP) on port 3620.
- **Bind your local UDP socket to port 3620 itself**, not an ephemeral
  port. The projector replies to the fixed discovery port, not to
  whatever source port your search datagram came from — a client
  listening on an ephemeral port will never see the replies. (Confirmed
  from the real capture; this is exactly the bug an early version of the
  Node reference implementation in this repo had.)
- Collect replies for a few seconds. Each responding projector sends
  status 3 (identity) then status `0x15` (capabilities), unicast, each one
  **twice** (de-duplicate), and from ephemeral ports. A projector that's
  already in use sends a `0x1a` notice first and the longer "in use"
  identity form; `parseIdentity` handles both and sets `inUse`. The
  sender's IP address is the projector's host.

### 2. Probe (TCP)

Open a plain TCP connection to the projector's IP on port 3620:

```swift
connection.send(content: Data(EpsonClientMessages.probe(clientIP: client.ip)), completion: .contentProcessed { _ in })
```

Wait for status 3 then status `0x15` back (the same identity/capabilities
pair as discovery, just over TCP, possibly preceded by `0x1a`), parse them,
then close this connection. You need the identity for the connect request
in the next step.

### 3. Session (new TCP connection)

Open a **second, new** TCP connection to the same host:port — the probe
connection must already be closed. Send the connect request:

```swift
connection.send(content: Data(EpsonClientMessages.connectRequest(client: client, target: target)), completion: .contentProcessed { _ in })
```

It declares your screen size (default 1280×800; pass `screen:` to change
it) and the projector you're addressing. There's no IP patching involved:
every address and name in the payload comes from `client` and `target`.

Then, dispatching on each incoming message's `(family, status)`:

- On **`0x02` / family 1** (connect accept): send one heartbeat
  (`EpsonClientMessages.heartbeat(clientIP:)`) and **start a repeating
  15-second timer** (`EpsonClientMessages.heartbeatInterval`) that keeps
  sending it, then send the layout request
  (`EpsonClientMessages.layoutRequest(client:)`). The heartbeat timer runs
  for the rest of the session, independently of everything else.
- On **`0x0e`**, **`0x09`** and **`0x17`** (family 1): nothing to do, just
  don't treat them as errors. `0x17` means the projector still held your
  previous session; it carries on normally.
- On **`0x10` / family 1** ("open video channel"): open **two** TCP
  connections to port 3621. The first carries the video stream. The
  second never carries data in the captures, but the real app keeps it
  open for the whole session (probably reserved for audio), so do the
  same. Don't send anything on them yet. The projector appears to wait for
  these connections before it sends `0x16`.
- On **`0x16` / family 0** ("start streaming"): on the first video
  connection send the EPRD hello and your first frame (see
  [03-video-channel.md](./03-video-channel.md)), then send
  `EpsonClientMessages.streamStarted(clientIP:)`. The `0x27` is optional:
  the real app sometimes sends it after its first video bytes, and once
  skipped it entirely. If `0x10` never arrived, open the video connections
  now.
- On **`0x07` / family 1** ("disconnected by projector"): the session is
  over. The projector has already closed 3620 and both 3621 connections.
  Stop your timers and close everything on your side. Don't reply.
- On **`0x05` / family 1** ("disconnect ack"): see teardown below.

### 4. Heartbeats

Every 15 seconds, send `EpsonClientMessages.heartbeat(clientIP:)` — a
message with an **empty** payload (not the 48-zero-byte payload used by
search/probe; easy to mix up, they're different).

These aren't request/response. The projector answers your *first*
heartbeat immediately, then runs its own independent 15-second timer and
sends a 48-byte `0x0a` (with 44100, an audio sample rate, at offset 8)
whenever it fires. No action is needed on yours beyond noting the
connection is alive. Details:
[`../docs/eemp-control-protocol.md § Heartbeats`](../docs/eemp-control-protocol.md#heartbeats).

### 5. Teardown

To disconnect cleanly, the way the real app does:

1. Close both 3621 connections.
2. About 300 ms later, send `EpsonClientMessages.disconnect(clientIP:)`
   (`0x04`/family 1, empty).
3. Wait for `0x05`/family 1. The projector closes 3620 right after
   sending it; close your side too. Use a timeout (a couple of seconds) in
   case it never comes.

If you just drop the sockets without `0x04`, the projector keeps
reporting "in use" and holds your session until the next connection, which
then gets the stale-session `0x17`. It works, but it's untidy.

If the projector ends the session (`0x07`), it closes everything itself;
see above. Details:
[`../docs/eemp-control-protocol.md § Session teardown`](../docs/eemp-control-protocol.md#session-teardown).

## Complete worked example

```swift
import Foundation
import Network

final class ProjectorSession {
    private var connection: NWConnection?
    private var videoConnections: [NWConnection] = []
    private var pending: [UInt8] = []
    private var heartbeatTimer: Timer?
    private var disconnectTimeout: Timer?
    private let client: ClientIdentity
    private let target: ProjectorIdentity
    /// Called on 0x16 with the video connection to send the hello and first frame on.
    private var onStartStreaming: ((NWConnection) -> Void)?
    private var onEnded: (() -> Void)?

    init(client: ClientIdentity, target: ProjectorIdentity) {
        self.client = client
        self.target = target
    }

    private var host: NWEndpoint.Host {
        NWEndpoint.Host(target.ip.map(String.init).joined(separator: "."))
    }

    func connect(onStartStreaming: @escaping (NWConnection) -> Void, onEnded: @escaping () -> Void) {
        self.onStartStreaming = onStartStreaming
        self.onEnded = onEnded
        let conn = NWConnection(host: host, port: 3620, using: .tcp)
        connection = conn
        conn.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            if case .ready = state { self.send(EpsonClientMessages.connectRequest(client: self.client, target: self.target)) }
        }
        conn.start(queue: .main)
        receiveLoop()
    }

    private func send(_ bytes: [UInt8]) {
        connection?.send(content: Data(bytes), completion: .contentProcessed { _ in })
    }

    private func receiveLoop() {
        connection?.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data { self.pending.append(contentsOf: data) }
            let (messages, rest) = EpsonWire.extractMessages(self.pending)
            self.pending = rest
            for message in messages { self.handle(message) }
            if error == nil && !isComplete { self.receiveLoop() } else { self.ended() }
        }
    }

    private func handle(_ message: [UInt8]) {
        guard let header = EpsonWire.decodeHeader(message) else { return }

        switch (header.family, header.status) {
        case (1, EempFamily1Status.connectAccept):
            send(EpsonClientMessages.heartbeat(clientIP: client.ip))
            startHeartbeat()
            send(EpsonClientMessages.layoutRequest(client: client))
        case (1, EempFamily1Status.openVideo):
            openVideo()
        case (0, EempFamily0Status.startStream):
            openVideo() // in case 0x10 never came
            onStartStreaming?(videoConnections[0]) // hello + first frame
            send(EpsonClientMessages.streamStarted(clientIP: client.ip))
        case (1, EempFamily1Status.disconnectAck):
            ended()
        case (1, EempFamily1Status.disconnectedByProjector):
            ended()
        default:
            break // 0x0e, 0x09, 0x17, projector heartbeats — nothing to do
        }
    }

    private func openVideo() {
        guard videoConnections.isEmpty else { return }
        // Two connections, like the real app. Only the first carries data.
        videoConnections = (0..<2).map { _ in NWConnection(host: host, port: 3621, using: .tcp) }
        for conn in videoConnections { conn.start(queue: .main) }
    }

    private func startHeartbeat() {
        heartbeatTimer?.invalidate()
        heartbeatTimer = Timer.scheduledTimer(withTimeInterval: EpsonClientMessages.heartbeatInterval, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.send(EpsonClientMessages.heartbeat(clientIP: self.client.ip))
        }
    }

    /// Clean disconnect: close video, send 0x04, wait for 0x05.
    func disconnect() {
        videoConnections.forEach { $0.cancel() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self else { return }
            self.send(EpsonClientMessages.disconnect(clientIP: self.client.ip))
            self.disconnectTimeout = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in self?.ended() }
        }
    }

    private func ended() {
        heartbeatTimer?.invalidate()
        disconnectTimeout?.invalidate()
        videoConnections.forEach { $0.cancel() }
        videoConnections = []
        connection?.cancel()
        connection = nil
        onEnded?()
        onEnded = nil
    }
}
```

This mirrors `connectToProjector()` in [`../lib/client/session.ts`](../lib/client/session.ts)
closely — useful to cross-reference if anything here is unclear. It follows
the same real-app sequence described above.
