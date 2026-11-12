# Still to reverse-engineer

What's still unknown about the protocol after a full pass over all five
captures, roughly in order of how much it matters for a working client.
Everything the captures *could* answer is now in
[`eemp-control-protocol.md`](./eemp-control-protocol.md) and
[`eprd-video-protocol.md`](./eprd-video-protocol.md). What's left here
either needs new captures (*needs capture*), real hardware
(*needs hardware*), or more decoding work on bytes already captured
(*decodable*).

Reproduce any capture observation with:

```sh
python3 tools/eemp_dump.py captures/<file>.pcapng --hide 0x0a
python3 tools/session_timeline.py captures/<file>.pcapng
```

## Resolved from the captures

For reference, these were open before and are now documented:

| Was open | Now | Where |
|---|---|---|
| Session teardown | `0x04` → `0x05`, or `0x07`, plus socket ordering | [control § Session teardown](./eemp-control-protocol.md#session-teardown) |
| "In use" probe replies (`0x1a`, 176-byte identity) | Decoded; tied to session state | [control § Identity reply](./eemp-control-protocol.md#identity-reply-0x03) |
| `0x0e`/`0x08`/`0x09` contents | User/panel layout model, projector-wide state version | [control § Session state](./eemp-control-protocol.md#session-state-the-userpanel-model) |
| Payload framing | 48/74-byte prefix, "body follows" flag, TLV body | [control § Payload layout](./eemp-control-protocol.md#payload-layout) |
| Keepalive | Two independent 15 s heartbeats, not request/reply | [control § Heartbeats](./eemp-control-protocol.md#heartbeats) |
| `0x10` | Signal to open the video sockets | [control § Session establishment](./eemp-control-protocol.md#session-establishment) |
| Is `0x27` needed? | No (one session never sent it) | same |
| Frame cadence, dirty rects | Sparse updates, always the full fixed 4-tile grid | [video § What the app actually sends](./eprd-video-protocol.md#what-the-app-actually-sends) |
| Most of the capabilities blob | Record framing; model, resolution, encoding table, max rect | [control § Capabilities reply](./eemp-control-protocol.md#capabilities-reply-0x15) |
| Connect request prefix | Screen size, RFB pixel format, target MAC/IP | [control § Connect request](./eemp-control-protocol.md#connect-request-0x01fam-1) |
| UDP status 4 | Never exists in the captures | — |

---

## 1. Does the projector wait for the video sockets? (*needs hardware*)

The app opens both 3621 connections on `0x10`. The projector sends `0x16`
39–143 ms later. If the projector waits for those connections before
sending `0x16`, then `lib/client` (which connects on `0x16`) and the Swift
guide will **hang against real hardware**. The quickest test is to change
`lib/client` to connect on `0x10` and see whether anything else breaks.
Doing that is cheap insurance even before testing.

## 2. The second 3621 socket (*needs capture* + *needs hardware*)

It's always opened and always idle. Open questions:
- Is it audio? A capture of the app sharing a video with sound would
  settle this.
- What format does it use (EPRD framing? raw PCM at 44.1 kHz, which the
  projector heartbeat announces)?
- Does the projector refuse the session if only one socket is opened, as
  `lib/client` does?

## 3. Reconnect / resume (*decodable*, but only one sample)

`0x17` (tag `0x25` = 1) is clearly a "stale session" notice. The rest
comes from a single session:
- Client `0x0f`.
- `0x0c` = 1 in the connect request.
- No `0x27`.
- A black first frame instead of the splash.

More captures of the app reconnecting after a network drop would confirm
or kill the "resume" reading.

## 4. Remaining field meanings (*decodable*)

| Where | Field | Seen values |
|---|---|---|
| User entry | tag `0x0b` bit 0 (`0x101` vs `0x100` on-screen entries) | both, client-chosen, echoed |
| Connect req/accept, identity | tag `0x0d` | always 1 |
| Connect request | tags `0x26` (8 zero bytes), `0x2e` (0), `0x30` (`06 00 00 00 "405"`) | one value each |
| Connect accept | tag `0x1e` (empty) | — |
| Connect request prefix | offsets 12–23 (netmask? app version `03 0f 02 00`?), 44–45 (`01 0c`) | one value |
| Identity prefix | offsets 36–42 beyond the in-use bits | — |
| `0x05` / `0x07` | `@4 = 1`; `@8` = 1 or 2 (reason code?) | one sample each |
| `0x16` / `0x27` | `@8 = 1` / `@4 = 3` | constant |
| Capabilities | records `0x07`, `0x08`, `0x0a`, the four `0x05` entry sub-ids (`09`, `0b`, `0d`, `00`), and the last 30 bytes | two projectors' worth |
| EPRD hello | trailer (two `w, h, 0, 0` groups) | constant |

A second app (different device name, screen size or OS) connecting to the
same projector would decode most of the connect-request unknowns
immediately.

## 5. Timeouts (*needs hardware*)

The captures show the 15 s heartbeat intervals, but not how long either
side waits before dropping a silent peer. Also unknown: how long the
projector keeps a stale session (with half-open 3621 sockets) after the
app vanishes. In the captures that state lasted 19–26 s, until the
next connect replaced it.

## 6. Video limits (*needs hardware*)

- Does the projector accept partial updates (fewer than 4 tiles, other
  rect sizes)? The app never sends them, but they'd save bandwidth.
  `lib/client`'s `loadJpegFrame()` sends the whole image as one rect,
  for example 1280×800. That's *larger* than the advertised 656×416
  maximum and may be rejected by real hardware.
- Other encodings: the capabilities table lists four entries, but only
  Tight/JPEG `0x90` is ever used.
- Moving content: every capture shows a static screen. A capture of
  video playback would show the real frame rate and whether the app ever
  uses dirty rects.

## 7. Features never captured (*needs capture*)

- **Projector keyword / PIN.** The 4-digit code shown on screen. Is it
  tag `0x30` (`"405"`)? A capture with the keyword enabled would tell.
- **Error responses:** wrong keyword, projector full, refused.
- **Multi-user:** a second app connecting while one is on screen,
  split-screen layouts (lists `0x07`/`0x08` with more than one user),
  moderator handover, and the 50-user limit.
- **Pause / freeze / A/V mute** from the app.
- **Other projector models and resolutions.** A WUXGA unit would exercise
  the capabilities differences already seen in
  [`second-projector-samples.md`](./second-projector-samples.md).

## 8. Hardware validation (*needs hardware*)

`lib/client` and `swift/EpsonProjectorKit.swift` have only been run
against this repo's simulator. The differences from the real app most
likely to matter are listed in
[control § What `lib/` does differently](./eemp-control-protocol.md#what-lib-does-differently-from-the-real-app).

## Video stream (EPRD0600)

The video-specific open items are §2 and §6 above.
