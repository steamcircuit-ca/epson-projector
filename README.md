# epson-projector

Reverse-engineered wire protocol for Epson's **iProjection** wireless
projectors, plus a TypeScript client and projector simulator that speak it.

## Layout

| Path | What's there |
|---|---|
| [`docs/`](./docs/README.md) | The protocol spec. Start with [`docs/README.md`](./docs/README.md). The list of what's still unknown is in [`docs/reverse-engineering-todo.md`](./docs/reverse-engineering-todo.md). |
| [`lib/`](./lib/) | Reusable library: `client/` (act as the app), `simulator/` (act as a projector), `shared/` (framing and captured message templates). |
| [`main.ts`](./main.ts), [`config.ts`](./config.ts) | Example CLI wiring both sides of `lib/` together. Ports come from `.env`. |
| [`swift/`](./swift/README.md) | Implementation guide and a drop-in codec for a native iOS client. |
| [`captures/`](./captures/) | Raw `.pcapng` captures of the real app talking to a real projector. The source of truth for everything above. |
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
