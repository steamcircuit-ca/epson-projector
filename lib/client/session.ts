// Client side of a projector session, following the real app's sequence as
// seen in the captures (docs/eemp-control-protocol.md § Session
// establishment, § Heartbeats, § Session teardown).
import { connect, Socket as TCPSocket } from "net";
import os from "os";
import { decodeDataBuffer, extractMessages, ipToBuffer } from "../shared/header";
import {
  ClientIdentity,
  DEFAULT_MAX_RECT,
  Fam0,
  Fam1,
  HEARTBEAT_INTERVAL_MS,
  ProjectorIdentity,
  Size,
  connectRequestPayload,
  eempMessage,
  layoutRequestPayload,
  searchPayload,
  streamStartedPayload,
} from "../shared/messages";
import { buildEprdHello, buildEprdUpdate, Rect } from "../shared/eprd";
import { EPRD_FRAMEBUFFER_HEIGHT, EPRD_FRAMEBUFFER_WIDTH } from "../shared/constants";
import { DEFAULT_PORTS } from "../shared/ports";
import { absorbReply, DiscoveredProjector } from "./discovery";

/** Read messages off a TCP socket, handling TCP's stream framing. */
function onMessages(socket: TCPSocket, handle: (message: Buffer) => void) {
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const { messages, rest } = extractMessages(pending);
    pending = rest;
    messages.forEach(handle);
  });
}

export type ProbeOptions = {
  clientIp: Buffer;
  mainPort?: number;
  timeoutMs?: number;
};

/**
 * Probe: TCP status 2. The projector answers [0x1a] + 0x03 identity + 0x15
 * capabilities, then we close.
 */
