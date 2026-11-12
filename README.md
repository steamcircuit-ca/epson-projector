# epson-projector

An independent, open implementation of the wire protocol used by
iProjection-compatible Epson wireless projectors: a protocol spec, a
TypeScript client and projector simulator.

> **Not affiliated with Epson.** This is an independent project. It is
> not affiliated with, endorsed by, sponsored by or supported by Seiko
> Epson Corporation. See [Disclaimer](#disclaimer).

## Layout

| Path | What's there |
|---|---|
| [`docs/`](./docs/README.md) | The protocol spec. Start with [`docs/README.md`](./docs/README.md). The list of what's still unknown is in [`docs/reverse-engineering-todo.md`](./docs/reverse-engineering-todo.md). |
| [`lib/`](./lib/) | Reusable library: `client/` (act as the app), `simulator/` (act as a projector), `shared/` (framing and captured message templates). |
| [`main.ts`](./main.ts), [`config.ts`](./config.ts) | Example CLI wiring both sides of `lib/` together. Ports come from `.env`. |
| [`tools/`](./tools/) | Capture analysis, standard-library Python. `eemp_dump.py` lists every control message. `session_timeline.py` gives a timestamped timeline including video frames and TCP open/close. |

## Usage

```sh
npm install
npm run dev:simulator            # act as a projector (opens a live preview on :3630)
npm run dev:client [host] [jpeg] # act as the iProjection app
npm run typecheck

npm run dump -- captures/Capture4ClientDisconnects.pcapng --hide 0x0a
npm run dump -- captures/*.pcapng --summary
python3 tools/session_timeline.py captures/Capture1.pcapng --no-probes --hide 0x0a
```

With no host, the client broadcasts a discovery search and connects to the
first projector that answers. That can be the simulator running in another
terminal.

The raw packet captures the protocol was decoded from aren't published.
They contain device identifiers and unrelated network traffic, so
`captures/` is gitignored. Point the tools at captures of your own.

## Disclaimer

- **Trademarks.** Epson and iProjection are trademarks or registered
  trademarks of Seiko Epson Corporation. They're used here only to say
  what this software is designed to be compatible with. Their use doesn't
  imply any affiliation with or endorsement by Seiko Epson Corporation.
- **No Epson material.** This repository contains no Epson source code,
  firmware, images, logos or other Epson content. The protocol was worked
  out from network traffic between devices the author owns, for
  interoperability. All code, documentation and the test card image are
  original to this project.
- **Device identifiers** in the documentation (MAC addresses, projector
  names) are placeholders from the documentation-reserved ranges.
- **No warranty.** The protocol is undocumented and may change with any
  projector firmware update. Nothing here has been tested on a physical
  projector yet. The software is provided as is, without warranty of any
  kind. Use at your own risk.