export function probeProjector(
  host: string,
  { clientIp, mainPort = DEFAULT_PORTS.main, timeoutMs = 3000 }: ProbeOptions
): Promise<DiscoveredProjector> {
  return new Promise((resolve, reject) => {
    const result: DiscoveredProjector = { host };
    const socket = connect(mainPort, host, () => {
      socket.write(eempMessage(clientIp, Fam0.probe, 0, searchPayload()));
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`probe of ${host} timed out`));
    }, timeoutMs);
    onMessages(socket, (message) => {
      absorbReply(result, message);
      if (result.identity && result.capabilities) {
        clearTimeout(timer);
        socket.end();
        resolve(result);
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export type ConnectOptions = {
  clientIp: Buffer;
  /** Name shown on the projector. Defaults to this machine's hostname. */
  clientName?: string;
  /** The projector's identity and capabilities, from discovery or a probe. */
  projector: DiscoveredProjector;
  mainPort?: number;
  imagePort?: number;
  /** Ask to resume a session the projector still holds for us. */
  resume?: boolean;
};

export type CloseReason = "client" | "projector" | "connection-lost";

export type ProjectorSession = {
  /** Framebuffer size the projector accepts (capabilities record 0x04). */
  framebuffer: Size;
  /** Largest single rect the projector accepts. Tile frames to fit. */
  maxRect: Size;
  /**
   * Send one frame. Like the real app, send only when the screen changes;
   * there's no need to repeat an unchanged frame. Frames sent before the
   * stream is up are queued (only the latest is kept).
   */
  sendFrame(rects: Rect[]): void;
  /** Clean disconnect: close video, send 0x04, wait for 0x05. */
  disconnect(): Promise<void>;
  /** Resolves when the session ends, with who ended it. */
  closed: Promise<CloseReason>;
};

/**
 * Open a session and resolve once the projector says to start streaming.
 *
 *   connect request → accept → layout request → 0x10 (open both video
 *   sockets) → 0x16 (send hello + first frame, then 0x27)
 */
export function connectToProjector(
  host: string,
  options: ConnectOptions
): Promise<ProjectorSession> {
  const { clientIp, mainPort = DEFAULT_PORTS.main, imagePort = DEFAULT_PORTS.image } = options;
  const client: ClientIdentity = {
    ip: clientIp,
    name: options.clientName ?? os.hostname().replace(/\.local$/, ""),
  };
  const caps = options.projector.capabilities ?? {};
  const framebuffer = caps.framebuffer ?? {
    width: EPRD_FRAMEBUFFER_WIDTH,
    height: EPRD_FRAMEBUFFER_HEIGHT,
  };
  const maxRect = caps.maxRect ?? DEFAULT_MAX_RECT;
  const identity = options.projector.identity;
  if (!identity) throw new Error("connectToProjector needs a probed/discovered projector");

  return new Promise((resolveReady, rejectReady) => {
    let video: TCPSocket[] = [];
    let streaming = false;
    let queued: Rect[] | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let closeReason: CloseReason = "connection-lost";
    let onDisconnectAck: (() => void) | undefined;
    let resolveClosed!: (r: CloseReason) => void;
    const closed = new Promise<CloseReason>((r) => (resolveClosed = r));

    const send = (status: number, family: 0 | 1, payload?: Buffer) =>
      main.write(eempMessage(clientIp, status, family, payload));

    const writeFrame = (rects: Rect[]) => {
      for (const r of rects) {
        if (r.w > maxRect.width || r.h > maxRect.height) {
          console.warn(
            `rect ${r.w}x${r.h} exceeds the projector's advertised max ` +
              `${maxRect.width}x${maxRect.height}; real hardware may reject it`
          );
        }
      }
      video[0]?.write(buildEprdUpdate(clientIp, rects));
    };

    const openVideo = () => {
      if (video.length) return;
      // The real app opens two connections; only the first carries data.
      video = [connect(imagePort, host), connect(imagePort, host)];
      for (const s of video) s.on("error", (err) => console.error("Video error:", err.message));
    };

    const session: ProjectorSession = {
      framebuffer,
      maxRect,
      closed,
      sendFrame(rects) {
        if (streaming) writeFrame(rects);
        else queued = rects;
      },
      disconnect() {
        return new Promise((resolve) => {
          closeReason = "client";
          for (const s of video) s.end();
          setTimeout(() => {
            if (main.destroyed) return resolve();
            send(Fam1.disconnect, 1);
            const timer = setTimeout(() => main.end(), 2000);
            onDisconnectAck = () => {
              clearTimeout(timer);
              main.end();
            };
          }, 300);
          closed.then(() => resolve());
        });
      },
    };

    const main = connect(mainPort, host, () => {
      const target: ProjectorIdentity = {
        mac: identity.mac,
        ip: ipToBuffer(main.remoteAddress ?? host),
        name: identity.name,
      };
      send(
        Fam1.connectRequest,
        1,
        connectRequestPayload(client, target, { screen: framebuffer, resume: options.resume })
      );
    });

    onMessages(main, (message) => {
      const { header } = decodeDataBuffer(message);
      const { family, status } = header;
      if (family === 1 && status === Fam1.connectAccept && !heartbeat) {
        send(Fam0.heartbeat, 0);
        heartbeat = setInterval(() => send(Fam0.heartbeat, 0), HEARTBEAT_INTERVAL_MS);
        send(Fam1.layoutRequest, 1, layoutRequestPayload(client));
      } else if (family === 1 && status === Fam1.staleSession) {
        console.log("Projector still had our previous session (0x17)");
      } else if (family === 1 && status === Fam1.openVideo) {
        openVideo();
      } else if (family === 0 && status === Fam0.startStream && !streaming) {
        openVideo(); // in case 0x10 never came
        streaming = true;
        video[0].write(buildEprdHello(clientIp, framebuffer));
        if (queued) writeFrame(queued);
        queued = undefined;
        send(Fam1.streamStarted, 1, streamStartedPayload());
        resolveReady(session);
      } else if (family === 1 && status === Fam1.disconnectAck) {
        onDisconnectAck?.();
      } else if (family === 1 && status === Fam1.disconnectedByProjector) {
        closeReason = "projector";
        for (const s of video) s.destroy();
        main.end();
      }
    });

    main.on("close", () => {
      if (heartbeat) clearInterval(heartbeat);
      for (const s of video) s.destroy();
      resolveClosed(closeReason);
      if (!streaming) rejectReady(new Error(`session closed before streaming (${closeReason})`));
    });
    main.on("error", (err) => {
      if (!streaming) rejectReady(err);
    });
  });
}
